import { describe, expect, it } from 'vitest'
import { MotionClock } from '../src/renderer/src/effects/manuscript/motion-clock'
import { seasonLight } from '../src/renderer/src/effects/manuscript/season'

describe('continuous manuscript motion', () => {
  it('keeps visible animation time advancing at slow and normal frame rates', () => {
    for (const hz of [1, 2, 3, 4, 15, 60, 144]) {
      const clock = new MotionClock()
      for (let i = 0; i <= hz * 3; i++) clock.sample((i * 1000) / hz)
      expect(clock.sample(3000)).toBeCloseTo(3, 8)
    }
  })
  it('freezes the current phase and resumes from it across a long pause', () => {
    const clock = new MotionClock()
    clock.sample(0)
    clock.sample(100)
    expect(clock.sample(105, false)).toBe(0.1)
    expect(clock.sample(90000, false)).toBe(0.1)
    expect(clock.sample(91000)).toBe(0.1)
    expect(clock.sample(91100)).toBe(0.2)
  })
  it('resumes explicitly suspended time without a jump and bounds unexpected long frames', () => {
    const clock = new MotionClock()
    clock.sample(0)
    clock.sample(100)
    clock.suspend()
    expect(clock.sample(10000)).toBe(0.1)
    expect(clock.sample(50000)).toBeCloseTo(1.1)
    expect(clock.sample(50100)).toBeCloseTo(1.2)
  })
  it('never mistakes repeated very slow visible frames for a permanently suspended app', () => {
    const clock = new MotionClock()
    clock.sample(0)
    for (let i = 1; i <= 8; i++) expect(clock.sample(i * 1500)).toBe(i)
    clock.suspend()
    expect(clock.sample(90000)).toBe(8)
    expect(clock.sample(90360)).toBeCloseTo(8.36)
  })
  it('keeps daylight modulation continuous through a whole-second boundary', () => {
    const before = seasonLight(new Date(2026, 8, 6, 12, 0, 0, 999))
    const after = seasonLight(new Date(2026, 8, 6, 12, 0, 1, 1))
    expect(Math.hypot(...before.map((n, i) => n - after[i]))).toBeLessThan(0.000001)
    expect(before).not.toEqual(after)
  })
})
