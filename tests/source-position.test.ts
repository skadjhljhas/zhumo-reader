import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import {
  SourcePositionIndex,
  sourcePlace,
  placeOffset,
  snapSourceOffset
} from '../src/renderer/src/composables/sourcePosition'

describe('source landmarks for reading/editing position synchronization', () => {
  it('keeps the normal parse contract and creates sparse landmarks only when requested', () => {
    const source = '# 第一页\n\n' + '这是一段很长的文字。'.repeat(4000)
    expect(parseBook(source).sourceBlocks).toBeUndefined()
    const book = parseBook(source, { sourcePositions: true })
    expect(book.warnings).toEqual([])
    expect(book.sourceBlocks).toHaveLength(2)
    expect(JSON.stringify(book.sourceBlocks).length).toBeLessThan(1000)
    expect(book.sections[0].html).toContain('data-source-block="i1"')
  })
  it('uses LF offsets including the BOM, with distinct repeated paragraphs and removed definitions', () => {
    const raw = '\uFEFF# 页面\r\n\r\n同一句。\r\n\r\n[^甲]: 另一句话。\r\n\r\n同一句。'
    const source = raw.replace(/\r\n/g, '\n')
    const book = parseBook(raw, { sourcePositions: true })
    const index = new SourcePositionIndex(book.sourceBlocks)
    const first = index.at(source.indexOf('同一句'))!,
      last = index.at(source.lastIndexOf('同一句'))!
    expect(first.kind).toBe('section')
    expect(first.key).not.toBe(last.key)
    expect(first.from).toBe(source.indexOf('同一句'))
    expect(last.from).toBe(source.lastIndexOf('同一句'))
    expect(index.at(source.indexOf('另一句话'))?.label).toBe('甲')
    for (const block of book.sourceBlocks!) {
      expect(block.from).toBeGreaterThanOrEqual(1)
      expect(block.to).toBeLessThanOrEqual(source.length)
    }
  })
  it('prefers the innermost note and recognizes its definition prefix', () => {
    const source = '外层^[里面^[最深。]结束。]正文。\n\n[^甲]: 标号所在的注释。'
    const book = parseBook(source, { sourcePositions: true })
    const index = new SourcePositionIndex(book.sourceBlocks)
    expect(index.at(source.indexOf('外层'))?.kind).toBe('section')
    expect(index.at(source.indexOf('里面'))?.label).toBe('auto-1')
    expect(index.at(source.indexOf('最深'))?.label).toBe('auto-2')
    expect(index.at(source.indexOf('[^甲]:'))?.label).toBe('甲')
    expect(index.at(source.indexOf('正文'))?.kind).toBe('section')
  })
  it('keeps code, diagrams and deferred numbered formulae attached to their actual outer elements', () => {
    const tick = String.fromCharCode(96).repeat(3)
    const source =
      tick +
      'js\nconst value = 1\n' +
      tick +
      '\n\n' +
      tick +
      'mermaid\nflowchart LR\n  A --> B\n' +
      tick +
      '\n\n$$\n\\begin{equation}x=1\\label{a}\\end{equation}\n$$'
    const book = parseBook(source, { sourcePositions: true })
    const html = book.sections.map((section) => section.html).join('')
    expect(book.warnings).toEqual([])
    expect(html).not.toContain('<!--zmu-source')
    expect(html).not.toContain('<!--zmu-math-slot')
    expect(html).toMatch(/<pre data-source-block="a\d+"/)
    expect(html).toMatch(/<figure data-source-block="a\d+"[^>]*class="zmu-diagram/)
    expect(html).toMatch(/<div data-source-block="a\d+"[^>]*class="zmu-math/)
    const index = new SourcePositionIndex(book.sourceBlocks)
    expect(index.at(source.indexOf('const value'))?.tag).toBe('fence')
    expect(index.at(source.indexOf('x=1'))?.tag).toBe('math_block')
  })
  it('tracks nested lists, quotes and table cells without duplicating source in metadata', () => {
    const source = '- 第一项\n  - 第二项\n\n> 引文。\n\n| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |'
    const book = parseBook(source, { sourcePositions: true })
    const blocks = book.sourceBlocks!
    expect(blocks.filter((block) => block.tag === 'th')).toHaveLength(2)
    expect(blocks.filter((block) => block.tag === 'td')).toHaveLength(2)
    const index = new SourcePositionIndex(blocks)
    const child = index.at(source.indexOf('第二项'))!
    expect(source.slice(child.from, child.to)).toContain('第二项')
    expect(source.slice(child.from, child.to)).not.toContain('第一项')
  })
  it('round-trips within a long paragraph and never bisects a UTF-16 surrogate pair', () => {
    const source = '甲乙丙丁。'.repeat(500)
    const book = parseBook(source, { sourcePositions: true })
    const place = sourcePlace(new SourcePositionIndex(book.sourceBlocks), 1326)!
    expect(placeOffset(place)).toBe(1326)
    expect(snapSourceOffset('A🌠B', 2)).toBe(1)
    expect(snapSourceOffset('A🌠B', 3)).toBe(3)
    expect(snapSourceOffset('A🌠B', 99)).toBe(4)
  })
  it('keeps a caret at a paragraph end while leaving an inline annotation at its closing boundary', () => {
    const source = '第一段。\n\n外层^[里面。]正文。'
    const index = new SourcePositionIndex(parseBook(source, { sourcePositions: true }).sourceBlocks)
    expect(index.at(4)?.key).toBe('i0')
    expect(index.at(source.indexOf('正文'))?.kind).toBe('section')
  })
})
