import { echoHash } from './echo-metrics'
import { tidalPlaceKey, type TidalPlace } from '../composables/tidalPlaces'

/** Inputs shared by both themes. Habits only nudge; addresses decide where light gathers. */
export interface EchoMapContext {
  textShare: number
  reversals: number
  switches: number
  readingSeconds: number
  phase: number
  tide: boolean
  /** Wall time used to age records. Defaults to now. */
  now?: number
  /** Manuscript volume 0..1 (log-saturated). Moves the tide horizon / lucent fan width. */
  volume?: number
}
/** One remembered stop as a light source. Coordinates are 0..1 in chart space, y downward. */
export interface EchoStar {
  place: TidalPlace
  key: string
  x: number
  y: number
  /** Legacy magnitude used by hit targets and tests. */
  radius: number
  warmth: number
  phase: number
  /** 0 close, 1 far (notes sit far). */
  depth: number
  /** 0 fresh, 1 about a week old. */
  age: number
  /** Local hour of the record / 24. Night reads as moonlight, day as sunlight. */
  hour: number
  /** Peak dwell 0..1 (15 s saturates). */
  magnitude: number
  /** Accumulated dwell, log-saturated 0..1. */
  breadth: number
  /** Text-vs-air share when recorded, or the current habit. */
  sharpness: number
  /** Visits, log-saturated 0..1. */
  visits: number
  kind: 0 | 1
}
export const ECHO_STAR_TEXELS = 3
const WEEK = 7 * 86400000
const unit = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))

export function tideHorizon(volume = 0.4): number {
  return 0.22 + 0.1 * unit(volume)
}
/** Tide: a night sea. Reading order runs across the water, notes sit nearer the horizon. */
function tidePoint(
  u: number,
  h: number,
  j: number,
  kind: 0 | 1,
  drift: number,
  volume: number
): { x: number; y: number; depth: number } {
  const depth = kind ? 0.8 + 0.2 * j : j * 0.75
  return {
    x: unit(0.07 + 0.86 * u + (h - 0.5) * 0.05 + drift),
    y: unit(tideHorizon(volume) + 0.03 + (1 - depth) * 0.3),
    depth
  }
}
/** Lucent: foci on a reading arc that crosses the beam from beyond the top-right corner.
 * The hash moves a stop along the beam (toward or away from the emitter), so the short
 * caustic strokes never line up into one continuous ray. Notes sit farther from the light. */
function lucentPoint(
  u: number,
  h: number,
  j: number,
  kind: 0 | 1,
  drift: number,
  volume: number
): { x: number; y: number; depth: number } {
  const spread = 0.26 + 0.12 * unit(volume)
  const bow = 4 * u * (1 - u)
  const along = (j - 0.5) * spread + kind * 0.12
  // The arc runs upper-left to lower-right; "along" points down-left, away from the emitter.
  const x = 0.16 + 0.68 * u - along * 0.55 + (h - 0.5) * 0.03 + drift
  const y = 0.3 + 0.4 * u - 0.09 * bow + along * 0.78
  return { x: unit(x), y: unit(y), depth: unit(0.35 + along * 1.4 + kind * 0.2) }
}
export function echoConstellation(places: TidalPlace[], context: EchoMapContext): EchoStar[] {
  const now = context.now ?? Date.now()
  const volume = context.volume ?? 0.4
  const drift =
    (unit(context.textShare) - 0.5) * 0.02 + Math.tanh(Math.max(0, context.reversals) / 16) * 0.01
  return places.map((place) => {
    const key = tidalPlaceKey(place),
      h = echoHash(key),
      j = echoHash(key + 'orbit'),
      k = echoHash(key + 'phase')
    const kind: 0 | 1 = place.address.origin.kind === 'note' ? 1 : 0
    const peak = Math.min(1, (place.echo?.peakMs ?? 2000) / 15000)
    const total = Math.log1p((place.echo?.dwellMs ?? place.echo?.peakMs ?? 2000) / 15000)
    const visits = Math.log1p(place.visits) / (Math.log1p(place.visits) + 2)
    const at = new Date(place.at)
    const point = (context.tide ? tidePoint : lucentPoint)(
      unit(place.position),
      h,
      j,
      kind,
      drift,
      volume
    )
    return {
      place,
      key,
      x: point.x,
      y: point.y,
      radius: 0.08 + 0.1 * peak + 0.08 * visits,
      warmth: unit(0.6 * peak + 0.3 * visits + 0.05 + 0.05 * Math.sin(context.phase)),
      phase: k,
      depth: point.depth,
      age: unit(1 - Math.exp(-Math.max(0, now - place.at) / WEEK)),
      hour: (at.getHours() + at.getMinutes() / 60) / 24,
      magnitude: 0.3 + 0.7 * peak,
      breadth: total / (total + 1),
      sharpness: unit(place.echo?.textShare ?? context.textShare),
      visits,
      kind
    }
  })
}
/** Where the light of the current, still unrecorded stop begins to gather. */
export function echoLivePoint(
  progress: number,
  tide: boolean,
  volume = 0.4
): { x: number; y: number } {
  const point = (tide ? tidePoint : lucentPoint)(unit(progress), 0.5, 0.45, 0, 0, volume)
  return { x: point.x, y: point.y }
}
/** Pack stars into an RGBA8 texture: three texels per star, all channels 0..1. */
export function packEchoStars(stars: EchoStar[], out?: Uint8Array): Uint8Array {
  const rows = Math.max(1, stars.length)
  const bytes =
    out && out.length >= rows * ECHO_STAR_TEXELS * 4
      ? out
      : new Uint8Array(rows * ECHO_STAR_TEXELS * 4)
  bytes.fill(0)
  stars.forEach((s, i) => {
    const values = [
      s.x,
      s.y,
      s.magnitude,
      s.warmth,
      s.phase,
      s.depth,
      s.age,
      s.hour,
      s.breadth,
      s.sharpness,
      s.visits,
      s.kind
    ]
    for (let c = 0; c < values.length; c++)
      bytes[i * ECHO_STAR_TEXELS * 4 + c] = Math.round(unit(values[c]) * 255)
  })
  return bytes
}
