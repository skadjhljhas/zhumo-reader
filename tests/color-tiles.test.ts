import { expect, it } from 'vitest'
import { colorTiles } from '../src/renderer/src/effects/color-tiles'
import type { ColorBand } from '../src/renderer/src/effects/color-band'
it('allocates bounded local tiles for light near the end of a 100000px paragraph', () => {
  const bands = [{ x: 40, y: 99000, width: 120, height: 32 } as ColorBand]
  const tiles = colorTiles(bands, 680, 100000)
  expect(tiles.length).toBeLessThanOrEqual(2)
  expect(tiles.every((t) => t.width <= 512 && t.height <= 512 && t.y > 98000)).toBe(true)
  expect(tiles.flatMap((t) => t.bands)).toContain(bands[0])
})
it('includes both sides of tile boundaries and clips an overflowing code line to its host', () => {
  const bands = [{ x: 490, y: 501, width: 100, height: 32 } as ColorBand]
  expect(
    colorTiles(bands, 1000, 1200)
      .map((t) => t.key)
      .sort()
  ).toEqual(['0:0', '0:1', '1:0', '1:1'])
  const code = colorTiles([{ x: 0, y: 0, width: 1000000, height: 20 } as ColorBand], 680, 90000)
  expect(code).toHaveLength(2)
  expect(code.every((t) => t.width <= 512 && t.height <= 512)).toBe(true)
})
