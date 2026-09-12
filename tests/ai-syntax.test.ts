import { describe, expect, it } from 'vitest'
import { parseSyntaxAnalysis } from '../src/shared/ai-types'
const span = (quote: string, occurrence = 1): Record<string, unknown> => ({
  quote,
  occurrence,
  role: 'subject',
  label: '主语',
  explanation: '本句主语',
  confidence: 0.9
})
const output = (text: string, spans: unknown[]): string =>
  JSON.stringify({ text, summary: '结构', spans })
describe('syntax results are tied to exact selected text', () => {
  it('locates the chosen repeated phrase after astral Unicode without model offsets', () => {
    const text = '🌙月光照见月光。'
    const result = parseSyntaxAnalysis(output(text, [span('月光', 2)]), text)
    expect(result.spans[0]).toMatchObject({ start: 6, end: 8, quote: '月光' })
  })
  it('preserves nesting and orders outer ranges before inner ones', () => {
    const text = '未读到的句子'
    expect(
      parseSyntaxAnalysis(output(text, [span('未读到'), span(text)]), text).spans.map(
        (x) => x.depth
      )
    ).toEqual([0, 1])
  })
  it('accepts explicit uncertainty with no forced annotations', () => {
    expect(parseSyntaxAnalysis(output('啊。', []), '啊。').spans).toEqual([])
  })
  it.each([
    ['crossed spans', output('abcdef', [span('abcd'), span('cdef')]), 'abcdef'],
    ['duplicates', output('abc', [span('abc'), span('abc')]), 'abc'],
    ['changed text', output('甲 乙', []), '甲乙'],
    ['fabricated quote', output('甲乙', [span('丙')]), '甲乙'],
    ['missing occurrence', output('甲乙', [{ ...span('甲'), occurrence: undefined }]), '甲乙'],
    ['too many occurrences', output('甲乙', [span('甲', 2)]), '甲乙'],
    ['invalid role', output('甲乙', [{ ...span('甲'), role: '__proto__' }]), '甲乙'],
    ['invalid confidence', output('甲乙', [{ ...span('甲'), confidence: 'certain' }]), '甲乙'],
    [
      'deep nesting',
      output(
        'abcdef',
        ['abcdef', 'abcde', 'abcd', 'abc'].map((x) => span(x))
      ),
      'abcdef'
    ],
    ['truncated JSON', '{"text":"甲乙",', '甲乙']
  ])('rejects %s instead of painting guessed structure', (_name, json, text) => {
    expect(() => parseSyntaxAnalysis(json, text)).toThrow()
  })
})
