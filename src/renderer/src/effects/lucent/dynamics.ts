import { seasonLight } from '../manuscript/season'
import type { ManuscriptProfile } from '../manuscript/profile'
import { SkylightTrajectory } from './skylight'

/** Time spent with this document visible in reading mode; never a claim of comprehension. */
export class VisibleReadingClock {
  private accumulated = 0
  private since = 0
  private active = false
  setActive(now: number, active: boolean): void {
    this.accumulated = this.seconds(now)
    this.since = now
    this.active = active
  }
  reset(now: number): void {
    this.accumulated = 0
    this.since = now
  }
  seconds(now: number): number {
    return this.accumulated + (this.active ? Math.max(0, now - this.since) / 1000 : 0)
  }
}

export interface LucentFieldInput {
  wallTime: number
  readingSeconds: number
  progress: number
  profile: ManuscriptProfile | null
  seed: number
  encounter?: number[]
  navigation?: [number, number, number, number]
  habits?: { textShare: number; dwell: number; stillness: number; switches: number }
  hover: { strength: number; depth: number; x: number; y: number }
}
const unit = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
/** Smooth bounded uniforms, including circular calendar coordinates and slow hover release. */
export class LucentFieldDynamics {
  readonly values = new Float32Array(32)
  private skylight = new SkylightTrajectory()
  readonly sky = this.skylight.values
  private previous: number | undefined
  private initialized = false
  sample(now: number, input: LucentFieldInput, moving = true): Float32Array {
    const climate = seasonLight(new Date(input.wallTime))
    const log = Math.log1p(Math.max(0, input.readingSeconds) / 90)
    const profile = input.profile
    const target = [
      ...climate,
      log / (log + 2.4),
      unit(input.progress),
      profile?.volume ?? 0,
      profile?.annotation ?? 0,
      unit(input.hover.strength),
      unit(input.hover.depth / 6),
      unit(input.hover.x),
      unit(input.hover.y),
      profile?.spread ?? 0,
      profile?.rhythm ?? 0.4,
      profile?.interconnection ?? 0,
      unit(input.seed),
      profile?.depth ?? 0,
      profile?.noteDensity ?? 0,
      profile?.spectrum[0] ?? 0,
      profile?.spectrum[1] ?? 0,
      ...[0, 1, 2, 3].map((index) =>
        unit(input.encounter?.[index] ?? [input.seed, 0.37, 0.61, 0.83][index])
      ),
      unit(input.habits?.textShare ?? 0.5),
      unit((input.habits?.dwell ?? 0) / 30),
      unit(input.habits?.stillness ?? 0),
      Math.tanh(Math.max(0, input.habits?.switches ?? 0) / 40),
      ...(input.navigation ?? [0, 0, 0, 0.5])
    ]
    const dt =
      this.previous === undefined ? 0 : Math.max(0, Math.min(1, (now - this.previous) / 1000))
    this.previous = now
    for (let i = 0; i < 32; i++) {
      const value = Number.isFinite(target[i]) ? target[i] : 0
      if (!this.initialized || !moving) this.values[i] = value
      else {
        const seconds =
          i >= 28
            ? 2.8
            : i >= 24
              ? 4.5
              : i < 4
                ? 7
                : i === 8
                  ? value > this.values[i]
                    ? 1.1
                    : 5
                  : i < 8
                    ? 4
                    : i < 12
                      ? 2.4
                      : 6
        this.values[i] += (value - this.values[i]) * -Math.expm1(-dt / seconds)
      }
    }
    this.initialized = true
    this.skylight.sample(now, this.values, moving)
    return this.values
  }
  suspend(): void {
    this.previous = undefined
    this.skylight.suspend()
  }
}
