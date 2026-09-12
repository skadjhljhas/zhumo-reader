import type { ManuscriptProfile } from './profile'

/** Only optical controls interpolate. The real manuscript and its statistics do not. */
export class ProfileTransition {
  readonly values = new Float32Array(16)
  private readonly target = new Float32Array(16)
  private profile: ManuscriptProfile | undefined
  private previousTime: number | undefined
  private initialized = false
  private pending = false

  update(profile: ManuscriptProfile, time: number, smooth: boolean): boolean {
    if (profile !== this.profile) {
      this.profile = profile
      this.target.set([
        profile.volume,
        profile.annotation,
        profile.depth,
        profile.spread,
        profile.rhythm,
        profile.interconnection,
        profile.noteDensity,
        0,
        ...profile.spectrum
      ])
      this.pending = true
    }
    const delta =
      this.previousTime === undefined ? 0 : Math.max(0, Math.min(0.25, time - this.previousTime))
    this.previousTime = time
    if (!this.pending) return false
    if (!this.initialized || !smooth) {
      this.values.set(this.target)
      this.initialized = true
      this.pending = false
      return true
    }
    const amount = -Math.expm1(-delta / 0.42)
    if (amount === 0) return false
    let error = 0
    for (let i = 0; i < this.values.length; i++) {
      this.values[i] += (this.target[i] - this.values[i]) * amount
      error = Math.max(error, Math.abs(this.target[i] - this.values[i]))
    }
    if (error < 0.00001) {
      this.values.set(this.target)
      this.pending = false
    }
    return true
  }
}
