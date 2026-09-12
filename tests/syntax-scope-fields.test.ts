import { it, expect } from 'vitest'
import type { SyntaxAnalysis, SyntaxRelation, SyntaxSpan } from '../src/shared/ai-types'
import type { SyntaxLightBand } from '../src/renderer/src/effects/syntax-light-geometry'
import { syntaxScopeFields } from '../src/renderer/src/effects/syntax-scope-fields'

function span(
  id: string,
  role: SyntaxSpan['role'],
  quote: string,
  start: number,
  occurrence = 1
): SyntaxSpan {
  return {
    id,
    label: id,
    role,
    quote,
    start,
    end: start + quote.length,
    occurrence,
    depth: 0,
    anchors: [{ quote, start, end: start + quote.length, occurrence }],
    layer: 'meaning',
    status: 'supported',
    explanation: id,
    evidence: id
  }
}
function edge(id: string, from: string, to: string[], within?: string): SyntaxRelation {
  return {
    id,
    kind: 'scope',
    from,
    to,
    ...(within ? { within } : {}),
    status: 'supported',
    label: id,
    explanation: id,
    evidence: id
  }
}
function nested(count = 4): SyntaxAnalysis {
  return {
    version: 2,
    text: '不'.repeat(count) + '读。',
    summary: 'An explicit scope-tree fixture, not a model inference.',
    spans: [
      ...Array.from({ length: count }, (_, i) => span('o' + i, 'negation', '不', i, i + 1)),
      span('read', 'predicate', '读', count)
    ],
    relations: Array.from({ length: count }, (_, i) =>
      edge('s' + i, 'o' + i, ['read'], i ? 's' + (i - 1) : undefined)
    ),
    readings: []
  }
}
function bands(analysis: SyntaxAnalysis): SyntaxLightBand[] {
  return analysis.spans.flatMap((s, index) =>
    (s.anchors ?? []).map((a, i) => ({
      index,
      key: s.id + '-' + i,
      x: 20 + a.start * 18,
      y: 60,
      top: 34,
      width: (a.end - a.start) * 18,
      height: 26,
      inkTop: 34,
      inkBottom: 60,
      roomAbove: 32,
      roomBelow: 32,
      inkRight: 380,
      clipRight: 950
    }))
  )
}
it('projects the four actual operator quotes without inventing a quantifier subtype', () => {
  const text = '并非每位编辑都没有读过至少一篇来稿'
  const at = (id: string, role: SyntaxSpan['role'], quote: string): SyntaxSpan =>
    span(id, role, quote, text.indexOf(quote))
  const all = at('all', 'quantifier', '每位')
  all.anchors!.push({
    quote: '都',
    occurrence: 1,
    start: text.indexOf('都'),
    end: text.indexOf('都') + 1
  })
  const analysis: SyntaxAnalysis = {
    version: 2,
    text,
    summary: 'fixture',
    spans: [
      at('n0', 'negation', '并非'),
      all,
      at('n1', 'negation', '没有'),
      at('some', 'quantifier', '至少一篇'),
      at('read', 'predicate', '读过')
    ],
    relations: [
      edge('N0', 'n0', ['read']),
      edge('Qx', 'all', ['read'], 'N0'),
      edge('N1', 'n1', ['read'], 'Qx'),
      edge('Qy', 'some', ['read'], 'N1')
    ]
  }
  const fields = syntaxScopeFields(analysis, bands(analysis))
  expect(fields.nodes.map((n) => [n.id, n.operator.quote, n.depth, n.family])).toEqual([
    ['N0', '并非', 0, 'negation'],
    ['Qx', '每位…都', 1, 'quantifier'],
    ['N1', '没有', 2, 'negation'],
    ['Qy', '至少一篇', 3, 'quantifier']
  ])
  expect(fields.nodes[3].ancestors).toEqual(['N0', 'Qx', 'N1'])
  expect(fields.nodes[1].identity).not.toBe(fields.nodes[3].identity)
  expect(fields.nodes[1].hue).not.toBe(fields.nodes[3].hue)
  expect(fields.nodes[1]).not.toHaveProperty('quantifierType')
  expect(fields.representedRelationIds).toEqual(['N0', 'Qx', 'N1', 'Qy'])
})

it('keeps six explicit levels even when every relation targets the same printed range', () => {
  const analysis = nested(6),
    fields = syntaxScopeFields(analysis, bands(analysis))
  expect(fields.roots).toHaveLength(1)
  expect(fields.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4, 5])
  expect(fields.nodes[5].ancestors).toEqual(['s0', 's1', 's2', 's3', 's4'])
  expect(fields.nodes[5].operator.anchors).toEqual([{ quote: '不', occurrence: 6 }])
  expect(new Set(fields.nodes.map((n) => n.identity)).size).toBe(6)
  expect(fields.spectra[0].tokens.map((t) => t.depth)).toEqual([0, 1, 2, 3, 4, 5])
})

