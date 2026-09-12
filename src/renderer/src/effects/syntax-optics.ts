import type { SyntaxAnalysis, SyntaxRelation, SyntaxRole } from '../../../shared/ai-types'
import { syntaxProjection } from '../../../shared/syntax-view'
import type { SyntaxLightBand } from './syntax-light-geometry'
import { SyntaxRouteLanes } from './syntax-route-lanes'
import { syntaxScopeFields, type SyntaxScopeFields } from './syntax-scope-fields'

export type OpticalFamily =
  | 'argument'
  | 'negation'
  | 'quantifier'
  | 'modal'
  | 'reference'
  | 'control'
  | 'perspective'
  | 'focus'
  | 'ellipsis'
  | 'contrast'
interface Point {
  x: number
  y: number
}
export interface OpticalBeam {
  key: string
  body: string
  core: string
  start: Point
  end: Point
  extent: 'link' | 'scope'
  route?: 'margin'
  gradient?: { start: Point; end: Point }
  part?: 'entry' | 'corridor' | 'exit'
  parts?: OpticalBeam[]
}
export interface OpticalRelation {
  id: string
  kind: SyntaxRelation['kind']
  family: OpticalFamily
  phase: number
  level: number
  status: SyntaxRelation['status']
  label: string
  members: string[]
  beams: OpticalBeam[]
  tone: number
}
export interface OpticalMark {
  band: SyntaxLightBand
  family: OpticalFamily
  governor: boolean
  clause: boolean
  active: boolean
  phase: number
  tone: number
}
export interface SyntaxOpticalPlan {
  marks: OpticalMark[]
  relations: OpticalRelation[]
  scopeFields?: SyntaxScopeFields
}
export const emptyOpticalPlan = (): SyntaxOpticalPlan => ({ marks: [], relations: [] })
const priority: Record<SyntaxRelation['kind'], number> = {
  scope: 8,
  perspective: 7,
  control: 6,
  reference: 6,
  focus: 6,
  ellipsis: 5,
  contrast: 5,
  dependency: 1
}
function family(relation: SyntaxRelation, role?: SyntaxRole): OpticalFamily {
  if (relation.kind === 'scope')
    return role === 'negation' ? 'negation' : role === 'quantifier' ? 'quantifier' : 'modal'
  return relation.kind === 'dependency' ? 'argument' : relation.kind
}
function phase(id: string): number {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return ((hash >>> 0) % 170) / 10
}
/** A tapered sheet of light, never a stroked wire or a moving bead. */
function ribbon(points: [Point, Point, Point, Point], width: number): string {
  const up: Point[] = [],
    down: Point[] = []
  for (let i = 0; i <= 32; i++) {
    const t = i / 32,
      u = 1 - t,
      [a, b, c, d] = points
    const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x
    const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y
    const dx = 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x)
    const dy = 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y)
    const length = Math.hypot(dx, dy) || 1
    const w = width * Math.sin(Math.PI * t) ** 0.6
    up.push({ x: x - (dy / length) * w, y: y + (dx / length) * w })
    down.push({ x: x + (dy / length) * w, y: y - (dx / length) * w })
  }
  return (
    [...up, ...down.reverse()]
      .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ') + 'Z'
  )
}
function beam(
  key: string,
  points: [Point, Point, Point, Point],
  width: number,
  extent: OpticalBeam['extent']
): OpticalBeam {
  return {
    key,
    body: ribbon(points, width),
    core: ribbon(points, Math.min(1.2, width * 0.28)),
    start: points[0],
    end: points[3],
    extent
  }
}
/** A continuous strip along a piecewise route. Its middle can occupy the margin without
 * a single large Bezier bowing back into the intervening prose. */
