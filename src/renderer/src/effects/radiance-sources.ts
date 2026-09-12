import type { ColorLayer } from './color-band'
const sources = new Map<object, ColorLayer[]>()
const listeners = new Set<() => void>()
export function setRadianceSources(owner: object, layers: ColorLayer[]): void {
  const luminous = layers.filter((layer) =>
    layer.bands.some((band) => (band.ink.mark.radiance ?? 0) > 0)
  )
  if (luminous.length) sources.set(owner, luminous)
  else sources.delete(owner)
  listeners.forEach((listener) => listener())
}
export function radianceSources(): IterableIterator<ColorLayer[]> {
  return sources.values()
}
export function watchRadianceSources(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