it('never infers nesting from range containment or overlap', () => {
  const analysis = nested(4)
  analysis.relations!.forEach((r) => {
    delete r.within
  })
  const fields = syntaxScopeFields(analysis, bands(analysis))
  expect(fields.roots).toHaveLength(4)
  expect(fields.nodes.every((n) => n.depth === 0 && n.children.length === 0)).toBe(true)
})

it('handles children before their parent and does not mutate the analysis or geometry', () => {
  const analysis = nested(5)
  analysis.relations!.reverse()
  const geometry = bands(analysis),
    before = JSON.stringify([analysis, geometry])
  expect(syntaxScopeFields(analysis, geometry).nodes.map((n) => n.id)).toEqual([
    's0',
    's1',
    's2',
    's3',
    's4'
  ])
  expect(JSON.stringify([analysis, geometry])).toBe(before)
})

it('isolates both semantic edges and branch-only geometry when changing readings', () => {
  const analysis = nested(2)
  analysis.spans.push(span('onlyA', 'referent', '不', 0))
  analysis.relations = [
    edge('a0', 'o0', ['read']),
    edge('a1', 'o1', ['read'], 'a0'),
    edge('b0', 'o1', ['read']),
    edge('b1', 'o0', ['read'], 'b0')
  ]
  analysis.readings = [
    {
      id: 'a',
      label: 'A',
      units: ['onlyA'],
      relations: ['a0', 'a1'],
      explanation: 'A',
      conditions: 'A'
    },
    { id: 'b', label: 'B', units: [], relations: ['b0', 'b1'], explanation: 'B', conditions: 'B' }
  ]
  const geometry = bands(analysis)
  geometry.at(-1)!.x = 90000
  const a = syntaxScopeFields(analysis, geometry, 'a'),
    b = syntaxScopeFields(analysis, geometry, 'b')
  expect(a.nodes.map((n) => n.id)).toEqual(['a0', 'a1'])
  expect(b.nodes.map((n) => n.id)).toEqual(['b0', 'b1'])
  expect(b.ink.every((r) => r.x < 1000)).toBe(true)
  expect(b).toMatchObject({ hasAlternatives: true, readingId: 'b', readingLabel: 'B' })
})

it('preserves separate actual line pieces instead of painting a paragraph bounding box', () => {
  const analysis = nested(1),
    geometry = bands(analysis)
  const first = { ...geometry[1], key: 'first-line', x: 110, width: 190 }
  const second = {
    ...geometry[1],
    key: 'second-line',
    x: 20,
    width: 80,
    y: 125,
    top: 99,
    inkTop: 99,
    inkBottom: 125
  }
  const fields = syntaxScopeFields(analysis, [geometry[0], first, second])
  expect(fields.nodes[0].coverage.map((r) => [r.x, r.width, r.sourceKeys])).toEqual([
    [110, 190, ['first-line']],
    [20, 80, ['second-line']]
  ])
  expect(fields.nodes[0].coverage[0].y + fields.nodes[0].coverage[0].height).toBeLessThan(
    fields.nodes[0].coverage[1].y
  )
})

it('deduplicates a coincident target fragment without losing its source identities', () => {
  const analysis = nested(1),
    geometry = bands(analysis)
  const fields = syntaxScopeFields(analysis, [
    ...geometry,
    { ...geometry[1], key: 'duplicate-rect' }
  ])
  expect(fields.nodes[0].coverage).toHaveLength(1)
  expect(fields.nodes[0].coverage[0].sourceKeys).toEqual([geometry[1].key, 'duplicate-rect'])
})

it('preserves descendant masks even when surface scope pieces are not spatially contained', () => {
  const analysis = nested(2),
    geometry = bands(analysis)
  geometry[1].x = 450
  const fields = syntaxScopeFields(analysis, geometry),
    outer = fields.nodes[0],
    inner = fields.nodes[1]
  expect(outer.coverage.every((r) => r.x < 450)).toBe(true)
  for (const rect of inner.mask) expect(outer.mask).toContainEqual(rect)
  expect(outer.children[0]).toBe(inner)
})

it('reports unplaced spectra rather than drawing over ink or flattening depth', () => {
  const analysis = nested(6)
  const geometry = bands(analysis).map((b) => ({
    ...b,
    roomAbove: 0,
    roomBelow: 0,
    clipRight: 380
  }))
  const fields = syntaxScopeFields(analysis, geometry)
  expect(fields.spectra[0].placement).toBe('unplaced')
  expect(fields.spectra[0].tokens).toHaveLength(6)
  expect(fields.spectra[0].tokens.every((t) => !t.position)).toBe(true)
  expect(fields.nodes.at(-1)!.depth).toBe(5)
})

it('uses a measured below-line fallback for chains but never serializes siblings as nesting', () => {
  const chain = nested(3)
  const geometry = bands(chain).map((b) => ({ ...b, inkRight: 400, clipRight: 400, roomBelow: 32 }))
  expect(syntaxScopeFields(chain, geometry).spectra[0].placement).toBe('below')
  chain.relations![2].within = 's0'
  const branching = syntaxScopeFields(chain, geometry)
  expect(branching.nodes.map((n) => n.depth)).toEqual([0, 1, 1])
  expect(branching.spectra[0].placement).toBe('unplaced')
})

