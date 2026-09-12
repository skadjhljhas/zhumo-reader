import { describe, expect, it } from 'vitest'
import {
  appendTidalPlace,
  readTidalPlace,
  readTidalShelf,
  writeTidalShelf,
  tidalPlaceKey,
  tidalBookKey,
  type TidalPlace,
  type TidalBookPlaces
} from '../src/renderer/src/composables/tidalPlaces'

const place = (block = 0, book = 0): TidalPlace => ({
  address: {
    schema: 1,
    version: {
      path: 'C:/书' + book + '.md',
      digest: 'a'.repeat(64),
      length: 10000,
      hash: 'sha256-utf16le-1',
      projection: 'zhumo-search-text-1'
    },
    origin: { kind: 'section', sectionId: 'sec-1' },
    blockIndex: block,
    match: { start: 2, end: 4, text: '门槛' },
    prefix: '走向',
    suffix: '。'
  },
  title: '原句',
  position: 0.25,
  at: 1000 + block,
  visits: 1
})
function collection(index: number, length = 1): TidalBookPlaces {
  const places = Array.from({ length }, (_, block) => place(block, index))
  return { key: tidalBookKey(places[0].address.version), at: index, places }
}
describe('tidal places consume the shared text-address contract', () => {
  it('keeps repeated words in different source paragraphs distinct', () => {
    const values = appendTidalPlace(appendTidalPlace([], place(1)), place(2))
    expect(values).toHaveLength(2)
    expect(tidalPlaceKey(values[0])).not.toBe(tidalPlaceKey(values[1]))
  })
  it('moves a revisited place to the present and retains its count', () => {
    const values = appendTidalPlace([place(1), place(2)], { ...place(1), at: 2000 })
    expect(values.map((item) => item.address.blockIndex)).toEqual([2, 1])
    expect(values[1].visits).toBe(2)
    expect(values[1].at).toBe(2000)
  })
  it('retains every distinct location beyond twenty-four, including after a storage roundtrip', () => {
    let values: TidalPlace[] = []
    for (let i = 0; i < 40; i++) values = appendTidalPlace(values, place(i))
    expect(values.map((item) => item.address.blockIndex)).toEqual(
      Array.from({ length: 40 }, (_, i) => i)
    )
    const book = { key: tidalBookKey(values[0].address.version), at: 1, places: values }
    expect(readTidalShelf(writeTidalShelf([], book))[0].places).toHaveLength(40)
  })
  it('roundtrips the shared address without retaining copied prose or extra metadata', () => {
    const original = place()
    const result = readTidalPlace({
      ...original,
      word: '假词',
      before: '伪造原文',
      __unused: '<script>ignored</script>'
    })
    expect(result).toEqual(place())
    expect(result!.address).not.toBe(original.address)
  })
  it('rejects invalid shared addresses and invalid theme metadata', () => {
    const value = place()
    for (const item of [
      { ...value, address: { ...value.address, blockIndex: -1 } },
      { ...value, address: { ...value.address, match: { ...value.address.match, end: 8 } } },
      {
        ...value,
        address: { ...value.address, version: { ...value.address.version, hash: 'utf8' } }
      },
      { ...value, position: NaN },
      { ...value, position: 2 },
      { ...value, title: 'x'.repeat(200) },
      { ...value, at: Infinity },
      { ...value, visits: -1 }
    ])
      expect(readTidalPlace(item)).toBeUndefined()
  })
  it('rejects malformed storage and old shelves rather than relabeling their digest', () => {
    expect(readTidalShelf('{broken')).toEqual([])
    expect(readTidalShelf('x'.repeat(350001))).toEqual([])
    expect(readTidalShelf(JSON.stringify({ version: 1, books: [collection(0)] }))).toEqual([])
    const books = Array.from({ length: 15 }, (_, i) => collection(i, 30))
    const read = readTidalShelf(JSON.stringify({ version: 2, books }))
    expect(read).toHaveLength(12)
    expect(read[0].places).toHaveLength(30)
    expect(read[0].key).toBe(books[3].key)
  })
  it('separates identical text in different files and refuses records in the wrong shelf', () => {
    const a = collection(1),
      b = collection(2)
    expect(a.key).not.toBe(b.key)
    expect(tidalPlaceKey(a.places[0])).not.toBe(tidalPlaceKey(b.places[0]))
    const values = readTidalShelf(
      JSON.stringify({
        version: 2,
        books: [{ ...a, places: [...a.places, ...b.places] }]
      })
    )
    expect(values[0].places).toEqual(a.places)
  })
  it('deduplicates malformed cache entries without inventing another visit', () => {
    const book = collection(1)
    const read = readTidalShelf(
      JSON.stringify({
        version: 2,
        books: [{ ...book, places: [book.places[0], { ...book.places[0], visits: 3 }] }]
      })
    )
    expect(read[0].places).toHaveLength(1)
    expect(read[0].places[0].visits).toBe(3)
  })
  it('updates and clears one manuscript while preserving other recent manuscripts', () => {
    const first = collection(1),
      other = collection(2)
    const written = writeTidalShelf([first, other], { ...first, at: 3, places: [place(3, 1)] })
    const values = readTidalShelf(written)
    expect(values.map((item) => item.key)).toEqual([other.key, first.key])
    expect(values[1].places[0].address.blockIndex).toBe(3)
    expect(readTidalShelf(writeTidalShelf(values, { ...first, places: [] }))).toEqual([other])
  })
  it('does not silently discard part of the current reading when storage cannot fit it', () => {
    const book = collection(1, 24)
    for (const value of book.places)
      value.address.version.path = 'C:/' + '目录/'.repeat(7000) + '文稿.md'
    book.key = tidalBookKey(book.places[0].address.version)
    expect(() => writeTidalShelf([], book)).toThrow(RangeError)
    expect(book.places).toHaveLength(24)
  })
})