function routedBeam(
  key: string,
  curves: Array<[Point, Point, Point, Point]>,
  width: number,
  partition = true
): OpticalBeam {
  const samples: Array<Point & { dx: number; dy: number; distance: number }> = []
  let distance = 0
  for (const [a, b, c, d] of curves)
    for (let i = samples.length ? 1 : 0; i <= 12; i++) {
      const t = i / 12,
        u = 1 - t
      const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x
      const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y
      const last = samples.at(-1)
      if (last) distance += Math.hypot(x - last.x, y - last.y)
      samples.push({
        x,
        y,
        distance,
        dx: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x),
        dy: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y)
      })
    }
  const strip = (size: number): string => {
    const up: Point[] = [],
      down: Point[] = []
    for (const p of samples) {
      const length = Math.hypot(p.dx, p.dy) || 1,
        w = size * Math.sin((Math.PI * p.distance) / (distance || 1)) ** 0.6
      up.push({ x: p.x - (p.dy / length) * w, y: p.y + (p.dx / length) * w })
      down.push({ x: p.x + (p.dy / length) * w, y: p.y - (p.dx / length) * w })
    }
    return (
      [...up, ...down.reverse()]
        .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
        .join(' ') + 'Z'
    )
  }
  return {
    key,
    body: strip(width),
    core: strip(Math.min(1.2, width * 0.28)),
    start: curves[0][0],
    end: curves.at(-1)![3],
    extent: 'link',
    route: 'margin',
    gradient: partition
      ? { start: curves[2][0], end: curves[2][3] }
      : { start: curves[0][0], end: curves.at(-1)![3] },
    ...(partition
      ? {
          parts: [
            {
              ...routedBeam(key + '-entry', curves.slice(0, 2), width, false),
              part: 'entry' as const
            },
            {
              ...routedBeam(key + '-corridor', curves.slice(2, 3), width, false),
              part: 'corridor' as const
            },
            { ...routedBeam(key + '-exit', curves.slice(3), width, false), part: 'exit' as const }
          ]
        }
      : {})
  }
}
function join(
  key: string,
  a: SyntaxLightBand,
  b: SyntaxLightBand,
  kind: OpticalFamily,
  gutter: number
): OpticalBeam | undefined {
  const sameLine = Math.abs(a.top - b.top) < Math.min(a.height, b.height) * 0.5
  const high = ['reference', 'control', 'ellipsis'].includes(kind)
  const room = Math.min(
    high ? (a.roomAbove ?? 32) : (a.roomBelow ?? 32),
    high ? (b.roomAbove ?? 32) : (b.roomBelow ?? 32)
  )
  const gap = Math.min(3, room * 0.22)
  const start = {
    x: a.x + a.width / 2,
    y: high ? (a.inkTop ?? a.top) - gap : (a.inkBottom ?? a.y - 2) + gap
  }
  const end = {
    x: b.x + b.width / 2,
    y: high ? (b.inkTop ?? b.top) - gap : (b.inkBottom ?? b.y - 2) + gap
  }
  let p: [Point, Point, Point, Point]
  if (sameLine) {
    const lift =
      (high ? -1 : 1) * Math.min(room * 0.42, high ? 24 : 11, 7 + Math.abs(end.x - start.x) * 0.06)
    p = [
      start,
      { x: start.x + (end.x - start.x) * 0.22, y: start.y + lift },
      { x: start.x + (end.x - start.x) * 0.78, y: end.y + lift },
      end
    ]
  } else {
    if (
      !Number.isFinite(gutter) ||
      gutter > Math.min(a.clipRight ?? Infinity, b.clipRight ?? Infinity)
    )
      return
    start.x = a.x + a.width + 2
    end.x = b.x + b.width + 2
    const sign = Math.sign(end.y - start.y),
      radius = Math.min(
        10,
        Math.max(2, gutter - Math.max(a.inkRight ?? gutter - 12, b.inkRight ?? gutter - 12) - 7),
        Math.abs(end.y - start.y) / 4
      ),
      edge = gutter - radius
    if (edge <= Math.max(start.x, end.x)) return
    const line = (a: Point, b: Point): [Point, Point, Point, Point] => [
      a,
      { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
      { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 },
      b
    ]
    const entry = { x: edge, y: start.y },
      first = { x: gutter, y: start.y + sign * radius },
      last = { x: gutter, y: end.y - sign * radius },
      exit = { x: edge, y: end.y },
      k = radius * 0.55228475
    return routedBeam(
      key,
      [
        line(start, entry),
        [entry, { x: entry.x + k, y: entry.y }, { x: first.x, y: first.y - sign * k }, first],
        line(first, last),
        [last, { x: last.x, y: last.y + sign * k }, { x: exit.x + k, y: exit.y }, exit],
        line(exit, end)
      ],
      Math.min(kind === 'argument' ? 1.3 : 1.7, room * 0.13)
    )
  }
  return beam(key, p, Math.min(kind === 'argument' ? 1.3 : 1.7, room * 0.13), 'link')
}
function envelope(key: string, band: SyntaxLightBand, level: number): OpticalBeam {
  const inset = band.first === false ? 0 : 2
  const room = level > 0 ? (band.roomAbove ?? 32) : (band.roomBelow ?? 32)
  const start = {
    x: band.x + inset,
    y:
      level > 0
        ? (band.inkTop ?? band.top) - Math.min(5 + (level - 1) * 3, room * 0.32)
        : (band.inkBottom ?? band.y - 2) + Math.min(3, room * 0.22)
  }
  const end = { x: band.x + band.width - (band.last === false ? 0 : 2), y: start.y }
  const lift = (level > 0 ? -1 : 1) * Math.min(7, room * 0.4)
  return beam(
    key,
    [
      start,
      { x: start.x + band.width * 0.22, y: start.y + lift },
      { x: start.x + band.width * 0.78, y: end.y + lift },
      end
    ],
    Math.min(1.65, room * 0.12),
    'scope'
  )
}
/** Project a validated linguistic graph. Hover is deliberately not an input. */
export function syntaxOpticalPlan(
  analysis: SyntaxAnalysis,
  bands: SyntaxLightBand[],
  reading = '',
  highlighted = '',
  pageRight?: number,
  routeLanes = new SyntaxRouteLanes()
): SyntaxOpticalPlan {
  const view = syntaxProjection(analysis, reading)
  const scopeFields = syntaxScopeFields(analysis, bands, reading)
  const fieldRelations = new Set(scopeFields.representedRelationIds)
  const byId = new Map(view.units.map((u) => [u.id, u]))
  const geometries = new Map(
    view.units.map((u) => [u.id, bands.filter((b) => b.index === u.index)])
  )
  const ordered = [...view.relations].sort((a, b) => priority[b.kind] - priority[a.kind])
  const scopes = view.relations.filter((r) => r.kind === 'scope' || r.kind === 'perspective')
  const depth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0
    const path = new Set([...seen, id])
    return Math.min(
      3,
      Math.max(0, ...scopes.filter((r) => r.within === id).map((r) => 1 + depth(r.id, path)))
    )
  }
  const inkRight = Math.max(pageRight ?? 0, ...bands.map((b) => b.inkRight ?? b.x + b.width))
  const available = Math.min(...bands.map((b) => b.clipRight ?? Infinity)) - inkRight
  // Reserve the blur's width on either side. Capacity overflow retains word marks,
  // never merges unrelated chains into one brighter margin column.
  const capacity = Math.max(0, Math.min(6, Math.floor((available - 24) / 16) + 1))
  const lanes = routeLanes.assign(
    view.relations.flatMap((relation) => {
      const involved = [relation.from, ...relation.to]
      const pieces = involved.flatMap((id) => geometries.get(id) ?? [])
      if (!pieces.length) return []
      const top = Math.min(...pieces.map((b) => b.inkTop ?? b.top))
      const bottom = Math.max(...pieces.map((b) => b.inkTop ?? b.top))
      if (bottom - top < Math.min(...pieces.map((b) => b.height)) * 0.5) return []
      return [
        {
          id: relation.id,
          top,
          bottom,
          order: Math.min(
            ...involved.map((id) => byId.get(id)?.span.start ?? Infinity).filter((n) => n >= 0)
          )
        }
      ]
    }),
    capacity
  )
  const relations: OpticalRelation[] = []
  for (const relation of view.relations) {
    const lane = lanes.get(relation.id)
    const gutter = lane === undefined ? NaN : inkRight + 16 + lane * 16
    const f = family(relation, byId.get(relation.from)?.span.role)
    const level = depth(relation.id)
    let targetIds = [...relation.to]
    if (relation.kind === 'ellipsis')
      targetIds = targetIds.flatMap((id) =>
        byId.get(id)?.span.implicit
          ? view.relations.filter((r) => r.from === id).flatMap((r) => r.to)
          : [id]
      )
    targetIds = [...new Set(targetIds)]
    const from = geometries.get(relation.from) ?? []
    const targets = targetIds.flatMap((id) => geometries.get(id) ?? [])
    const paths: OpticalBeam[] = []
    const connect = (...args: Parameters<typeof join>): void => {
      const path = join(...args)
      if (path) paths.push(path)
    }
    if (fieldRelations.has(relation.id)) {
      // These environments are rendered as separate 2D fields and an explicit operator tree.
      // Do not stack the old underline envelopes beneath the same logical structure.
    } else if (relation.kind === 'scope' || relation.kind === 'perspective') {
      for (const target of targets) paths.push(envelope('scope-' + target.key, target, level))
      // A short attachment connects the operator to its own extent, separate from lexical links.
      if (from[0] && targets[0])
        connect(
          'operator',
          from[0],
          { ...targets[0], width: Math.min(18, targets[0].width) },
          f,
          gutter
        )
    } else if (from.length && targets.length) {
      for (const id of targetIds) {
        const dest = geometries.get(id) ?? []
        if (!dest.length) continue
        // Choose the closest actually printed fragments; never create an implicit anchor.
        const pairs = from
          .flatMap((a) =>
            dest.map((b) => ({ a, b, distance: Math.abs(a.top - b.top) * 4 + Math.abs(a.x - b.x) }))
          )
          .sort((a, b) => a.distance - b.distance)
        if (pairs[0]) connect('link-' + id, pairs[0].a, pairs[0].b, f, gutter)
      }
    } else if (byId.get(relation.from)?.span.implicit && targets.length > 1) {
      for (let i = 1; i < targets.length; i++)
        connect('shared-' + i, targets[0], targets[i], 'ellipsis', gutter)
    }
    if (from.length || targets.length)
      relations.push({
        id: relation.id,
        kind: relation.kind,
        family: f,
        phase: phase(f + relation.from),
        level,
        status: relation.status,
        label: relation.label,
        members: [relation.from, ...targetIds],
        beams: paths,
        tone: relation.kind === 'reference' ? (phase(relation.id) / 17 - 0.5) * 32 : 0
      })
  }
  const highlight = view.relations.find((r) => r.id === highlighted)
  const lexicalRelations = ordered.filter((r) => !fieldRelations.has(r.id))
  const participants = new Set(
    relations.filter((r) => !fieldRelations.has(r.id)).flatMap((r) => r.members)
  )
  const marks = bands
    .filter(
      (band) =>
        analysis.version !== 2 ||
        participants.has(view.units.find((u) => u.index === band.index)?.id ?? '')
    )
    .map((band): OpticalMark => {
      const unit = view.units.find((u) => u.index === band.index)
      const r =
        lexicalRelations.find((r) => r.from === unit?.id) ??
        lexicalRelations.find((r) => r.to.includes(unit?.id ?? ''))
      return {
        band,
        family: r ? family(r, byId.get(r.from)?.span.role) : 'argument',
        governor: r?.from === unit?.id,
        clause: ['clause', 'event'].includes(unit?.span.role ?? ''),
        active: Boolean(highlight && [highlight.from, ...highlight.to].includes(unit?.id ?? '')),
        phase: phase(r ? family(r, byId.get(r.from)?.span.role) + r.from : String(band.index)),
        tone: r?.kind === 'reference' ? (phase(r.id) / 17 - 0.5) * 32 : 0
      }
    })
  return { marks, relations, scopeFields }
}
