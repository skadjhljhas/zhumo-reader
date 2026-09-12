import { describe, expect, it } from 'vitest'
import {
  resolveReadingInsertion,
  type ReadingSelectionAddress
} from '../src/renderer/src/parser/reading-source'
import {
  createNoteChanges,
  applyNormalizedChanges,
  inspectNoteSource
} from '../src/renderer/src/composables/noteAuthoring'
import { parseBook } from '../src/renderer/src/parser'
it('locates an imported EPUB projection by its exact, validated text offset', () => {
  const source = '重复的词。\n\n其他文字。\n\n重复的词。',
    from = source.lastIndexOf('重复的词。')
  const address: ReadingSelectionAddress = {
    kind: 'section',
    id: 'epub-section-1',
    inline: 0,
    text: '重复的词。',
    end: 3,
    projectionFrom: from
  }
  expect(resolveReadingInsertion(source, address)).toEqual({ position: from + 3 })
  expect(() => resolveReadingInsertion(source, { ...address, projectionFrom: from - 1 })).toThrow()
  expect(() => resolveReadingInsertion(source, { ...address, projectionFrom: -1 })).toThrow()
})

function resolve(
  source: string,
  text: string,
  end = text.length,
  inline = 0,
  id = 'sec-1'
): number {
  return resolveReadingInsertion(source, { kind: 'section', id, inline, text, end }).position
}
function add(source: string, address: ReadingSelectionAddress): string {
  const position = resolveReadingInsertion(source, address).position
  const created = createNoteChanges(source, position)
  const result = applyNormalizedChanges(source, created.changes)
  const reference = inspectNoteSource(result).references.find((ref) => ref.label === created.label)!
  expect(reference.parent).toBe(address.kind === 'note' ? address.id : undefined)
  return result
}
describe('a reading selection resolves to its own Markdown occurrence', () => {
  it('distinguishes repeated text within and between paragraphs', () => {
    const source = '# 标题\n\n门槛，门槛。\n\n门槛，门槛。'
    expect(resolve(source, '门槛，门槛。', 5, 2)).toBe(source.lastIndexOf('门槛') + 2)
    expect(resolve(source, '门槛，门槛。', 2, 1)).toBe(source.indexOf('门槛') + 2)
  })
  it('finds the last of many repeated occurrences without scanning every possible insertion', () => {
    const source = '门槛。'.repeat(6000)
    expect(resolve(source, source, source.length - 1)).toBe(source.length - 1)
  })
  it('handles CJK emphasis without changing its meaning', () => {
    const source = '先有**门槛**，才有后来。'
    const next = add(source, {
      kind: 'section',
      id: 'sec-1',
      inline: 0,
      text: '先有门槛，才有后来。',
      end: 4
    })
    expect(parseBook(next).sections[0].html).toContain('<strong>门槛')
    expect(parseBook(next).notes).toHaveLength(1)
  })
  it('places the mark after a complete link and leaves its destination intact', () => {
    const source = '走到[门槛](./门槛.md "门槛")，再回来。'
    expect(resolve(source, '走到门槛，再回来。', 4)).toBe(source.indexOf('，'))
    expect(() => resolve(source, '走到门槛，再回来。', 3)).toThrow('无法精确对应')
  })
  it('handles reference links whose definition is in another section', () => {
    const source = '# 前页\n\n[路]: ./另一页.md\n\n# 后页\n\n走向[远方][路]。'
    expect(resolve(source, '走向远方。', 4, 1, 'sec-2')).toBe(source.lastIndexOf('。'))
  })
  it('maps escaped punctuation, named entities and decoded emoji to complete source spellings', () => {
    const source = '原句 \\* &amp; &#x1F320; 之后。'
    const text = '原句 * & 🌠 之后。'
    expect(resolve(source, text, text.indexOf('&') + 1)).toBe(source.indexOf('&amp;') + 5)
    expect(resolve(source, text, text.indexOf('🌠') + 2)).toBe(source.indexOf('&#x1F320;') + 9)
    expect(resolve(source, text, text.indexOf('*') + 1)).toBe(source.indexOf('\\*') + 2)
  })
  it('keeps original BOM and the CodeMirror LF coordinate system', () => {
    const source = '\uFEFF# 页\r\n\r\n😀门槛。'
    expect(resolve(source, '😀门槛。', 4, 1)).toBe(source.replace(/\r\n/g, '\n').indexOf('。'))
  })
  it('handles tight nested lists, blockquotes and table cells with repeated words', () => {
    const source = '- 门槛\n  - 门槛\n\n> 门槛\n\n| 门槛 | 门槛 |\n| --- | --- |\n| 门槛 | 门槛 |'
    expect(resolve(source, '门槛', 2, 1)).toBe(source.indexOf('\n\n'))
    expect(resolve(source, '门槛', 2, 2)).toBe(source.indexOf('\n\n|'))
    expect(resolve(source, '门槛', 2, 6)).toBe(source.lastIndexOf('门槛') + 2)
  })
  it('keeps reference badges out of visible text offsets', () => {
    const source = '门[^甲]槛之后。\n\n[^甲]: 旁注。'
    expect(resolve(source, '门槛之后。', 2)).toBe(source.indexOf('之后'))
  })
  it('traces text after a multiline inline annotation', () => {
    const source = '之前^[第一行。\n第二行。]之后。'
    expect(resolve(source, '之前之后。', 4)).toBe(source.lastIndexOf('。'))
  })
  it('writes inside the selected nested note, including an inline note in a definition', () => {
    const source = '正文[^甲]。\n\n[^甲]: 同一句。^[里层，同一句。]再见。\n\n[^乙]: 同一句。'
    const next = add(source, {
      kind: 'note',
      id: 'auto-1',
      inline: 0,
      text: '里层，同一句。',
      end: 6
    })
    expect(next).toContain('^[里层，同一句[^2]。]')
    const separate = add(source, { kind: 'note', id: '乙', inline: 0, text: '同一句。', end: 3 })
    expect(separate).toContain('[^乙]: 同一句[^2]。')
  })
  it('allows a mark after a complete inline code span or formula but never inside them', () => {
    const tick = String.fromCharCode(96)
    const code = '前文 ' + tick + 'abc' + tick + ' 后文。'
    expect(resolve(code, '前文 abc 后文。', 6)).toBe(code.lastIndexOf(tick) + 1)
    expect(() => resolve(code, '前文 abc 后文。', 5)).toThrow('无法精确对应')
    const math = '前文 $x^2$ 后文。'
    expect(resolve(math, '前文 x^2 后文。', 6)).toBe(math.lastIndexOf('$') + 1)
    expect(() => resolve(math, '前文 x^2 后文。', 5)).toThrow('无法精确对应')
  })
  it('finds complete boundaries of long opaque inline content', () => {
    const tick = String.fromCharCode(96)
    const source = '前文 ' + tick + 'c'.repeat(16000) + tick + ' 后文。'
    expect(resolve(source, '前文 ' + 'c'.repeat(16000) + ' 后文。', 16003)).toBe(
      source.lastIndexOf(tick) + 1
    )
  })
  it('retains link definitions introduced by an earlier rendered annotation', () => {
    const source =
      '正文[^甲][^乙]。\n\n[^甲]: 来路。\n\n    [路]: ./另一页.md\n\n[^乙]: 通向[远方][路]。'
    const result = resolveReadingInsertion(source, {
      kind: 'note',
      id: '乙',
      inline: 0,
      text: '通向远方。',
      end: 4
    })
    expect(result.position).toBe(source.lastIndexOf('。'))
  })
  it('rejects stale text, stale containers, partial Unicode and invalid endpoints', () => {
    expect(() => resolve('正确。', '过时。')).toThrow('无法精确对应')
    expect(() => resolve('正确。', '正确。', 3, 99)).toThrow('无法精确对应')
    expect(() => resolve('正确。', '正确。', 3, 0, 'sec-99')).toThrow('无法精确对应')
    expect(() => resolve('🌠门槛。', '🌠门槛。', 1)).toThrow('无法精确对应')
    expect(() => resolve('正确。', '正确。', -1)).toThrow('无法精确对应')
  })
})
