import { describe, expect, it } from 'vitest'
import { placeNotePeek } from '../src/renderer/src/composables/notePeek'

describe('annotation sheet placement', () => {
  const viewport = { width: 960, height: 640 }
  const panel = { width: 390, height: 450 }
  it('uses the nearby right side and joins the actual reference', () => {
    const result = placeNotePeek({ left: 180, right: 200, top: 180, bottom: 200 }, panel, viewport)
    expect(result.left).toBe(218)
    expect(result.top).toBe(122)
    expect(result.connection).toMatch(/^M190 190 /)
  })
  it('switches to the left when the right side is full', () => {
    const result = placeNotePeek({ left: 850, right: 870, top: 600, bottom: 620 }, panel, viewport)
    expect(result.left).toBe(442)
    expect(result.top + panel.height).toBe(viewport.height - 16)
  })
  it('puts a wide sheet below the reference when neither side fits', () => {
    const result = placeNotePeek(
      { left: 460, right: 480, top: 20, bottom: 40 },
      { width: 800, height: 300 },
      viewport
    )
    expect(result.left).toBe(70)
    expect(result.top).toBe(58)
  })
  it('keeps an expanded sheet centered and suppresses a covered origin', () => {
    const result = placeNotePeek(
      { left: 460, right: 480, top: 220, bottom: 240 },
      { width: 740, height: 576 },
      viewport,
      true
    )
    expect(result).toEqual({ left: 110, top: 32, connection: '' })
  })
  it('never connects a sheet to a reference outside the viewport', () => {
    const result = placeNotePeek({ left: 100, right: 120, top: -100, bottom: -80 }, panel, viewport)
    expect(result.top).toBe(16)
    expect(result.connection).toBe('')
  })
  it('clamps a tall sheet at both vertical edges', () => {
    for (const top of [0, 600]) {
      const result = placeNotePeek(
        { left: 250, right: 270, top, bottom: top + 20 },
        { width: 390, height: 608 },
        viewport
      )
      expect(result.top).toBe(16)
      expect(result.left).toBeGreaterThanOrEqual(16)
      expect(result.left + 390).toBeLessThanOrEqual(944)
    }
  })
})
