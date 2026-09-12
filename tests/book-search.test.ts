import { describe, expect, it } from 'vitest'
import {
  searchBook,
  occurrenceContext,
  SEARCH_PAGE_SIZE,
  type SearchIndex,
  type SearchKind
} from '../src/renderer/src/composables/bookSearch'

function indexOf(body: string[], notes: string[] = []): SearchIndex {
  const index: SearchIndex = { entries: [], lengths: { section: 0, note: 0 } }
  for (const [kind, texts] of [
    ['section', body],
    ['note', notes]
  ] as [SearchKind, string[]][]) {
    texts.forEach((text, blockIndex) => {
      index.entries.push({
        id: kind + blockIndex,
        kind,
        title: kind,
        text,
        blockIndex,
        position: index.lengths[kind]
      })
      index.lengths[kind] += text.length + 1
    })
  }
  return index
}
describe('every literal occurrence remains reachable', () => {
  it('keeps later paragraphs and repeated occurrences within a paragraph', () => {
    const index = indexOf(
      Array.from({ length: 131 }, () => '门槛，在门槛之后。'),
      ['门槛', '门槛与门槛']
    )
    const found = searchBook(index, '门槛')
    expect(found.total).toBe(265)
    expect(found.paragraphs).toBe(133)
    expect(found.counts).toEqual({ section: 262, note: 3 })
    expect(found.at(1)).toEqual({ entryIndex: 0, start: 4, end: 6, ordinal: 1 })
    expect(found.at(261)).toEqual({ entryIndex: 130, start: 4, end: 6, ordinal: 261 })
    expect(found.page(264, SEARCH_PAGE_SIZE)).toEqual([
      { entryIndex: 132, start: 3, end: 5, ordinal: 264 }
    ])
  })
  it('treats TeX, backslashes and every regex operator as literal text', () => {
    const text = '\\eqref{a} [.*+?^$()|] \\eqref{a} a.*b'
    const index = indexOf([text])
    expect(searchBook(index, '\\eqref{a}').total).toBe(2)
    expect(searchBook(index, '[.*+?^$()|]').total).toBe(1)
    expect(searchBook(index, 'a.*b').total).toBe(1)
    expect(searchBook(index, 'a.b').total).toBe(0)
  })
  it('preserves original offsets before length-changing lowercase characters and emoji', () => {
    const text = 'İ X 😀 x K K k Σ σ ς'
    const index = indexOf([text])
    expect(searchBook(index, 'x').at(0)?.start).toBe(2)
    expect(searchBook(index, 'x').at(1)?.start).toBe(7)
    expect(searchBook(index, 'X', 'all', true).total).toBe(1)
    expect(searchBook(index, 'k').total).toBe(3)
    expect(searchBook(index, 'σ').total).toBe(3)
    const emoji = searchBook(index, '😀').at(0)!
    expect(text.slice(emoji.start, emoji.end)).toBe('😀')
  })
  it('filters body and notes while keeping density counts and first destinations exact', () => {
    const index = indexOf(['水流过门槛', '门槛'], ['门槛门槛门槛'])
    const found = searchBook(index, '门槛', 'note')
    expect(found.total).toBe(3)
    expect(found.counts).toEqual({ section: 0, note: 3 })
    expect(found.bins.section.every((bin) => bin.first === -1 && bin.count === 0)).toBe(true)
    expect(found.bins.note.reduce((sum, bin) => sum + bin.count, 0)).toBe(3)
    for (const bin of found.bins.note.filter((bin) => bin.count))
      expect(found.at(bin.first)?.entryIndex).toBe(2)
  })
  it('handles an extremely frequent single-character term without truncating its destinations', () => {
    const found = searchBook(indexOf(['字'.repeat(100000)]), '字')
    expect(found.total).toBe(100000)
    expect(found.paragraphs).toBe(1)
    expect(found.page(99984, 24)).toHaveLength(16)
    expect(found.at(99999)?.start).toBe(99999)
    expect(found.bins.section.reduce((sum, bin) => sum + bin.count, 0)).toBe(100000)
    expect(found.at(100000)).toBeUndefined()
    expect(found.at(-1)).toBeUndefined()
  })
  it('shows a bounded context at the selected later occurrence without splitting emoji', () => {
    const text = '😀😀 门槛。' + '漫长的路'.repeat(1000) + '😀😀 门槛。'
    const hit = searchBook(indexOf([text]), '门槛').at(1)!
    const context = occurrenceContext(text, hit, 4, 6)
    expect(context.match).toBe('门槛')
    expect(context.leading).toBe(true)
    expect(context.trailing).toBe(false)
    expect(context.before).toBe('😀 ')
    expect(context.after).toBe('。')
  })
  it('returns no matches for empty queries and excludes overlapping duplicates', () => {
    const index = indexOf(['aaaa'])
    expect(searchBook(index, '  ').total).toBe(0)
    expect(searchBook(index, 'aa').total).toBe(2)
    expect(searchBook(index, 'absent').page(0, 24)).toEqual([])
  })
})
