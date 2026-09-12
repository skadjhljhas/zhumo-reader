import { it, expect } from 'vitest'
import {
  syntaxPassages,
  syntaxHasProse,
  syntaxPassageChildren,
  type SyntaxPassage,
  type SyntaxRegion
} from '../src/shared/syntax-passages'
it('does not let punctuation inside math or code split a sentence', () => {
  const text = '当x.y>0成立时，调用cache.get(key)返回结果。'
  const regions: SyntaxRegion[] = [
    { kind: 'math', start: 1, end: 6 },
    { kind: 'code', start: text.indexOf('cache'), end: text.indexOf('返回') }
  ]
  expect(syntaxPassages(text, regions)).toEqual([
    { start: 0, end: text.length, sentenceStart: 0, sentenceEnd: text.length }
  ])
  expect(syntaxHasProse('x.y', [{ kind: 'math', start: 0, end: 3 }])).toBe(false)
})
it('partitions long sentences into stable windows without losing non-whitespace text', () => {
  const text = '如果我们继续检查这个条件，'.repeat(140) + '结论仍然需要语境。'
  const windows = syntaxPassages(text, [])
  expect(windows.length).toBeGreaterThan(3)
  expect(windows.map((w) => text.slice(w.start, w.end)).join('')).toBe(text)
  expect(windows.every((w) => w.end - w.start <= 480)).toBe(true)
  expect(windows[1].sentenceStart).toBe(0)
  expect(windows[1].sentenceEnd).toBe(text.length)
  expect(syntaxPassages(text, [])).toEqual(windows)
})
it('never cuts a protected expression or a grapheme at a forced boundary', () => {
  const text =
    '甲'.repeat(445) + '公式' + 'x+y+'.repeat(35) + '后续文字，' + '👩🏽‍💻é'.repeat(140) + '。'
  const atom = { kind: 'math' as const, start: 447, end: 587 }
  const boundaries = new Set(
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      (g) => g.index
    )
  )
  boundaries.add(text.length)
  const windows = syntaxPassages(text, [atom])
  for (const w of windows) {
    expect(w.start > atom.start && w.start < atom.end).toBe(false)
    expect(w.end > atom.start && w.end < atom.end).toBe(false)
    expect(boundaries.has(w.start)).toBe(true)
    expect(boundaries.has(w.end)).toBe(true)
  }
})
it('preserves complete atom boundaries even when its source starts with whitespace', () => {
  const text = ' x + y 表示一个和。',
    regions: SyntaxRegion[] = [{ kind: 'math', start: 0, end: 7 }]
  expect(syntaxPassages(text, regions)[0].start).toBe(0)
  expect(syntaxPassages('value.get(x)', [{ kind: 'code', start: 0, end: 12 }])).toEqual([])
})
it('refines lazily without moving source boundaries or losing the original sentence context', () => {
  const text = '并非每一种判断都已经成立，'.repeat(90) + '所以仍需阅读下文。'
  const root = syntaxPassages(text, [])[1]
  const children = syntaxPassageChildren(text, [], root)
  expect(children.map((c) => text.slice(c.start, c.end)).join('')).toBe(
    text.slice(root.start, root.end)
  )
  expect(
    children.every(
      (c) => c.sentenceStart === root.sentenceStart && c.sentenceEnd === root.sentenceEnd
    )
  ).toBe(true)
  expect(syntaxPassageChildren(text, [], root)).toEqual(children)
  const descend = (p: SyntaxPassage): void => {
    for (const child of syntaxPassageChildren(text, [], p)) {
      expect(child.end - child.start).toBeLessThan(p.end - p.start)
      descend(child)
    }
  }
  descend(root)
})
