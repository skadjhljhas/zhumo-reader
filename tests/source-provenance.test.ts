import { describe, expect, it, vi } from 'vitest'
import { preprocess } from '../src/renderer/src/parser/preprocess'
import type { SourceLine } from '../src/renderer/src/parser/types'
import { protectMathSource } from '../src/renderer/src/parser/protect-math'

function originalAt(source: string, map: SourceLine, offset: number): string {
  return source.slice(map.starts[offset], map.ends[offset])
}

/** Every displayed source character is literal or belongs to one complete,
 * explicitly rewritten annotation marker. Never bridge a removed definition.
 */
function checkLines(source: string, lines: string[], maps: SourceLine[]): void {
  expect(maps.length).toBe(lines.length)
  lines.forEach((line, index) => {
    const map = maps[index]
    expect(map.starts).toHaveLength(line.length)
    expect(map.ends).toHaveLength(line.length)
    for (let column = 0; column < line.length; column++) {
      expect(map.starts[column]).toBeGreaterThanOrEqual(0)
      expect(map.ends[column]).toBeLessThanOrEqual(source.length)
      expect(map.ends[column]).toBeGreaterThan(map.starts[column])
      const original = originalAt(source, map, column)
      if (original === line[column]) continue
      let from = column,
        to = column + 1
      while (from > 0 && map.starts[from - 1] === map.starts[column]) from--
      while (to < line.length && map.starts[to] === map.starts[column]) to++
      expect(line.slice(from, to)).toMatch(/^\[\^(?:auto-\d+|注\d+)\]$/)
      expect(original).toMatch(/^(?:\^\[|[【[]注\d+[】\]])/)
    }
  })
}

function check(source: string): ReturnType<typeof preprocess> {
  const plain = preprocess(source)
  const tracked = preprocess(source, { trackContent: true })
  const { bodySources, definitions, ...rest } = tracked
  const withoutProvenance = (value: object): object =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'source' && key !== 'lineSources')
    )
  expect({
    ...rest,
    definitions: definitions.map(withoutProvenance),
    bodyRefs: rest.bodyRefs.map(withoutProvenance),
    noteRefs: rest.noteRefs.map(withoutProvenance)
  }).toEqual(plain)
  expect(plain.bodySources).toBeUndefined()
  expect(plain.definitions.every((def) => !def.lineSources)).toBe(true)
  checkLines(source, tracked.bodyLines, bodySources!)
  for (const def of definitions) checkLines(source, def.lines, def.lineSources!)
  return tracked
}

