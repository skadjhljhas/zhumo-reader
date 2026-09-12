import { expect, it } from 'vitest'
import { SkylightTrajectory, skylightQuantile } from '../src/renderer/src/effects/lucent/skylight'
const bearing = (sky: number[] | Float32Array): number => Math.atan2(sky[1] - 0.5, sky[0] - 0.5)
const angularDistance = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
it('favours upper right while retaining every quadrant and fewer lower directions', () => {
  const counts = [0, 0, 0, 0]
  for (let i = 0; i < 10000; i++) {
    const a = skylightQuantile((i + 0.5) / 10000),
      x = Math.cos(a),
      y = Math.sin(a)
    counts[(y > 0 ? 2 : 0) + (x > 0 ? 0 : 1)]++
  }
  expect(counts[0]).toBeGreaterThan(Math.max(...counts.slice(1)))
  expect(counts[0] + counts[1]).toBeGreaterThan(7000)
  expect(Math.min(...counts)).toBeGreaterThan(300)
})
it('keeps the emitter outside the page, traverses regions slowly and has no resume jump', () => {
  const model = new SkylightTrajectory(421),
    field = new Float32Array(32).fill(0.4)
  const regions = new Set<string>()
  let previous: number[] | undefined
  for (let second = 0; second < 14400; second++) {
    const next = [...model.sample(second * 1000, field)]
    expect(next[0] < 0 || next[0] > 1 || next[1] < 0 || next[1] > 1).toBe(true)
    expect(
      Math.hypot(Math.max(0, -next[0], next[0] - 1), Math.max(0, -next[1], next[1] - 1))
    ).toBeGreaterThan(1.5)
    if (previous) expect(angularDistance(bearing(next), bearing(previous))).toBeLessThan(0.006)
    regions.add(`${next[0] > 0.5}:${next[1] > 0.5}`)
    previous = next
  }
  // A single random four-hour reading need not visit every quadrant; all four have
  // positive target probability above, while this path must escape its initial region.
  expect(regions.size).toBeGreaterThan(2)
  model.suspend()
  expect([...model.sample(99999999, field)]).toEqual(previous)
})
it('responds gently to reading, calendar, text, hover and navigation parameters', () => {
  const base = new Float32Array(32).fill(0.3),
    changed = new Float32Array(base)
  for (const index of [0, 3, 4, 5, 6, 7, 8, 10, 12, 14, 24, 25, 28, 30]) changed[index] = 0.8
  const first = new SkylightTrajectory(73),
    second = new SkylightTrajectory(73)
  first.sample(0, base)
  second.sample(0, base)
  for (let n = 1; n < 180; n++) {
    first.sample(n * 1000, base)
    second.sample(n * 1000, changed)
  }
  expect([...first.values]).not.toEqual([...second.values])
  expect(angularDistance(bearing(first.values), bearing(second.values))).toBeLessThan(0.12)
})
it('spends most sampled reading time in the upper right, rather than only choosing targets there', () => {
  const counts = [0, 0, 0, 0],
    field = new Float32Array(32).fill(0.4)
  for (let seed = 1; seed <= 32; seed++) {
    const model = new SkylightTrajectory(seed * 7919)
    for (let second = 0; second < 8 * 3600; second++) {
      const sky = model.sample(second * 1000, field)
      counts[(sky[1] > 0.5 ? 2 : 0) + (sky[0] > 0.5 ? 0 : 1)]++
    }
  }
  const total = counts.reduce((a, b) => a + b, 0)
  console.log(
    'Actual sky residence fractions:',
    counts.map((n) => +(n / total).toFixed(4))
  )
  expect(counts[0] / total).toBeGreaterThan(0.7)
  expect((counts[2] + counts[3]) / total).toBeLessThan(0.2)
  expect(Math.min(...counts) / total).toBeGreaterThan(0.005)
})