it('places a whole chain above its first row when the measured narrow layout has no margin or space below', () => {
  const analysis = nested(4)
  const geometry = bands(analysis).map((b) => ({
    ...b,
    inkRight: 380,
    clipRight: 380,
    roomBelow: 0
  }))
  const result = syntaxScopeFields(analysis, geometry).spectra[0]
  expect(result.placement).toBe('above')
  expect(result.tokens.map((t) => t.depth)).toEqual([0, 1, 2, 3])
  expect(new Set(result.tokens.map((t) => t.position!.y)).size).toBe(1)
  expect(result.box!.y).toBeGreaterThanOrEqual(34 - 32)
  expect(result.box!.y + result.box!.height).toBeLessThan(34)
  expect(result.box!.x + result.box!.width).toBeLessThanOrEqual(380)
})

it.each(['short-gap', 'no-gap-measurement', 'narrow-clip', 'above-viewport'])(
  'does not invent above-line space for %s',
  (condition) => {
    const analysis = nested(4)
    const geometry = bands(analysis).map((b) => ({
      ...b,
      inkRight: 380,
      clipRight: condition === 'narrow-clip' ? 80 : 380,
      roomBelow: 0,
      roomAbove:
        condition === 'short-gap' ? 18 : condition === 'no-gap-measurement' ? undefined : 32,
      ...(condition === 'above-viewport' ? { y: 36, top: 10, inkTop: 10, inkBottom: 36 } : {})
    }))
    const result = syntaxScopeFields(analysis, geometry).spectra[0]
    expect(result.placement).toBe('unplaced')
    expect(result.tokens.every((t) => t.position === undefined)).toBe(true)
  }
)

it('uses the first row clearance rather than borrowing the last row gap for above placement', () => {
  const analysis = nested(2)
  const geometry = bands(analysis).map((b) => ({
    ...b,
    inkRight: 380,
    clipRight: 380,
    roomAbove: 0,
    roomBelow: 0,
    ...(b.index === 2 ? { top: 99, y: 125, inkTop: 99, inkBottom: 125, roomAbove: 32 } : {})
  }))
  expect(syntaxScopeFields(analysis, geometry).spectra[0].placement).toBe('unplaced')
})

it('places a margin spectrum beyond measured ink and keeps identities stable across reflow', () => {
  const analysis = nested(4),
    geometry = bands(analysis)
  const first = syntaxScopeFields(analysis, geometry)
  expect(first.spectra[0].placement).toBe('margin')
  expect(first.spectra[0].tokens.every((t) => t.position!.x > 380)).toBe(true)
  const moved = syntaxScopeFields(
    analysis,
    geometry.map((b) => ({
      ...b,
      x: b.x + 17,
      y: b.y + 30,
      top: b.top + 30,
      inkTop: b.inkTop! + 30,
      inkBottom: b.inkBottom! + 30
    }))
  )
  expect(moved.nodes.map((n) => [n.identity, n.hue, n.focus])).toEqual(
    first.nodes.map((n) => [n.identity, n.hue, n.focus])
  )
})

it('rejects cycles, missing parents and duplicate relation IDs without inventing roots', () => {
  const analysis = nested(3)
  analysis.relations![0].within = 's1'
  expect(syntaxScopeFields(analysis, bands(analysis)).roots).toHaveLength(0)
  analysis.relations![0].within = 'missing'
  expect(syntaxScopeFields(analysis, bands(analysis)).omitted).toHaveLength(3)
  delete analysis.relations![0].within
  analysis.relations!.push({ ...analysis.relations![0] })
  const duplicate = syntaxScopeFields(analysis, bands(analysis))
  expect(duplicate.roots).toHaveLength(0)
  expect(duplicate.omitted).toContainEqual({ id: 's0', reason: 'duplicate-id' })
})

it('does not reinterpret an unsupported role as a modal and keeps implicit operators explicit in the data', () => {
  const analysis = nested(2)
  analysis.spans[0].role = 'predicate'
  analysis.spans[1] = { ...analysis.spans[1], implicit: true, anchors: [], start: -1, end: -1 }
  analysis.relations![1].kind = 'perspective'
  const fields = syntaxScopeFields(analysis, bands(analysis))
  expect(fields.nodes.map((n) => n.family)).toEqual(['scope', 'perspective'])
  expect(fields.nodes[1].operator.quote).toBeNull()
  expect(fields.spectra[0].tokens[1].text).toBe('〔隐含〕')
})

it('drops unusable geometry and gracefully handles an analysis without scope relations', () => {
  const analysis = nested(1)
  const fields = syntaxScopeFields(
    analysis,
    bands(analysis).map((b) => ({ ...b, width: NaN }))
  )
  expect(fields.bounds).toBeUndefined()
  expect(fields.nodes[0].coverage).toEqual([])
  expect(fields.representedRelationIds).toEqual([])
  expect(fields.spectra[0].placement).toBe('unplaced')
  analysis.relations = []
  expect(syntaxScopeFields(analysis, bands(analysis)).roots).toEqual([])
})