describe('rewritten manuscript character provenance', () => {
  it('keeps identical body and annotation sentences tied to their own occurrence', () => {
    const source = '同一句。[^甲]\n\n[^甲]: 同一句。\n\n同一句。\n\n[^乙]: 同一句。'
    const pre = check(source)
    const body = pre.bodyLines
      .map((line, index) => ({ line, map: pre.bodySources![index] }))
      .filter(({ line }) => line.startsWith('同一句'))
    expect(body.map(({ map }) => map.starts[0])).toEqual([0, source.lastIndexOf('\n同一句') + 1])
    for (const label of ['甲', '乙']) {
      const def = pre.definitions.find((def) => def.label === label)!
      expect(def.lineSources![0].starts[0]).toBe(source.indexOf('[^' + label + ']: ') + 6)
    }
  })

  it('retains original positions on both sides of a multiline inline annotation', () => {
    const source = '之前^[第一行。\n第二行。]之后。\n下一段。'
    const pre = check(source)
    expect(pre.bodyLines[0]).toBe('之前[^auto-1]之后。')
    const map = pre.bodySources![0]
    expect(originalAt(source, map, 2)).toBe('^[第一行。\n第二行。]')
    expect(map.starts[pre.bodyLines[0].indexOf('之后')]).toBe(source.indexOf('之后'))
    expect(pre.definitions[0].lineSources![1].starts[0]).toBe(source.indexOf('第二行'))
  })

  it('traces nested inline notes back through an indented definition', () => {
    const source =
      '正文[^甲]。\n\n[^甲]: 父注^[里层^[更深。]尾声。]结束。\n    第二段^[支线。]回来。'
    const pre = check(source)
    const child = pre.definitions.find((def) => def.lines.join('\n') === '更深。')!
    expect(child.lineSources![0].starts[0]).toBe(source.indexOf('更深'))
    const parent = pre.definitions.find((def) => def.label === '甲')!
    expect(parent.lineSources![1].starts[0]).toBe(source.indexOf('第二段'))
    expect(parent.lineSources![1].starts.at(-1)).toBe(source.lastIndexOf('。'))
  })

  it.each(['\n', '\r\n', '\r'])(
    'uses input offsets with %j line endings and tab indentation',
    (eol) => {
      check(
        [
          '甲[注12]乙【注12】丙[^注12]。',
          '',
          '注12： 第一行😀。',
          '\t第二行 İ。',
          '',
          '正文收尾。'
        ].join(eol)
      )
    }
  )

  it('keeps literal annotation-looking code untouched', () => {
    const tick = String.fromCharCode(96)
    const source =
      '正文 ' +
      tick +
      '^[不是注]' +
      tick +
      '。\n\n' +
      tick.repeat(3) +
      'md\n[^甲]: 保留\n^[原样]\n' +
      tick.repeat(3) +
      '\n\n    【注1】 ^[也保留]\n\n[^真]: ' +
      tick +
      '[注2]' +
      tick
    check(source)
  })

  it('keeps the first definition and does not map body text across discarded definitions', () => {
    const source = '前文。\n[^甲]: 保留。\n[^甲]: 丢弃。\n后文。'
    const pre = check(source)
    expect(pre.definitions).toHaveLength(1)
    expect(pre.warnings).toHaveLength(1)
    const last = pre.bodySources!.at(-1)!
    expect(last.starts[0]).toBe(source.indexOf('后文'))
    expect(last.ends.at(-1)).toBe(source.length)
  })

  it('handles empty first definition lines and several blank continuation lines', () => {
    check(
      '正文[^甲]。\n\n[^甲]:\n\n    \n    第一段。\n\n\n    第二段。\n\n[^乙]:   \n    末段。\n'
    )
  })

  it('retains exact UTF-16 offsets through nested brackets, escaped marks and emoji', () => {
    check('😀 **加粗**与[链接](./另一本.md) &amp; \\[字面]。^[带[括号]的😀注释。]尾声。')
  })

  it('tracks interrupted or unclosed inline notes without inventing an end position', () => {
    const tick = String.fromCharCode(96).repeat(3)
    for (const source of [
      '正文^[未闭合。',
      '正文^[未闭合。\n[^甲]: 定义。',
      '正文^[未闭合。\n' + tick + '\n代码。\n' + tick,
      '正文^[未闭合。\n',
      '正文^[\n\n'
    ])
      check(source)
  })

  it('preserves the position after the inline-note line limit is reached', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const source = '开头^[内容。\n' + '续行。\n'.repeat(51) + '后续正文。'
      const pre = check(source)
      expect(pre.bodySources!.at(-1)!.starts[0]).toBe(source.indexOf('后续正文'))
    } finally {
      warn.mockRestore()
    }
  })

  it('composes with length-preserving math protection', () => {
    const source = '正文 $x^{[注1]}$ 尾声^[旁注 $y^{[^甲]}$。]。\n\n[^甲]: 其他。'
    const math = protectMathSource(source)
    const pre = check(math.source)
    expect(math.source).toHaveLength(source.length)
    const line = math.restore(pre.bodyLines[0])
    expect(pre.bodySources![0].starts[line.indexOf('尾声')]).toBe(source.indexOf('尾声'))
  })
})
