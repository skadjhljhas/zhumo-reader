import { describe, expect, it } from 'vitest'
import {
  LucentFieldDynamics,
  VisibleReadingClock,
  type LucentFieldInput
} from '../src/renderer/src/effects/lucent/dynamics'
const base = (): LucentFieldInput => ({
  wallTime: new Date(2026, 8, 7, 12).getTime(),
  readingSeconds: 0,
  progress: 0,
  profile: null,
  seed: 0.25,
  hover: { strength: 0, depth: 0, x: 0.5, y: 0.5 }
})
describe('visible reading time and continuous light-field controls', () => {
  it('eases scroll history through slow frames and keeps all four encounter seeds', () => {
    const f = new LucentFieldDynamics()
    const initial = {
      ...base(),
      encounter: [0.12, 0.34, 0.56, 0.78],
      navigation: [0, 0, 0, 0.5] as [number, number, number, number]
    }
    f.sample(0, initial)
    expect([...f.values.slice(20, 24)]).toEqual(initial.encounter.map(Math.fround))
    const next = { ...initial, navigation: [1, 1, 0.5, 0.7] as [number, number, number, number] }
    f.sample(360, next)
    expect(f.values[28]).toBeGreaterThan(0.1)
    expect(f.values[28]).toBeLessThan(0.2)
    const retained = f.values[28]
    f.suspend()
    f.sample(50000, next)
    expect(f.values[28]).toBe(retained)
  })
  it('counts active reading only and survives rendering component pauses', () => {
    const clock = new VisibleReadingClock()
    clock.setActive(1000, true)
    expect(clock.seconds(6000)).toBe(5)
    clock.setActive(6000, false)
    expect(clock.seconds(66000)).toBe(5)
    clock.setActive(66000, true)
    expect(clock.seconds(71000)).toBe(10)
    clock.reset(71000)
    expect(clock.seconds(72000)).toBe(1)
  })
  it('does not step at midnight and separates calendar from active reading duration', () => {
    const a = new LucentFieldDynamics(),
      b = new LucentFieldDynamics()
    const left = a.sample(0, {
      ...base(),
      wallTime: new Date(2026, 8, 7, 23, 59, 59, 999).getTime()
    })
    const right = b.sample(0, {
      ...base(),
      wallTime: new Date(2026, 8, 8).getTime(),
      readingSeconds: 3600
    })
    for (let i = 0; i < 4; i++) expect(Math.abs(left[i] - right[i])).toBeLessThan(0.00001)
    expect(right[4]).toBeGreaterThan(left[4])
  })
  it('eases hover arrival and leaves a slower decay without a first-frame flash', () => {
    const field = new LucentFieldDynamics(),
      input = base()
    field.sample(0, input)
    const on = { ...input, hover: { strength: 1, depth: 3, x: 0.3, y: 0.7 } }
    expect(field.sample(16, on)[8]).toBeGreaterThan(0)
    expect(field.values[8]).toBeLessThan(0.03)
    for (let t = 32; t < 3000; t += 16) field.sample(t, on)
    const peak = field.values[8]
    field.sample(3000, input)
    expect(field.values[8]).toBeGreaterThan(peak * 0.99)
    field.suspend()
    const held = field.values[8]
    expect(field.sample(100000, input)[8]).toBeCloseTo(held)
  })
  it('bounds controls for hour-long reading and rejects nonfinite inputs', () => {
    const field = new LucentFieldDynamics()
    const values = field.sample(0, {
      ...base(),
      readingSeconds: 86400,
      progress: 200,
      hover: { strength: 8, depth: 80, x: -1, y: NaN }
    })
    expect([...values].every(Number.isFinite)).toBe(true)
    expect(values[4]).toBeGreaterThan(0)
    for (const i of [4, 5, 8, 9, 10, 11]) {
      expect(values[i]).toBeGreaterThanOrEqual(0)
      expect(values[i]).toBeLessThanOrEqual(1)
    }
  })
})
