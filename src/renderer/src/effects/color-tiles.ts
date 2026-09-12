import type { ColorBand } from './color-band'
export interface ColorTile {
  key: string
  x: number
  y: number
  width: number
  height: number
  bands: ColorBand[]
}
/** Allocate only illuminated tiles, even for a book-length paragraph or code block. */
export function colorTiles(bands: ColorBand[], width: number, height: number): ColorTile[] {
  const tiles = new Map<string, ColorTile>(),
    size = 512
  for (const band of bands) {
    const left = Math.max(0, band.x - band.width * 0.3 - 8),
      right = Math.min(width, band.x + band.width * 1.3 + 8)
    const top = Math.max(0, band.y - 12),
      bottom = Math.min(height, band.y + band.height * 1.3 + 12)
    if (right <= left || bottom <= top) continue
    for (let row = Math.floor(top / size); row < Math.ceil(bottom / size); row++)
      for (let col = Math.floor(left / size); col < Math.ceil(right / size); col++) {
        const key = col + ':' + row
        let tile = tiles.get(key)
        if (!tile) {
          tile = {
            key,
            x: col * size,
            y: row * size,
            width: Math.min(size, width - col * size),
            height: Math.min(size, height - row * size),
            bands: []
          }
          tiles.set(key, tile)
        }
        tile.bands.push(band)
      }
  }
  return [...tiles.values()]
}
