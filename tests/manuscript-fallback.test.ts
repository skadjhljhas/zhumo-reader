import { describe, expect, it } from 'vitest'
import { fallbackStrokes } from '../src/renderer/src/effects/manuscript/fallback'
import { manuscriptProfile } from '../src/renderer/src/effects/manuscript/profile'

const small = manuscriptProfile({ bodyChars: 100, paragraphs: [20, 40, 40], notes: [] })
const annotated = manuscriptProfile({
  bodyChars: 50000,
  paragraphs: [100, 700, 500],
  notes: [{ chars: 20000, level: 4, parents: 2, refs: 3, positions: [0.2, 0.4, 0.8] }]
})
describe('manuscript light without a GPU', () => {
  it('keeps article variation and theme distinction in open vector paths', () => {
    const seed = [0.1, 0.3, 0.7, 0.9]
    const a = fallbackStrokes(small, seed, false),
      b = fallbackStrokes(annotated, seed, false),
      water = fallbackStrokes(annotated, seed, true)
    expect(b.length).toBeGreaterThan(a.length)
    expect(water).not.toEqual(b)
    for (const stroke of [...a, ...b, ...water]) {
      expect(stroke.path).toMatch(/^M/)
      expect(stroke.path).not.toMatch(/NaN|Infinity|[zZ]/)
      expect(stroke.opacity).toBeGreaterThan(0)
      expect(stroke.opacity).toBeLessThan(1)
    }
  })
  it('holds the same seed and produces a different encounter only when requested', () => {
    const first = fallbackStrokes(annotated, [0.1, 0.3, 0.7, 0.9], true)
    expect(fallbackStrokes(annotated, [0.1, 0.3, 0.7, 0.9], true)).toEqual(first)
    expect(fallbackStrokes(annotated, [0.1, 0.8, 0.7, 0.9], true)).not.toEqual(first)
    for (let i = 0; i < 4; i++) {
      const seed = [0.1, 0.3, 0.7, 0.9]
      seed[i] = (seed[i] + 0.31) % 1
      expect(fallbackStrokes(annotated, seed, true)).not.toEqual(first)
    }
    expect(fallbackStrokes(null, [0.1, 0.3, 0.7, 0.9], true)).toEqual([])
  })
})
