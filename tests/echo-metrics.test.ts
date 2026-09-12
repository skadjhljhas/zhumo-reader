import { describe, it, expect } from 'vitest'
import { echoEnvelope, EchoHabits } from '../src/renderer/src/effects/echo-metrics'
import { echoConstellation } from '../src/renderer/src/effects/echo-constellation'
import {
  appendTidalPlace,
  readTidalPlace,
  type TidalPlace
} from '../src/renderer/src/composables/tidalPlaces'
describe('silent echo timing and habit projection', () => {
  it('starts after three seconds, develops continuously, and saturates at fifteen', () => {
    for (const t of [0, 2, 2.999, 3]) expect(echoEnvelope(t)).toBe(0)
    expect(echoEnvelope(3.01)).toBeGreaterThan(0)
    expect(echoEnvelope(9)).toBeCloseTo(0.5)
    expect(echoEnvelope(15)).toBe(1)
    expect(echoEnvelope(150)).toBe(1)
    expect(echoEnvelope(3.001)).toBeLessThan(0.00001)
  })
  it('distinguishes text and empty-space dwell and bounds scroll impulses', () => {
    const habits = new EchoHabits()
    habits.sample(100, 'text')
    for (let t = 200; t <= 2100; t += 100) habits.sample(t, 'text')
    for (let t = 2200; t <= 3100; t += 100) habits.sample(t, 'air')
    expect(habits.value.textShare).toBeCloseTo(2 / 3)
    expect(habits.value.switches).toBe(1)
    habits.scroll(100000, 900)
    expect(habits.value.activity).toBeLessThanOrEqual(0.35)
    habits.scroll(-200, 900)
    expect(habits.value.reversals).toBe(1)
    const activity = habits.value.activity
    habits.sample(3300, 'outside')
    expect(habits.value.activity).toBeLessThan(activity)
  })
  it('preserves old records and accumulates measured dwell without corrupting their address', () => {
    const place: TidalPlace = {
      address: {
        schema: 1,
        version: {
          path: 'C:/echo.md',
          digest: 'a'.repeat(64),
          length: 20,
          hash: 'sha256-utf16le-1',
          projection: 'zhumo-search-text-1'
        },
        origin: { kind: 'section', sectionId: 's' },
        blockIndex: 0,
        match: { start: 0, end: 2, text: '月光' },
        prefix: '',
        suffix: '。'
      },
      title: '月光',
      position: 0.4,
      at: 1,
      visits: 1
    }
    expect(readTidalPlace(place)).toEqual(place)
    const annotated = {
      ...place,
      echo: { dwellMs: 5000, peakMs: 5000, textShare: 0.7, switches: 3, reversals: 2 }
    }
    const result = appendTidalPlace([annotated], {
      ...annotated,
      echo: { ...annotated.echo, dwellMs: 15000, peakMs: 15000 }
    })[0]
    expect(result.echo?.dwellMs).toBe(20000)
    expect(result.echo?.peakMs).toBe(15000)
    expect(result.visits).toBe(2)
    const context = {
      textShare: 0.5,
      reversals: 0,
      switches: 0,
      readingSeconds: 0,
      phase: 0,
      tide: true
    }
    const first = echoConstellation([annotated], context)[0],
      next = echoConstellation([result], { ...context, textShare: 0.2, reversals: 12 })[0]
    expect(next.radius).toBeGreaterThan(first.radius)
    expect(next.warmth).toBeGreaterThan(first.warmth)
    expect(next.x).not.toBe(first.x)
    expect(next.key).toBe(first.key)
  })
})
