import { describe, it, expect } from 'vitest'
import {
  echoConstellation,
  echoLivePoint,
  packEchoStars,
  ECHO_STAR_TEXELS,
  tideHorizon
} from '../src/renderer/src/effects/echo-constellation'
import { echoInk, ECHO_INK } from '../src/renderer/src/effects/echo/echo-palette'
import { EchoFieldDynamics, EchoRevisits } from '../src/renderer/src/effects/echo/echo-dynamics'
import type { TidalPlace } from '../src/renderer/src/composables/tidalPlaces'

const version = {
  path: 'C:/echo.md',
  digest: 'a'.repeat(64),
  length: 400,
  hash: 'sha256-utf16le-1',
  projection: 'zhumo-search-text-1'
} as const
function place(
  i: number,
  kind: 'section' | 'note' = 'section',
  extra: Partial<TidalPlace> = {}
): TidalPlace {
  return {
    address: {
      schema: 1,
      version,
      origin: kind === 'section' ? { kind, sectionId: 's' + i } : { kind, label: 'n' + i },
      blockIndex: i,
      match: { start: i * 3, end: i * 3 + 2, text: '月光' },
      prefix: '',
      suffix: '。'
    },
    title: '回声',
    position: (i + 0.5) / 8,
    at: Date.UTC(2026, 8, 8, 4, 0, 0) + i * 60000,
    visits: 1,
    ...extra
  }
}
const context = {
  textShare: 0.5,
  reversals: 0,
  switches: 0,
  readingSeconds: 0,
  phase: 0,
  tide: true,
  now: Date.UTC(2026, 8, 8, 5, 0, 0)
}
describe('echo field layout', () => {
  it('places stops by address alone; the hour only tints', () => {
    const places = [place(0), place(3), place(6)]
    const a = echoConstellation(places, context)
    const b = echoConstellation(places, { ...context, phase: 3 })
    a.forEach((star, i) => {
      expect(star.x).toBe(b[i].x)
      expect(star.y).toBe(b[i].y)
      expect(star.x).toBeGreaterThanOrEqual(0)
      expect(star.x).toBeLessThanOrEqual(1)
      expect(star.y).toBeGreaterThanOrEqual(0)
      expect(star.y).toBeLessThanOrEqual(1)
    })
    // Reading order runs left to right across the water.
    expect(a[0].x).toBeLessThan(a[1].x)
    expect(a[1].x).toBeLessThan(a[2].x)
  })
  it('keeps margin notes farther: near the tide horizon, deeper in the lucent fan', () => {
    const body = echoConstellation([place(2)], context)[0]
    const note = echoConstellation([place(2, 'note')], context)[0]
    expect(note.y).toBeLessThan(body.y)
    expect(note.y).toBeGreaterThan(tideHorizon(0.4))
    const lucentBody = echoConstellation([place(2)], { ...context, tide: false })[0]
    const lucentNote = echoConstellation([place(2, 'note')], { ...context, tide: false })[0]
    expect(lucentNote.depth).toBeGreaterThan(lucentBody.depth)
  })
  it('lets dwell, visits and age shape magnitude without moving the stop', () => {
    const quick = echoConstellation([place(1)], context)[0]
    const long = echoConstellation(
      [
        place(1, 'section', {
          visits: 4,
          echo: { dwellMs: 40000, peakMs: 15000, textShare: 0.8, switches: 0, reversals: 0 }
        })
      ],
      context
    )[0]
    expect(long.magnitude).toBeGreaterThan(quick.magnitude)
    expect(long.breadth).toBeGreaterThan(quick.breadth)
    expect(long.visits).toBeGreaterThan(quick.visits)
    expect(long.x).toBe(quick.x)
    expect(long.y).toBe(quick.y)
    const old = echoConstellation([place(1)], { ...context, now: context.now + 30 * 86400000 })[0]
    expect(old.age).toBeGreaterThan(quick.age)
    expect(old.age).toBeLessThanOrEqual(1)
  })
  it('packs three texels per stop with every channel in range', () => {
    const stars = echoConstellation([place(0), place(1, 'note')], context)
    const bytes = packEchoStars(stars)
    expect(bytes.length).toBe(stars.length * ECHO_STAR_TEXELS * 4)
    expect(bytes[0]).toBe(Math.round(stars[0].x * 255))
    expect(bytes[1]).toBe(Math.round(stars[0].y * 255))
    expect(bytes[12 + 11]).toBe(255)
    expect(bytes[11]).toBe(0)
    expect(packEchoStars([]).length).toBe(ECHO_STAR_TEXELS * 4)
  })
  it('lets the forming stop follow reading progress inside the field', () => {
    for (const tide of [true, false]) {
      const early = echoLivePoint(0.1, tide),
        late = echoLivePoint(0.9, tide)
      for (const p of [early, late]) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(1)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(1)
      }
      expect(late.x).toBeGreaterThan(early.x)
    }
  })
})
describe('echo ink', () => {
  it('reaches sunlight at full strength and keeps each theme legible', () => {
    expect(echoInk('chaosheng', [220, 233, 245], 1, 1)).toEqual([...ECHO_INK.chaosheng.sun])
    expect(echoInk('lucent', [37, 55, 74], 1, 1)).toEqual([...ECHO_INK.lucent.sun])
    expect(echoInk('lucent', [37, 55, 74], 0, 0.5)).toEqual([37, 55, 74])
    for (const tint of [0, 0.3, 0.7, 1]) {
      const [r, g, b] = echoInk('lucent', [37, 55, 74], 1, tint)
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      expect(luminance).toBeLessThan(0.35)
      const [tr, tg, tb] = echoInk('chaosheng', [220, 233, 245], 1, tint)
      expect((0.2126 * tr + 0.7152 * tg + 0.0722 * tb) / 255).toBeGreaterThan(0.85)
    }
  })
})
describe('echo field dynamics', () => {
  it('snaps on the first sample and eases afterwards', () => {
    const dynamics = new EchoFieldDynamics()
    const target = new Array(16).fill(1)
    dynamics.sample(0, target)
    expect([...dynamics.values]).toEqual(target)
    dynamics.sample(1000, new Array(16).fill(0))
    for (let i = 0; i < 16; i++) {
      expect(dynamics.values[i]).toBeGreaterThan(0)
      expect(dynamics.values[i]).toBeLessThan(1)
    }
    const live = dynamics.values[14]
    dynamics.sample(2000, new Array(16).fill(0))
    expect(dynamics.values[14]).toBeLessThan(live)
    dynamics.sample(3000, new Array(16).fill(0.5), false)
    expect(dynamics.values[0]).toBe(0.5)
  })
  it('counts session revisits per word and forgets them on reset', () => {
    const revisits = new EchoRevisits()
    expect(revisits.count('月光')).toBe(0)
    expect(revisits.mark('月光')).toBe(1)
    expect(revisits.mark('月光')).toBe(2)
    expect(revisits.count('日光')).toBe(0)
    revisits.reset()
    expect(revisits.count('月光')).toBe(0)
  })
})
