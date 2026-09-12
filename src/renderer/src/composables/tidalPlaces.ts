import { parseTextAddress, type TextAddress, type TextDocumentVersion } from './textAddress'

export const TIDAL_BOOK_LIMIT = 12
const SHELF_LIMIT = 350000
export interface TidalPlace {
  address: TextAddress
  title: string
  position: number
  at: number
  visits: number
  echo?: EchoPlaceDetails
}
export interface EchoPlaceDetails {
  dwellMs: number
  peakMs: number
  textShare: number
  switches: number
  reversals: number
}
export interface TidalBookPlaces {
  key: string
  at: number
  places: TidalPlace[]
}
export function tidalBookKey(version: TextDocumentVersion): string {
  return JSON.stringify([
    version.hash,
    version.projection,
    version.path,
    version.length,
    version.digest
  ])
}
export function tidalPlaceKey(place: TidalPlace): string {
  const address = place.address,
    origin = address.origin
  return JSON.stringify([
    tidalBookKey(address.version),
    origin.kind,
    origin.kind === 'section' ? origin.sectionId : origin.label,
    address.blockIndex,
    address.match.start,
    address.match.end
  ])
}
export function appendTidalPlace(places: TidalPlace[], next: TidalPlace): TidalPlace[] {
  const key = tidalPlaceKey(next),
    previous = places.find((place) => tidalPlaceKey(place) === key)
  return [
    ...places.filter((place) => tidalPlaceKey(place) !== key),
    {
      ...next,
      visits: Math.min(999, (previous?.visits ?? 0) + 1),
      ...(next.echo
        ? {
            echo: {
              ...next.echo,
              dwellMs: Math.min(86400000, (previous?.echo?.dwellMs ?? 0) + next.echo.dwellMs),
              peakMs: Math.max(previous?.echo?.peakMs ?? 0, next.echo.peakMs)
            }
          }
        : previous?.echo
          ? { echo: previous.echo }
          : {})
    }
  ]
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function validTime(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000
  )
}
/** The core owns address validation; the theme only bounds its display metadata. */
export function readTidalPlace(value: unknown): TidalPlace | undefined {
  const item = record(value)
  if (!item) return
  const address = parseTextAddress(item.address)
  if (!address || address.match.text.length > 80) return
  if (typeof item.title !== 'string' || item.title.length > 180) return
  if (
    typeof item.position !== 'number' ||
    !Number.isFinite(item.position) ||
    item.position < 0 ||
    item.position > 1 ||
    !validTime(item.at) ||
    !Number.isSafeInteger(item.visits) ||
    Number(item.visits) < 1
  )
    return
  return {
    address,
    title: item.title as string,
    position: item.position,
    at: item.at,
    visits: Math.min(999, Number(item.visits)),
    ...(readEchoDetails(item.echo) ? { echo: readEchoDetails(item.echo) } : {})
  }
}
function readEchoDetails(input: unknown): EchoPlaceDetails | undefined {
  const v = record(input)
  if (
    !v ||
    !['dwellMs', 'peakMs', 'textShare', 'switches', 'reversals'].every(
      (k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && Number(v[k]) >= 0
    )
  )
    return
  return {
    dwellMs: Math.min(86400000, Number(v.dwellMs)),
    peakMs: Math.min(86400000, Number(v.peakMs)),
    textShare: Math.min(1, Number(v.textShare)),
    switches: Math.min(1000000, Number(v.switches)),
    reversals: Math.min(1000000, Number(v.reversals))
  }
}
export function readTidalShelf(raw: string | null): TidalBookPlaces[] {
  if (!raw || raw.length > SHELF_LIMIT) return []
  try {
    const data = record(JSON.parse(raw))
    if (data?.version !== 2 || !Array.isArray(data.books)) return []
    const books = new Map<string, TidalBookPlaces>()
    for (const value of data.books.slice(-TIDAL_BOOK_LIMIT)) {
      const book = record(value)
      if (
        !book ||
        typeof book.key !== 'string' ||
        !validTime(book.at) ||
        !Array.isArray(book.places)
      )
        continue
      const places = new Map<string, TidalPlace>()
      for (const value of book.places) {
        const place = readTidalPlace(value)
        if (!place || tidalBookKey(place.address.version) !== book.key) continue
        const key = tidalPlaceKey(place)
        places.delete(key)
        places.set(key, place)
      }
      if (!places.size) continue
      books.delete(book.key)
      books.set(book.key, { key: book.key, at: book.at, places: [...places.values()] })
    }
    return [...books.values()]
  } catch {
    return []
  }
}
export function writeTidalShelf(books: TidalBookPlaces[], book: TidalBookPlaces): string {
  const next = book
  const current = [
    ...books.filter((item) => item.key !== book.key),
    ...(next.places.length ? [next] : [])
  ].slice(-TIDAL_BOOK_LIMIT)
  let encoded = JSON.stringify({ version: 2, books: current })
  while (encoded.length > SHELF_LIMIT && current.length > 1) {
    current.shift()
    encoded = JSON.stringify({ version: 2, books: current })
  }
  // Keep the current reading in memory if its complete set cannot be persisted.
  if (encoded.length > SHELF_LIMIT)
    throw new RangeError('Reading places exceed local cache capacity')
  return encoded
}
