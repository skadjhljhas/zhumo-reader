import { describe, expect, it } from 'vitest'
import {
  SyntaxRouteLanes,
  type SyntaxRouteInterval
} from '../src/renderer/src/effects/syntax-route-lanes'

const interval = (id: string, top: number, bottom: number, order = 0): SyntaxRouteInterval => ({
  id,
  top,
  bottom,
  order
})
const sorted = (lanes: Map<string, number>): Array<[string, number]> =>
  [...lanes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

describe('syntax route lanes', () => {
  it('separates independent reference chains across the same two lines', () => {
    // “后者 → 陈墨” and “它 → 旧信” must remain two traceable light paths.
    const result = new SyntaxRouteLanes().assign(
      [interval('person', 32, 82, 0), interval('letter', 32, 82, 1)],
      2
    )
    expect(sorted(result)).toEqual([
      ['letter', 1],
      ['person', 0]
    ])
  })

  it('reuses a channel only after the full 12 px shoulder and halo clearance', () => {
    const result = new SyntaxRouteLanes().assign(
      [interval('a', 0, 20, 0), interval('near', 31.9, 40, 1), interval('clear', 32, 60, 2)],
      2
    )
    expect(sorted(result)).toEqual([
      ['a', 0],
      ['clear', 0],
      ['near', 1]
    ])
  })

  it('allocates first arrivals by source order and id regardless of input order', () => {
    const entries = [interval('z', 0, 50, 0), interval('a', 0, 50, 1), interval('b', 0, 50, 1)]
    const expected = [
      ['a', 1],
      ['b', 2],
      ['z', 0]
    ]
    for (const input of [entries, [...entries].reverse(), [entries[1], entries[0], entries[2]]])
      expect(sorted(new SyntaxRouteLanes().assign(input, 3))).toEqual(expected)
  })

  it('keeps existing routes when an earlier-source relation arrives in a later patch', () => {
    const lanes = new SyntaxRouteLanes()
    const old = interval('old', 0, 50, 10)
    expect(lanes.assign([old], 2).get('old')).toBe(0)
    expect(sorted(lanes.assign([interval('new', 0, 50, 0), old], 2))).toEqual([
      ['new', 1],
      ['old', 0]
    ])
  })

  it('repairs conflicts after reflow while keeping an unrelated route in its lane', () => {
    const lanes = new SyntaxRouteLanes()
    lanes.assign([interval('a', 0, 20, 0), interval('b', 32, 50, 1), interval('c', 0, 50, 2)], 3)
    expect(
      sorted(
        lanes.assign(
          [interval('c', 0, 50, 2), interval('b', 15, 50, 1), interval('a', 0, 20, 0)],
          3
        )
      )
    ).toEqual([
      ['a', 0],
      ['b', 2],
      ['c', 1]
    ])
  })

  it('retains surviving slots after capacity changes and omits overflow instead of merging', () => {
    const lanes = new SyntaxRouteLanes()
    const entries = [interval('a', 0, 50, 0), interval('b', 0, 50, 1), interval('c', 0, 50, 2)]
    lanes.assign(entries, 3)
    expect(sorted(lanes.assign(entries, 2))).toEqual([
      ['a', 0],
      ['b', 1]
    ])
    expect(sorted(lanes.assign(entries, 3))).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2]
    ])
  })

  it('forgets removed ids and releases all reservations on reset', () => {
    const lanes = new SyntaxRouteLanes()
    const a = interval('a', 0, 50, 0),
      b = interval('b', 0, 50, 1)
    lanes.assign([a, b], 2)
    expect(lanes.assign([b], 2).get('b')).toBe(1)
    expect(sorted(lanes.assign([b, interval('c', 0, 50, 2)], 2))).toEqual([
      ['b', 1],
      ['c', 0]
    ])
    lanes.assign([], 2)
    expect(lanes.assign([b], 2).get('b')).toBe(0)
    lanes.assign([a, b], 2)
    lanes.reset()
    expect(sorted(lanes.assign([a, b], 2))).toEqual([
      ['a', 0],
      ['b', 1]
    ])
  })

  it('does not let callers mutate retained assignments through the returned map', () => {
    const lanes = new SyntaxRouteLanes(),
      entries = [interval('a', 0, 50)]
    lanes.assign(entries, 2).set('a', 1)
    expect(lanes.assign(entries, 2).get('a')).toBe(0)
  })

  it('accepts at most six lanes and no lanes for non-positive capacity', () => {
    const entries = Array.from({ length: 8 }, (_, i) => interval(String(i), 0, 50, i))
    const lanes = new SyntaxRouteLanes()
    expect(lanes.assign(entries, 20).size).toBe(6)
    expect(lanes.assign(entries, 2.9).size).toBe(2)
    for (const capacity of [0, -1, Number.NaN]) expect(lanes.assign(entries, capacity).size).toBe(0)
    expect(lanes.assign(entries, Infinity).size).toBe(6)
  })

  it('normalizes upward routes and rejects non-finite geometry', () => {
    const result = new SyntaxRouteLanes().assign(
      [interval('up', 80, 20, 0), interval('down', 20, 80, 1), interval('invalid', NaN, 80, 2)],
      3
    )
    expect(sorted(result)).toEqual([
      ['down', 1],
      ['up', 0]
    ])
  })

  it('reserves all fragments of a repeated route id independently of input order', () => {
    const entries = [interval('a', 0, 20, 0), interval('a', 80, 100, 2), interval('b', 85, 95, 1)]
    for (const input of [entries, [...entries].reverse()])
      expect(sorted(new SyntaxRouteLanes().assign(input, 2))).toEqual([
        ['a', 0],
        ['b', 1]
      ])
  })
})
