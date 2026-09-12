import { describe, expect, it } from 'vitest'
import { ProfileTransition } from '../src/renderer/src/effects/manuscript/profile-transition'
import { manuscriptProfile } from '../src/renderer/src/effects/manuscript/profile'

const short = manuscriptProfile({ bodyChars: 100, paragraphs: [20, 40, 40], notes: [] })
const deep = manuscriptProfile({
  bodyChars: 50000,
  paragraphs: [100, 700, 500],
  notes: [{ chars: 20000, level: 4, parents: 2, refs: 3, positions: [0.2, 0.4, 0.8] }]
})
describe('changes to manuscript optical controls', () => {
  it('begins at the correct shape, then converges monotonically without a jump at retargeting', () => {
    const transition = new ProfileTransition()
    expect(transition.update(short, 0, true)).toBe(true)
    const start = transition.values[0]
    expect(transition.update(deep, 0, true)).toBe(false)
    expect(transition.values[0]).toBe(start)
    let previous = start
    for (let i = 1; i <= 180; i++) {
      transition.update(deep, i / 60, true)
      expect(transition.values[0]).toBeGreaterThanOrEqual(previous)
      expect(transition.values[0]).toBeLessThanOrEqual(deep.volume + 0.000001)
      previous = transition.values[0]
    }
    expect(transition.values[0]).toBeCloseTo(deep.volume, 3)
  })
  it('uses the current shape as the starting point when edited again mid-transition', () => {
    const transition = new ProfileTransition()
    transition.update(short, 0, true)
    transition.update(deep, 0.1, true)
    const before = Array.from(transition.values)
    transition.update(short, 0.1, true)
    expect(Array.from(transition.values)).toEqual(before)
    transition.update(short, 0.2, true)
    expect(transition.values[0]).toBeLessThan(before[0])
  })
  it('quiet and reduced motion immediately display the current article parameters', () => {
    const transition = new ProfileTransition()
    transition.update(short, 0, false)
    transition.update(deep, 0, false)
    expect(transition.values[0]).toBeCloseTo(deep.volume, 6)
    expect(transition.update(deep, 10, false)).toBe(false)
  })
})
