import { describe, expect, it } from 'vitest'
import { dampingFactor } from '../src/renderer/src/effects/reading-interaction'
describe('pointer light follows time rather than frame count', () => {
  it('gives the same settling response across refresh rates', () => {
    const results = [30, 60, 144].map((hz) => {
      let position = 0
      for (let i = 0; i < hz; i++) position += (1 - position) * dampingFactor(1000 / hz, 110)
      return position
    })
    expect(results[0]).toBeCloseTo(results[1], 10)
    expect(results[1]).toBeCloseTo(results[2], 10)
  })
  it('is more responsive on text, remains bounded and ignores invalid elapsed time', () => {
    expect(dampingFactor(16, 28)).toBeGreaterThan(dampingFactor(16, 110))
    expect(dampingFactor(10000, 28)).toBeLessThan(1)
    expect(dampingFactor(-1, 80)).toBe(0)
    expect(dampingFactor(NaN, 80)).toBe(0)
  })
})
