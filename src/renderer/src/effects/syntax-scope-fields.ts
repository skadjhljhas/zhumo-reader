import type { SyntaxAnalysis, SyntaxRelation, SyntaxStatus } from '../../../shared/ai-types'
import { syntaxProjection } from '../../../shared/syntax-view'
import type { SyntaxLightBand } from './syntax-light-geometry'

export interface ScopeFieldRect {
  x: number
  y: number
  width: number
  height: number
}
export interface ScopeFieldFragment extends ScopeFieldRect {
  key: string
  sourceKeys: string[]
  unitIds: string[]
}
export interface ScopeFieldNode {
  id: string
  identity: string
  parentId?: string
  ancestors: string[]
  /** Root-to-node semantic depth. Never clamped to available display lanes. */
  depth: number
  family: 'negation' | 'quantifier' | 'modal' | 'perspective' | 'scope'
  status: SyntaxStatus
  operator: {
    unitId: string
    quote: string | null
    anchors: Array<{ quote: string; occurrence: number }>
    fragments: ScopeFieldFragment[]
  }
  coverage: ScopeFieldFragment[]
  /** Includes descendant geometry so non-isomorphic surface placement is not cut away. */
  mask: ScopeFieldRect[]
  children: ScopeFieldNode[]
  hue: number
  focus: number
}
export interface ScopeSpectrumToken {
  id: string
  text: string
  depth: number
  hue: number
  /** Empty when no measured whitespace can accommodate the complete spectrum. */
  position?: { x: number; y: number }
}
export interface ScopeSpectrum {
  rootId: string
  tokens: ScopeSpectrumToken[]
  placement: 'margin' | 'below' | 'above' | 'unplaced'
  box?: ScopeFieldRect
}
export interface SyntaxScopeFields {
  roots: ScopeFieldNode[]
  nodes: ScopeFieldNode[]
  spectra: ScopeSpectrum[]
  /** Only visible scope/perspective coverage replaces an existing envelope body. */
  representedRelationIds: string[]
  ink: ScopeFieldRect[]
  bounds?: ScopeFieldRect
  readingId?: string
  readingLabel?: string
  hasAlternatives: boolean
  omitted: Array<{ id: string; reason: 'duplicate-id' | 'missing-unit' | 'invalid-parent' }>
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const number = (n: number): string => n.toFixed(3)
const rectKey = (r: ScopeFieldRect): string => [r.x, r.y, r.width, r.height].map(number).join(':')
function uniqueRects(rects: ScopeFieldRect[]): ScopeFieldRect[] {
  return [...new Map(rects.map((r) => [rectKey(r), r])).values()]
}
function bounds(rects: ScopeFieldRect[]): ScopeFieldRect | undefined {
  if (!rects.length) return
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y
  }
}
function usable(band: SyntaxLightBand): boolean {
  return (
    [band.x, band.y, band.top, band.width, band.height].every(finite) &&
    Number.isInteger(band.index) &&
    band.width > 0 &&
    band.height > 0 &&
    (!finite(band.inkTop) || !finite(band.inkBottom) || band.inkBottom > band.inkTop)
  )
}
function inkRect(band: SyntaxLightBand): ScopeFieldRect {
  const y = finite(band.inkTop) ? band.inkTop : band.top
  const bottom = finite(band.inkBottom) ? band.inkBottom : band.top + band.height
  return { x: band.x, y, width: band.width, height: Math.max(0.5, bottom - y) }
}
function litRect(band: SyntaxLightBand): ScopeFieldRect {
  const ink = inkRect(band)
  const above = finite(band.roomAbove) ? Math.max(0, Math.min(14, band.roomAbove * 0.45)) : 0
  const below = finite(band.roomBelow) ? Math.max(0, Math.min(14, band.roomBelow * 0.45)) : 0
  return { ...ink, y: ink.y - above, height: ink.height + above + below }
}
function fragments(
  ids: string[],
  indexById: Map<string, number>,
  bands: SyntaxLightBand[],
  prefix: string
): ScopeFieldFragment[] {
  const result: ScopeFieldFragment[] = []
  for (const id of ids)
    for (const band of bands.filter((b) => b.index === indexById.get(id))) {
      const rect = litRect(band)
      // Deduplicate exact coincident fragments, but never bridge separate anchors/printed rows.
      const existing = result.find((r) => rectKey(r) === rectKey(rect))
      if (existing) {
        if (!existing.sourceKeys.includes(band.key)) existing.sourceKeys.push(band.key)
        if (!existing.unitIds.includes(id)) existing.unitIds.push(id)
      } else
        result.push({
          ...rect,
          key: prefix + ':' + band.key,
          sourceKeys: [band.key],
          unitIds: [id]
        })
    }
  return result.sort((a, b) => a.y - b.y || a.x - b.x)
}
function hash(text: string): number {
  let value = 2166136261
  for (const letter of text) value = Math.imul(value ^ letter.charCodeAt(0), 16777619)
  return value >>> 0
}
function textWidth(text: string): number {
  // Deliberately conservative, not claimed as font measurement. The component clips each
  // spectrum to its admitted whitespace; no textLength squeezing or unreadable tiny fallback.
  return [...text].reduce(
    (width, letter) =>
      width + (/\p{Mark}/u.test(letter) ? 0 : letter.codePointAt(0)! <= 0x7f ? 11 : 12),
    0
  )
}
const intersects = (a: ScopeFieldRect, b: ScopeFieldRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
function spectrum(
  root: ScopeFieldNode,
  bands: SyntaxLightBand[],
  used: ScopeFieldRect[]
): ScopeSpectrum {
  const ordered: ScopeFieldNode[] = []
  const visit = (node: ScopeFieldNode): void => {
    ordered.push(node)
    node.children.forEach(visit)
  }
  visit(root)
  const tokens: ScopeSpectrumToken[] = ordered.map((node) => ({
    id: node.id,
    text: node.operator.quote ?? '〔隐含〕',
    depth: node.depth,
    hue: node.hue
  }))
  const result: ScopeSpectrum = { rootId: root.id, tokens, placement: 'unplaced' }
  const visibleKeys = new Set(
    ordered
      .flatMap((node) => [...node.coverage, ...node.operator.fragments])
      .flatMap((f) => f.sourceKeys)
  )
  const local = bands.filter((b) => visibleKeys.has(b.key))
  if (!local.length) return result
  const localBounds = bounds(local.map(inkRect))!
  const fontHeight = 12,
    row = 15
  const right = Math.max(
    ...bands.map((b) => (finite(b.inkRight) ? Math.max(b.inkRight, b.x + b.width) : b.x + b.width))
  )
  // Missing clipRight means there is no evidence for a safe margin.
  const clips = bands.map((b) => b.clipRight)
  if (clips.every(finite)) {
    const x = right + 12
    const width = Math.max(...tokens.map((t) => textWidth(t.text) + t.depth * 8)) + 4
    const height = tokens.length * row
    const first = local.reduce((a, b) => (inkRect(a).y < inkRect(b).y ? a : b))
    const last = local.reduce((a, b) =>
      inkRect(a).y + inkRect(a).height > inkRect(b).y + inkRect(b).height ? a : b
    )
    const low = Math.max(
      0,
      localBounds.y - (finite(first.roomAbove) ? Math.max(0, first.roomAbove) : 0)
    )
    const high =
      localBounds.y +
      localBounds.height +
      (finite(last.roomBelow) ? Math.max(0, last.roomBelow) : 0)
    const y = Math.max(low, Math.min(localBounds.y, high - height))
    const box = { x, y, width, height }
    if (
      x + width <= Math.min(...clips) &&
      y + height <= high &&
      !used.some((r) => intersects(r, box))
    ) {
      result.placement = 'margin'
      result.box = box
      used.push(box)
      tokens.forEach((token, i) => {
        token.position = { x: x + token.depth * 8, y: y + fontHeight + i * row }
      })
      return result
    }
  }
  // A one-line fallback is only truthful for a chain. Siblings must never be serialized as
  // if one semantically enclosed the other.
  if (ordered.some((node) => node.children.length > 1)) return result
  const last = local.reduce((a, b) =>
    inkRect(a).y + inkRect(a).height > inkRect(b).y + inkRect(b).height ? a : b
  )
  const lastInk = inkRect(last)
  const width = tokens.reduce((w, t) => w + textWidth(t.text), 0) + (tokens.length - 1) * 15 + 4
  const clip = last.clipRight
  const box = { x: localBounds.x, y: lastInk.y + lastInk.height + 2, width, height: row }
  if (
    finite(last.roomBelow) &&
    last.roomBelow >= row + 4 &&
    finite(clip) &&
    box.x + width <= clip &&
    !used.some((r) => intersects(r, box))
  ) {
    result.placement = 'below'
    result.box = box
    used.push(box)
    let x = box.x
    tokens.forEach((token) => {
      token.position = { x, y: box.y + fontHeight }
      x += textWidth(token.text) + 15
    })
    return result
  }
  // In a narrow reader the measured whitespace above the first printed row can be the
  // only available caption space. Do not borrow a later line's clearance or move the prose.
  const firstTop = Math.min(...local.map((band) => inkRect(band).y))
  const firstLine = local.filter((band) => Math.abs(inkRect(band).y - firstTop) < 0.5)
  const aboveRooms = firstLine.map((band) => band.roomAbove)
  const aboveClips = firstLine.map((band) => band.clipRight)
  const aboveBox = {
    x: Math.min(...firstLine.map((band) => band.x)),
    y: firstTop - row - 2,
    width,
    height: row
  }
  if (
    aboveRooms.every(finite) &&
    Math.min(...aboveRooms) >= row + 4 &&
    aboveClips.every(finite) &&
    aboveBox.x + width <= Math.min(...aboveClips) &&
    aboveBox.y >= 0 &&
    !used.some((r) => intersects(r, aboveBox))
  ) {
    result.placement = 'above'
    result.box = aboveBox
    used.push(aboveBox)
    let x = aboveBox.x
    tokens.forEach((token) => {
      token.position = { x, y: aboveBox.y + fontHeight }
      x += textWidth(token.text) + 15
    })
  }
  return result
}

/** Geometry projects only actual scope/perspective edges. No word-order, containment, regex
 * quantifier inference, hover, clock, DOM mutation or API request participates in this function. */
export function syntaxScopeFields(
  analysis: SyntaxAnalysis,
  bands: SyntaxLightBand[],
  reading = ''
): SyntaxScopeFields {
  const view = syntaxProjection(analysis, reading)
  const visibleUnitIndices = new Set(view.units.map((u) => u.index))
  const geometry = bands.filter((band) => usable(band) && visibleUnitIndices.has(band.index))
  const result: SyntaxScopeFields = {
    roots: [],
    nodes: [],
    spectra: [],
    representedRelationIds: [],
    ink: uniqueRects(geometry.map(inkRect)),
    ...(view.reading ? { readingId: view.reading.id, readingLabel: view.reading.label } : {}),
    hasAlternatives: (analysis.readings?.length ?? 0) > 1,
    omitted: []
  }
  const scopes = view.relations.filter((r) => r.kind === 'scope' || r.kind === 'perspective')
  const unitById = new Map(view.units.map((u) => [u.id, u]))
  const indexById = new Map(view.units.map((u) => [u.id, u.index]))
  const relationById = new Map<string, SyntaxRelation>()
  const duplicate = new Set<string>()
  for (const relation of scopes) {
    if (relationById.has(relation.id)) duplicate.add(relation.id)
    relationById.set(relation.id, relation)
  }
  const valid = new Map<string, boolean>()
  const check = (id: string, path = new Set<string>()): boolean => {
    if (valid.has(id)) return valid.get(id)!
    const relation = relationById.get(id)
    if (!relation || duplicate.has(id) || path.has(id)) return false
    const seen = new Set([...path, id])
    const ok =
      [relation.from, ...relation.to].every((key) => unitById.has(key)) &&
      (!relation.within || check(relation.within, seen))
    valid.set(id, ok)
    return ok
  }
  for (const [id, relation] of relationById) {
    if (check(id)) continue
    result.omitted.push({
      id,
      reason: duplicate.has(id)
        ? 'duplicate-id'
        : [relation.from, ...relation.to].some((key) => !unitById.has(key))
          ? 'missing-unit'
          : 'invalid-parent'
    })
  }
  const nodes = new Map<string, ScopeFieldNode>()
  for (const [id, relation] of relationById) {
    if (!valid.get(id)) continue
    const span = unitById.get(relation.from)!.span
    const anchors =
      span.anchors?.map(({ quote, occurrence }) => ({ quote, occurrence })) ??
      (span.implicit ? [] : [{ quote: span.quote, occurrence: span.occurrence }])
    const quote = anchors.length ? anchors.map((a) => a.quote).join('…') : null
    const identity = JSON.stringify([
      id,
      relation.from,
      anchors.map((a) => [a.quote, a.occurrence])
    ])
    const identityHash = hash(identity)
    const ancestors: string[] = []
    let parent = relation.within
    while (parent) {
      ancestors.unshift(parent)
      parent = relationById.get(parent)?.within
    }
    const family: ScopeFieldNode['family'] =
      relation.kind === 'perspective'
        ? 'perspective'
        : ['negation', 'quantifier', 'modal'].includes(span.role)
          ? (span.role as ScopeFieldNode['family'])
          : 'scope'
    nodes.set(id, {
      id,
      identity,
      ...(relation.within ? { parentId: relation.within } : {}),
      ancestors,
      depth: ancestors.length,
      family,
      status: relation.status,
      operator: {
        unitId: relation.from,
        quote,
        anchors,
        fragments: fragments([relation.from], indexById, geometry, id + ':operator')
      },
      coverage: fragments(relation.to, indexById, geometry, id + ':coverage'),
      mask: [],
      children: [],
      hue:
        (family === 'negation'
          ? 294
          : family === 'perspective'
            ? 268
            : family === 'quantifier'
              ? 206
              : 190) +
        ((identityHash * 0.61803398875) % (family === 'quantifier' ? 44 : 32)),
      focus: 0.3 + (identityHash % 997) / 2492.5
    })
  }
  for (const node of nodes.values()) {
    if (node.parentId) nodes.get(node.parentId)!.children.push(node)
    else result.roots.push(node)
  }
  const lexicalOrder = (a: ScopeFieldNode, b: ScopeFieldNode): number =>
    (unitById.get(a.operator.unitId)?.span.start ?? Infinity) -
      (unitById.get(b.operator.unitId)?.span.start ?? Infinity) || a.id.localeCompare(b.id)
  const finish = (node: ScopeFieldNode): ScopeFieldRect[] => {
    result.nodes.push(node)
    node.children.sort(lexicalOrder)
    node.mask = uniqueRects(
      [...node.coverage, ...node.operator.fragments, ...node.children.flatMap(finish)].map(
        ({ x, y, width, height }) => ({ x, y, width, height })
      )
    )
    return node.mask
  }
  result.roots.sort(lexicalOrder).forEach(finish)
  result.representedRelationIds = result.nodes
    .filter((node) => node.coverage.length > 0)
    .map((node) => node.id)
  result.bounds = bounds(result.roots.flatMap((r) => r.mask))
  const used: ScopeFieldRect[] = []
  result.spectra = result.roots.map((root) => spectrum(root, geometry, used))
  return result
}
