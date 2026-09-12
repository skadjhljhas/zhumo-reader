import type { ManuscriptProfile } from './profile'

export interface FallbackStroke {
  path: string
  opacity: number
}
/** Open static paths when GPU rendering is unavailable. No text is duplicated. */
export function fallbackStrokes(
  profile: ManuscriptProfile | null,
  seed: number[],
  tide: boolean
): FallbackStroke[] {
  if (!profile) return []
  const volume = profile.volume,
    notes = Math.sqrt(profile.annotation),
    depth = profile.depth
  const count = Math.round(3 + volume * 2 + notes * 2 + depth)
  const phase = (seed[1] ?? 0) * Math.PI * 2
  const span = (125 + volume * 75) * (0.95 + (seed[2] ?? 0.5) * 0.1)
  const slope = ((seed[0] ?? 0.5) - 0.5) * 14
  const frequency = 1.2 + (seed[3] ?? 0.5) * 0.3
  return Array.from({ length: count }, (_, i) => {
    const lane = (i - (count - 1) / 2) / count
    const points = Array.from({ length: 81 }, (_, j) => {
      const u = (j / 80 - 0.5) * 2
      const x = 220 + u * span
      let shape = 0
      for (let k = 1; k <= 4; k++)
        shape +=
          (profile.spectrum[(k - 1) * 2] * Math.cos(u * k) +
            profile.spectrum[(k - 1) * 2 + 1] * Math.sin(u * k)) /
          (k * k)
      const y = tide
        ? 120 +
          lane * (58 + notes * 46) +
          Math.sin(u * frequency + phase + i * 0.16) * 11 +
          slope * u +
          shape * (4 + depth * 8)
        : 120 -
          u * 36 +
          lane * (30 + notes * 34) +
          Math.sin(u * (frequency + 0.45) + phase) * 13 +
          slope * u +
          shape * (5 + depth * 10)
      return (j === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
    })
    return {
      path: points.join(' '),
      opacity: 0.32 + 0.18 * (0.5 + 0.5 * Math.sin(i * 1.4 + phase))
    }
  })
}
