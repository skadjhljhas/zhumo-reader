import { describe, expect, it } from 'vitest'
import {
  manuscriptProfile,
  type ManuscriptMeasure
} from '../src/renderer/src/effects/manuscript/profile'
import { seasonLight, solarLongitude } from '../src/renderer/src/effects/manuscript/season'

const make = (bodyChars: number, positions: number[] = [], level = 1): ManuscriptMeasure => ({
  bodyChars,
  paragraphs: [120, 90, 260, 150],
  notes: positions.map((position) => ({
    chars: 110,
    level,
    parents: level - 1,
    refs: 1,
    positions: [position]
  }))
})
describe('manuscript light structural mapping', () => {
  it('compresses many orders of magnitude without a hard saturation plateau', () => {
    const values = [0, 50, 500, 5000, 50000, 500000, 5000000].map(
      (n) => manuscriptProfile(make(n)).volume
    )
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1])
    expect(values.at(-1)).toBeLessThan(1)
  })
  it('distinguishes the location of annotations with the same aggregate statistics', () => {
    const a = manuscriptProfile(make(5000, [0.05, 0.06, 0.07, 0.08]))
    const b = manuscriptProfile(make(5000, [0.2, 0.4, 0.6, 0.8]))
    expect(a.annotation).toBe(b.annotation)
    expect(a.volume).toBe(b.volume)
    expect(b.spread).toBeGreaterThan(a.spread)
    expect(a.spectrum).not.toEqual(b.spectrum)
  })
  it('responds separately to nesting, cross-references, and paragraph rhythm', () => {
    const flat = make(1000, [0.1, 0.5, 0.9])
    const deep = make(1000, [0.1, 0.5, 0.9], 4)
    expect(manuscriptProfile(deep).depth).toBeGreaterThan(manuscriptProfile(flat).depth)
    expect(manuscriptProfile(deep).interconnection).toBeGreaterThan(
      manuscriptProfile(flat).interconnection
    )
    const even = manuscriptProfile({ ...flat, paragraphs: [100, 100, 100] })
    expect(manuscriptProfile(flat).rhythm).toBeGreaterThan(even.rhythm)
  })
  it('keeps empty, missing, orphan and cyclic note records finite without recursive traversal', () => {
    const input = make(0)
    input.notes = [{ chars: 0, level: 4, parents: 2, refs: 0, positions: [] }]
    const value = manuscriptProfile(input)
    for (const item of Object.values(value).flat()) expect(Number.isFinite(item)).toBe(true)
    expect(value.spectrum).toEqual(new Array(8).fill(0))
  })
})
describe('the hidden seasonal clock', () => {
  it('has the expected seasonal quarter-turns in 2026', () => {
    const deg = (date: string): number => (solarLongitude(Date.parse(date)) * 180) / Math.PI
    const spring = deg('2026-03-20T15:00:00Z')
    expect(Math.min(spring, 360 - spring)).toBeLessThan(1)
    expect(deg('2026-06-21T12:00:00Z')).toBeCloseTo(90, 0)
    expect(deg('2026-12-21T12:00:00Z')).toBeCloseTo(270, 0)
  })
  it('crosses local midnight continuously instead of resetting its phase', () => {
    const date = new Date(2026, 8, 6, 23, 59, 59)
    const a = seasonLight(date),
      b = seasonLight(new Date(date.getTime() + 2000))
    expect(Math.hypot(...a.map((n, i) => n - b[i]))).toBeLessThan(0.001)
  })
})
