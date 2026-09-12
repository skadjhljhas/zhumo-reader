import { describe, expect, it } from 'vitest'
import { parseSyntaxAnalysis } from '../src/shared/ai-types'
import { SYNTAX_EXAMPLES } from '../src/shared/syntax-examples'
import { syntaxProjection, syntaxReport } from '../src/shared/syntax-view'
const unit = (id: string, quote: string, occurrence = 1): Record<string, unknown> => ({
  id,
  layer: 'syntax',
  role: 'clause',
  label: id,
  anchors: [{ quote, occurrence }],
  explanation: '本句的单位。',
  evidence: '原文提供该片段。',
  status: 'supported'
})
const relation = (id: string, from: string, to: string[]): Record<string, unknown> => ({
  id,
  kind: 'dependency',
  from,
  to,
  label: '结构关系',
  explanation: '两个原文单位之间的关系。',
  evidence: '本句结构。',
  status: 'supported'
})
const parse = (
  text: string,
  units: unknown[],
  relations: unknown[] = [],
  readings: unknown[] = []
): ReturnType<typeof parseSyntaxAnalysis> =>
  parseSyntaxAnalysis(
    JSON.stringify({ version: 2, text, summary: '关系与范围', units, relations, readings }),
    text
  )
describe('typed syntax graphs remain faithful to exact text and alternative readings', () => {
  it('keeps overlapping layers and discontinuous anchors including repeated Unicode words', () => {
    const result = parse('🌙月光照见月光。', [
      unit('a', '月光照见'),
      unit('b', '照见月光'),
      { ...unit('c', '月光'), layer: 'meaning' },
      {
        ...unit('d', '月光'),
        anchors: [
          { quote: '月光', occurrence: 1 },
          { quote: '月光', occurrence: 2 }
        ]
      }
    ])
    expect(result.spans).toHaveLength(4)
    expect(result.spans[3].anchors?.map((a) => [a.start, a.end])).toEqual([
      [2, 4],
      [6, 8]
    ])
    expect(result.spans[3].quote).toBe('月光 … 月光')
  })
  it('does not fabricate a source range for an implicit unit', () => {
    const result = SYNTAX_EXAMPLES.find((e) => e.id === 'ellipsis')!.analysis
    const missing = result.spans.find((u) => u.implicit)!
    expect(missing.anchors).toEqual([])
    expect(missing.start).toBe(-1)
    expect(result.text).not.toContain('隐含')
    expect(syntaxReport(result)).toContain('〔隐含〕')
  })
  it('switches exclusive relation sets while keeping the original sentence and shared units', () => {
    const result = SYNTAX_EXAMPLES.find((e) => e.id === 'focus')!.analysis
    const a = syntaxProjection(result, 'recipient_reading'),
      b = syntaxProjection(result, 'activity_reading')
    expect(a.relations.map((r) => r.id)).toEqual(['recipient'])
    expect(b.relations.map((r) => r.id)).toEqual(['activity'])
    expect(a.units.map((u) => u.id)).toEqual(b.units.map((u) => u.id))
    expect(result.text).toBe('她只给林舟写了信。')
  })
  it('rejects invented text, dangling edges and invalid implicit anchors', () => {
    expect(() => parse('甲乙', [unit('a', '丙')])).toThrow('逐字对应')
    expect(() => parse('甲乙', [unit('a', '甲')], [relation('r', 'a', ['missing'])])).toThrow(
      '不存在'
    )
    expect(() => parse('甲乙', [{ ...unit('a', '甲'), implicit: true }])).toThrow('隐含')
    expect(() => parse('🌙', [unit('a', '\uD83C')])).toThrow('Unicode')
  })
  it('rejects a relation leaking from one interpretation into another', () => {
    const units = [unit('a', '甲'), unit('b', '乙')]
    const readings = [
      {
        id: 'x',
        label: '读法一',
        units: ['a'],
        relations: [],
        explanation: '第一种读法',
        conditions: '第一种语境'
      },
      {
        id: 'y',
        label: '读法二',
        units: ['b'],
        relations: [],
        explanation: '第二种读法',
        conditions: '第二种语境'
      }
    ]
    expect(() => parse('甲乙', units, [relation('r', 'a', ['b'])], readings)).toThrow('另一读法')
  })
  it('accepts deeper analytical nesting without a three-level presentation limit', () => {
    expect(
      parse(
        'abcdef',
        ['abcdef', 'abcde', 'abcd', 'abc', 'ab'].map((q, i) => unit('u' + i, q))
      ).spans
    ).toHaveLength(5)
  })
  it('preserves all complete examples without inventing probabilities', () => {
    for (const e of SYNTAX_EXAMPLES) {
      expect(e.analysis.version).toBe(2)
      expect(e.analysis.relations?.length).toBeGreaterThan(0)
      expect(e.analysis.spans.every((u) => u.confidence === undefined)).toBe(true)
    }
  })
})
