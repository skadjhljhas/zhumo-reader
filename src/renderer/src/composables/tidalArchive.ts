import { readTidalPlace, tidalBookKey, type TidalBookPlaces } from './tidalPlaces'

let opening: Promise<IDBDatabase> | undefined
let writes: Promise<unknown> = Promise.resolve()
const journalKey = (key: string): string => 'zhumo.reading-echo.pending:' + key
function validateBook(value: unknown, key: string): TidalBookPlaces {
  const raw = value as TidalBookPlaces | undefined
  if (!raw || raw.key !== key || !Number.isFinite(raw.at) || !Array.isArray(raw.places))
    throw Error('回声存档格式无效。')
  const places = raw.places.map(readTidalPlace)
  if (places.some((p) => !p || tidalBookKey(p.address.version) !== key))
    throw Error('回声存档位置校验失败。')
  return { key, at: raw.at, places: places as TidalBookPlaces['places'] }
}
function database(): Promise<IDBDatabase> {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('zhumo-reading-echo', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'key' })
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        opening = undefined
      }
      resolve(request.result)
    }
    request.onerror = () => {
      opening = undefined
      reject(request.error)
    }
  }))
}
/** An empty stored book is a tombstone; never resurrect the pre-migration shelf after clear. */
export async function readTidalArchive(key: string): Promise<TidalBookPlaces | undefined> {
  await writes
  let pending: TidalBookPlaces | undefined
  try {
    const value = localStorage.getItem(journalKey(key))
    if (value) pending = validateBook(JSON.parse(value), key)
  } catch {
    /* IndexedDB can remain usable when localStorage is unavailable. */
  }
  try {
    const db = await database()
    const stored = await new Promise<TidalBookPlaces | undefined>((resolve, reject) => {
      const request = db.transaction('books').objectStore('books').get(key)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        try {
          resolve(request.result ? validateBook(request.result, key) : undefined)
        } catch (error) {
          reject(error)
        }
      }
    })
    // A failed write or immediate close can leave a newer journal, including a clear.
    return pending && (!stored || pending.at >= stored.at) ? pending : stored
  } catch (error) {
    if (pending) return pending
    throw error
  }
}
export function writeTidalArchive(book: TidalBookPlaces): Promise<void> {
  // Snapshot now, before a document switch or Vue mutates any of its proxies.
  const encoded = JSON.stringify(book)
  const snapshot = JSON.parse(encoded) as TidalBookPlaces
  let journaled = false
  try {
    localStorage.setItem(journalKey(book.key), encoded)
    journaled = true
  } catch {
    /* Large books use IndexedDB without imposing the localStorage quota. */
  }
  const next = writes.then(async () => {
    try {
      const db = await database()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite', { durability: 'strict' })
        tx.objectStore('books').put(snapshot)
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? Error('回声存档写入中断。'))
        tx.onerror = () => reject(tx.error)
      })
      try {
        if (localStorage.getItem(journalKey(book.key)) === encoded)
          localStorage.removeItem(journalKey(book.key))
      } catch {
        /* A remaining journal is read with the stored timestamp. */
      }
    } catch (error) {
      if (!journaled) throw error
      // The current book, even when empty, remains durably recoverable from the journal.
    }
  })
  writes = next.catch(() => undefined)
  return next
}
