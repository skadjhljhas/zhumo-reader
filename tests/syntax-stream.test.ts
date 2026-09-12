import { describe, it, expect } from 'vitest'
import { SyntaxStream } from '../src/shared/syntax-stream'
import { SyntaxDwell } from '../src/shared/syntax-dwell'
const selected = '海风翻开书页。'
const unit = (id: string, quote: string, role: string): Record<string, unknown> => ({
  id,
  anchors: [{ quote, occurrence: 1 }],
  layer: 'syntax',
  role,
  label: role,
  explanation: '本句成分。',
  evidence: '原文明写。',
  status: 'supported'
})
const relation = {
  id: 'r1',
  from: 'v',
  to: ['s'],
  kind: 'dependency',
  label: '主干',
  explanation: '发出动作。',
  evidence: '主谓联系。',
  status: 'supported'
}
const first = {
  type: 'patch',
  units: [unit('s', '海风', 'subject'), unit('v', '翻开', 'predicate')],
  relations: [relation]
}
const second = {
  type: 'patch',
  units: [unit('o', '书页', 'object')],
  relations: [{ ...relation, id: 'r2', to: ['o'] }]
}
const line = (value: unknown): string => JSON.stringify(value) + '\n'
const begin = line({ type: 'begin', version: 3 })
describe('incremental syntax delivery', () => {
  it('accepts fenced pretty-printed complete records without guessing incomplete or invalid JSON', () => {
    const p = new SyntaxStream(selected)
    const wire =
      '```jsonl\n' +
      JSON.stringify({ type: 'begin', version: 3 }, null, 2) +
      '\n' +
      JSON.stringify(first, null, 2) +
      '\n'
    for (const char of wire) p.push(char)
    expect(p.analysis?.spans).toHaveLength(2)
    p.push(JSON.stringify({ type: 'done', summary: '完成。' }, null, 2) + '\n```')
    expect(p.finish().relations).toHaveLength(1)
  })
  it('applies a complete first batch before the rest is received, through every character boundary', () => {
    const parser = new SyntaxStream(selected),
      wire = begin + line(first)
    for (const char of wire.slice(0, -2)) parser.push(char)
    expect(parser.analysis).toBeNull()
    parser.push('}')
    expect(parser.analysis?.spans).toHaveLength(2)
    parser.push('\n')
    expect(parser.complete).toBe(false)
    parser.push(line(second))
    expect(parser.analysis?.spans).toHaveLength(3)
    parser.push(line({ type: 'done', summary: '主干已交付。' }))
    expect(parser.finish().relations).toHaveLength(2)
  })
  it('retains the previous valid graph on missing anchors or dangling relations', () => {
    for (const broken of [
      { ...second, units: [unit('o', '没有这个字', 'object')] },
      { ...second, relations: [{ ...relation, to: ['missing'] }] }
    ]) {
      const p = new SyntaxStream(selected)
      p.push(begin + line(first))
      const valid = p.analysis
      expect(() => p.push(line(broken))).not.toThrow()
      expect(p.analysis).toBe(valid)
      expect(p.drainIssues()).toMatchObject([{ kind: 'validation', recoverable: true }])
      p.push(line(second))
      expect(p.analysis?.spans).toHaveLength(3)
      p.push(line({ type: 'done', summary: '完成。' }))
      expect(() => p.finish()).toThrow('未作为完整结果缓存')
      expect(p.complete).toBe(false)
    }
  })
  it('requires an explicit completion and forbids trailing records or duplicate batch ids', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    expect(() => p.finish()).toThrow('尚未完成')
    expect(p.analysis?.spans).toHaveLength(2)
    const q = new SyntaxStream(selected)
    q.push(begin + line({ ...first, units: [first.units[0], first.units[0]] }))
    expect(q.drainIssues()[0].message).toContain('重复')
    p.push(line({ type: 'done', summary: '完成。' }))
    p.push(line(second))
    expect(p.drainIssues()[0].message).toContain('结束标记')
    expect(p.complete).toBe(false)
  })
  it('updates ids in place and does not duplicate existing units', () => {
    const p = new SyntaxStream(selected)
    p.push(
      begin +
        line(first) +
        line({
          type: 'patch',
          units: [{ ...first.units[0], explanation: '补充证据。' }],
          relations: []
        })
    )
    expect(p.analysis?.spans).toHaveLength(2)
    expect(p.analysis?.spans[0].id).toBe('s')
    expect(p.analysis?.spans[0].explanation).toBe('补充证据。')
  })
  it('keeps complete v2 responses compatible but never paints their unfinished JSON', () => {
    const raw = JSON.stringify(
      { version: 2, text: selected, summary: '主干。', ...first, readings: [] },
      null,
      2
    )
    const p = new SyntaxStream(selected)
    p.push(raw)
    expect(p.analysis).toBeNull()
    expect(p.finish().spans).toHaveLength(2)
  })

  it('delivers concatenated objects immediately without requiring a line delimiter', () => {
    const p = new SyntaxStream(selected)
    p.push(JSON.stringify({ type: 'begin', version: 3 }) + JSON.stringify(first))
    expect(p.analysis?.relations).toHaveLength(1)
    expect(p.complete).toBe(false)
    p.push(JSON.stringify(second) + JSON.stringify({ type: 'done', summary: '完成。' }))
    expect(p.finish().relations).toHaveLength(2)
    expect(p.drainIssues()).toEqual([])
  })

  it('handles quoted braces, escaped quotes, slashes and Unicode at every chunk boundary', () => {
    const special = '字符串中的 { } [ ]、引号 "、反斜线 \\、换行\n、文字光🌊都不是帧边界。'
    const patch = {
      ...first,
      units: first.units.map((u) => ({ ...u, explanation: special }))
    }
    const wire =
      begin.trimEnd() + JSON.stringify(patch) + JSON.stringify({ type: 'done', summary: '完成。' })
    for (let split = 0; split <= wire.length; split++) {
      const p = new SyntaxStream(selected)
      p.push(wire.slice(0, split))
      p.push(wire.slice(split))
      expect(p.finish().spans[0].explanation).toBe(special)
      expect(p.drainIssues()).toEqual([])
    }
  })

  it('accepts CRLF, BOM, pretty records, fences and a final object without newline', () => {
    const p = new SyntaxStream(selected)
    const wire =
      '\uFEFF```ndjson\r\n' +
      JSON.stringify({ type: 'begin', version: 3 }, null, 2).replaceAll('\n', '\r\n') +
      JSON.stringify(first, null, 2).replaceAll('\n', '\r\n') +
      '\r\n```\r\n```json\r\n' +
      JSON.stringify({ type: 'done', summary: '完成。' }) +
      '\r\n```'
    for (const char of wire) p.push(char)
    expect(p.finish().relations).toHaveLength(1)
    expect(p.drainIssues()).toEqual([])
  })

  it('skips one balanced invalid JSON object and still applies the next complete patch', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    const valid = p.analysis
    p.push('{"type":"patch","units":[],"relations":[],}')
    expect(p.analysis).toBe(valid)
    expect(p.drainIssues()).toMatchObject([{ sequence: 1, kind: 'json', recoverable: true }])
    p.push(JSON.stringify(second))
    expect(p.analysis?.relations).toHaveLength(2)
    p.push(JSON.stringify({ type: 'done', summary: '完成。' }))
    expect(p.drainIssues()).toEqual([])
    expect(() => p.finish()).toThrow('未修复')
    expect(p.complete).toBe(false)
  })

  it('isolates damaged nested arrays without consuming the following root object', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + '{"type":"patch","units":[},' + JSON.stringify(first))
    expect(p.analysis?.spans).toHaveLength(2)
    expect(p.drainIssues().map((issue) => issue.kind)).toEqual(['json', 'framing'])
  })

  it('does not stop valid later packets when several invalid packets share one chunk', () => {
    const p = new SyntaxStream(selected)
    p.push(
      begin +
        line(first) +
        line({ ...second, units: [unit('o', '书页', 'invented-role')] }) +
        '{"type":"patch",}' +
        line(second) +
        line({ type: 'done', summary: '完成。' })
    )
    expect(p.analysis?.relations).toHaveLength(2)
    expect(p.drainIssues().map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
      { sequence: 1, kind: 'validation' },
      { sequence: 2, kind: 'json' }
    ])
    expect(() => p.finish()).toThrow('未修复')
  })

  it('never commits a rejected unit for a later relation to reference', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    p.push(line({ ...second, units: [unit('o', '不存在', 'object')] }))
    p.push(line({ ...second, units: [] }))
    expect(p.analysis?.spans).toHaveLength(2)
    expect(p.analysis?.relations).toHaveLength(1)
    expect(p.drainIssues().map((issue) => issue.kind)).toEqual(['validation', 'validation'])
    p.push(line(second))
    expect(p.analysis?.relations).toHaveLength(2)
  })

  it('records non-JSON material without interpreting it as linguistic structure', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + '下面是分析。\n' + line(first) + '结束。')
    expect(p.analysis?.spans).toHaveLength(2)
    expect(() => p.finish()).toThrow('未修复')
    expect(p.drainIssues().map((issue) => issue.kind)).toEqual(['framing', 'framing'])
  })

  it('recovers at an illegal literal string newline without guessing the missing quote', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first) + '{"type":"patch","summary":"断开的字符串\n' + line(second))
    expect(p.analysis?.relations).toHaveLength(2)
    expect(p.drainIssues()).toMatchObject([{ kind: 'json', recoverable: true }])
  })

  it('leaves an unfinished ambiguous boundary buffered and rejects completion at EOF', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    const valid = p.analysis
    p.push('{"type":"patch","units":[')
    expect(p.drainIssues()).toEqual([])
    expect(p.analysis).toBe(valid)
    expect(() => p.finish()).toThrow('未修复')
    expect(p.drainIssues()).toMatchObject([{ kind: 'json', recoverable: false }])
    expect(p.analysis).toBe(valid)
  })

  it('rejects trailing data after done while retaining the completed visible graph', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first) + line({ type: 'done', summary: '完成。' }))
    const valid = p.analysis
    p.push(JSON.stringify(second))
    expect(p.analysis).toBe(valid)
    expect(p.drainIssues()).toMatchObject([{ kind: 'protocol' }])
    expect(() => p.finish()).toThrow('未修复')
  })

  it('does not turn a missing or unsupported stream begin into an implicit success', () => {
    for (const invalid of [first, { type: 'begin', version: 2 }, { type: 'begin', version: 99 }]) {
      const p = new SyntaxStream(selected)
      p.push(line(invalid) + begin + line(first) + line({ type: 'done', summary: '完成。' }))
      expect(p.analysis?.spans).toHaveLength(2)
      expect(p.drainIssues()).toMatchObject([{ kind: 'protocol' }])
      expect(() => p.finish()).toThrow('未修复')
    }
  })

  it('keeps global resource failures fatal while retaining already validated relations', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    const valid = p.analysis
    expect(() => p.push(' '.repeat(1024 * 1024))).toThrow('接收上限')
    expect(() => p.push(line(second))).toThrow('接收上限')
    expect(() => p.finish()).toThrow('接收上限')
    expect(p.analysis).toBe(valid)
  })

  it('bounds an object whose closing delimiter never arrives', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    expect(() => p.push('{"x":"' + 'x'.repeat(256 * 1024))).toThrow('单批过大')
    expect(p.analysis?.spans).toHaveLength(2)
  })

  it('bounds repeated invalid packets even when the caller drains their notifications', () => {
    const p = new SyntaxStream(selected)
    p.push(begin + line(first))
    for (let i = 0; i < 256; i++) {
      p.push('{"type":"unknown"}')
      expect(p.drainIssues()).toHaveLength(1)
    }
    expect(() => p.push('{"type":"unknown"}')).toThrow('异常批次过多')
    expect(p.analysis?.spans).toHaveLength(2)
    expect(() => p.finish()).toThrow('异常批次过多')
  })
})
it('requires five continuous visible seconds; hidden time, quick revisits and suspended clocks do not count', () => {
  const d = new SyntaxDwell()
  for (let n = 500; n <= 5000; n += 500) expect(d.tick(n, ['a'], true)).toEqual([])
  expect(d.tick(5500, ['a'], true)).toEqual(['a'])
  d.tick(6000, [], true)
  expect(d.tick(6500, ['a'], true)).toEqual([])
  expect(d.tick(90000, ['a'], true)).toEqual([])
  d.tick(90500, ['a'], false)
  expect(d.tick(91000, ['a'], true)).toEqual([])
})
