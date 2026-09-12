import { expect, it } from 'vitest'
import { unionHdrDamage, clipHdrDamage } from '../src/renderer/src/effects/hdr-damage'
it('uploads both an old cleared glow and its new location, with pixel-edge coverage', () => {
  const area = unionHdrDamage(
    { x: 10.2, y: 30.1, width: 40, height: 25 },
    { x: 75.1, y: 20.2, width: 20, height: 30 }
  )
  expect(clipHdrDamage(area, 200, 100)).toEqual({ x: 10, y: 20, width: 86, height: 36 })
})
it('clips outside glows without negative copy origins and handles a full refresh', () => {
  expect(clipHdrDamage({ x: -20, y: -5, width: 35, height: 22 }, 100, 60)).toEqual({
    x: 0,
    y: 0,
    width: 15,
    height: 17
  })
  expect(clipHdrDamage({ x: 200, y: 30, width: 30, height: 20 }, 100, 60).width).toBe(0)
  expect(clipHdrDamage(null, 100, 60)).toEqual({ x: 0, y: 0, width: 100, height: 60 })
})
