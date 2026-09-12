import { it, expect } from 'vitest'
import { SYNTAX_READING_EXAMPLES as examples } from '../src/shared/syntax-reading-examples'
import { syntaxOpticalPlan } from '../src/renderer/src/effects/syntax-optics'
import { parseSyntaxAnalysis, type SyntaxAnalysis } from '../src/shared/ai-types'
import type { SyntaxLightBand } from '../src/renderer/src/effects/syntax-light-geometry'
const bands = (analysis: SyntaxAnalysis): SyntaxLightBand[] =>
  analysis.spans
    .filter((s) => !s.implicit)
    .flatMap((span) =>
      (span.anchors ?? [span]).map((a, i) => ({
        x: 30 + a.start * 12,
        y: 60,
        top: 30,
        width: (a.end - a.start) * 12,
        height: 30,
        index: analysis.spans.indexOf(span),
        key: span.id + '-' + i,
        first: true,
        last: true
      }))
    )
it('renders explicit not-all and all-not scope orders differently without any hover or clock input', () => {
  const first = syntaxOpticalPlan(examples[0].analysis, bands(examples[0].analysis))
  const second = syntaxOpticalPlan(examples[1].analysis, bands(examples[1].analysis))
  expect(first.relations.map((r) => [r.family, r.level])).toEqual([
    ['negation', 1],
    ['quantifier', 0]
  ])
  expect(second.relations.map((r) => [r.family, r.level])).toEqual([
    ['quantifier', 1],
    ['negation', 0]
  ])
  expect(first.scopeFields!.roots[0].family).toBe('negation')
  expect(second.scopeFields!.roots[0].family).toBe('quantifier')
  expect(first.scopeFields!.representedRelationIds).toHaveLength(2)
  expect(first.relations.every((r) => !r.beams.length)).toBe(true)
  expect(first.marks).toHaveLength(0)
})
it('does not invent semantic nesting from containment of printed ranges', () => {
  const analysis = {
    ...examples[0].analysis,
    relations: examples[0].analysis.relations!.map(({ within: _within, ...r }) => {
      void _within
      return r
    })
  }
  expect(syntaxOpticalPlan(analysis, bands(analysis)).relations.every((r) => r.level === 0)).toBe(
    true
  )
})
it('keeps tight-line connecting cores in the measured whitespace instead of the preceding sentence', () => {
  const analysis = examples[4].analysis
  const geometry = bands(analysis).map((b) => ({
    ...b,
    inkTop: b.top,
    inkBottom: b.y - 2,
    roomAbove: 5,
    roomBelow: 5
  }))
  const plan = syntaxOpticalPlan(analysis, geometry)
  for (const relation of plan.relations)
    for (const beam of relation.beams) {
      const points = [...beam.body.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((match) =>
        Number(match[2])
      )
      expect(Math.min(...points)).toBeGreaterThanOrEqual(25)
      expect(Math.max(...points)).toBeLessThanOrEqual(30)
    }
})
it('connects the controller selected by analysis, even when a different name is closer', () => {
  const promise = syntaxOpticalPlan(examples[2].analysis, bands(examples[2].analysis))
  const persuade = syntaxOpticalPlan(examples[3].analysis, bands(examples[3].analysis))
  expect(promise.relations[0].members).toEqual(['leave', 'lin'])
  expect(persuade.relations[0].members).toEqual(['leave', 'chen'])
  expect(promise.relations[0].beams[0].end.x).toBeLessThan(persuade.relations[0].beams[0].end.x)
  expect(promise.marks).toHaveLength(2)
})
it('keeps two reference chains distinct and uses the actual margin when reflow separates lines', () => {
  const analysis = examples[4].analysis,
    geometry = bands(analysis)
  for (const b of geometry)
    if (b.index >= 2) {
      b.top = 90
      b.y = 120
      b.x -= 120
    }
  const plan = syntaxOpticalPlan(analysis, geometry, '', '', 500)
  expect(plan.relations.map((r) => r.members)).toEqual([
    ['latter', 'chen'],
    ['it', 'letter']
  ])
  expect(plan.relations.every((r) => r.beams.length > 0)).toBe(true)
  expect(plan.relations[0].beams[0].body).not.toBe(plan.relations[1].beams[0].body)
  const [person, letter] = plan.relations.map((r) => r.beams[0])
  expect(Math.abs(person.gradient!.start.x - letter.gradient!.start.x)).toBeGreaterThanOrEqual(16)
  for (const beam of [person, letter]) {
    expect(beam.parts?.map((p) => p.part)).toEqual(['entry', 'corridor', 'exit'])
    const [entry, corridor, exit] = beam.parts!
    expect(entry.gradient!.start.x).not.toBe(entry.gradient!.end.x)
    expect(exit.gradient!.start.x).not.toBe(exit.gradient!.end.x)
    expect(corridor.gradient!.start.x).toBe(corridor.gradient!.end.x)
    expect(entry.start).toEqual(beam.start)
    expect(exit.end).toEqual(beam.end)
  }
})
it('keeps the whole middle of a cross-line connection beyond unselected intervening text', () => {
  const analysis = examples[2].analysis
  const geometry = bands(analysis).map((b, index) => ({
    ...b,
    x: index ? 360 : 60,
    top: index ? 160 : 20,
    y: index ? 192 : 52,
    width: 30,
    height: 30,
    roomAbove: 12,
    roomBelow: 12
  }))
  const path = syntaxOpticalPlan(analysis, geometry, '', '', 800).relations[0].beams[0]
  const middle = [...path.body.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
    .filter((p) => p.y > 60 && p.y < 150)
  expect(middle.length).toBeGreaterThan(0)
  expect(Math.min(...middle.map((p) => p.x))).toBeGreaterThan(804)
  expect(path.gradient?.start.x).toBe(path.gradient?.end.x)
  expect(path.gradient?.start.y).not.toBe(path.gradient?.end.y)
})
it('keeps native word marks instead of drawing a connector through text when no margin exists', () => {
  const analysis = examples[2].analysis
  const geometry = bands(analysis).map((b, index) => ({
    ...b,
    x: index ? 360 : 60,
    top: index ? 160 : 20,
    y: index ? 192 : 52,
    width: 30,
    height: 30,
    inkRight: 800,
    clipRight: 805
  }))
  const plan = syntaxOpticalPlan(analysis, geometry)
  expect(plan.relations[0].beams).toHaveLength(0)
  expect(plan.marks).toHaveLength(2)
  expect(new Set(plan.marks.map((m) => m.phase)).size).toBe(1)
})
it('isolates competing focus readings and never paints an implicit word', () => {
  const focus = examples[6].analysis
  const a = syntaxOpticalPlan(focus, bands(focus), 'recipient_reading')
  const b = syntaxOpticalPlan(focus, bands(focus), 'activity_reading')
  expect(a.relations.map((r) => r.id)).toEqual(['recipient'])
  expect(b.relations.map((r) => r.id)).toEqual(['activity'])
  expect(a.relations[0].beams[0].body).not.toBe(b.relations[0].beams[0].body)
  const ellipsis = examples[7].analysis,
    plan = syntaxOpticalPlan(ellipsis, bands(ellipsis))
  expect(plan.marks.some((m) => ellipsis.spans[m.band.index].implicit)).toBe(false)
  expect(plan.relations.find((r) => r.id === 'omission')?.members).toEqual([
    'buy',
    'chen',
    'coffee'
  ])
})
it('rejects cyclic, missing and cross-reading scope parents before optical projection', () => {
  const base = examples[0].analysis
  const raw = { ...base, units: base.spans, relations: base.relations!.map((r) => ({ ...r })) }
  raw.relations[0].within = raw.relations[1].id
  expect(() => parseSyntaxAnalysis(JSON.stringify(raw), base.text)).toThrow('成环')
  raw.relations[0].within = 'missing'
  expect(() => parseSyntaxAnalysis(JSON.stringify(raw), base.text)).toThrow('已存在')
  delete raw.relations[0].within
  const withBranches = {
    ...raw,
    readings: [
      {
        id: 'a',
        label: '甲',
        units: [],
        relations: ['outer_not'],
        explanation: '甲读法',
        conditions: '甲语境'
      },
      {
        id: 'b',
        label: '乙',
        units: [],
        relations: ['inner_all'],
        explanation: '乙读法',
        conditions: '乙语境'
      }
    ]
  }
  expect(() => parseSyntaxAnalysis(JSON.stringify(withBranches), base.text)).toThrow('另一候选')
})
