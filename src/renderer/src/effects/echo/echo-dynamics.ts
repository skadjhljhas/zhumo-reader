/** Slow, bounded uniforms for the echo field. Sixteen channels:
 *  0..3   habits   textShare, switches (tanh), reversals (tanh), immersion (log)
 *  4..7   flow     scroll direction, activity, return impulse, text share (already decaying)
 *  8..11  climate  seasonLight: sin/cos solar longitude, sin/cos local day
 *  12..15 live     x, y, strength, session revisits / 3
 */
export class EchoFieldDynamics {
  readonly values = new Float32Array(16)
  private previous: number | undefined
  private initialized = false
  private static readonly SECONDS = [
    3.5, 5, 5, 8, 2.4, 2.4, 2.4, 3.5, 30, 30, 30, 30, 1.8, 1.8, 0.9, 2
  ]
  sample(now: number, target: ArrayLike<number>, moving = true): Float32Array {
    const dt =
      this.previous === undefined ? 0 : Math.max(0, Math.min(1, (now - this.previous) / 1000))
    this.previous = now
    for (let i = 0; i < 16; i++) {
      const value = Number.isFinite(target[i]) ? target[i] : 0
      if (!this.initialized || !moving) this.values[i] = value
      else
        this.values[i] += (value - this.values[i]) * -Math.expm1(-dt / EchoFieldDynamics.SECONDS[i])
    }
    this.initialized = true
    return this.values
  }
  suspend(): void {
    this.previous = undefined
  }
}
/** How many times this session already lingered on a word. A real count, not a claim
 * about understanding: returning changes how long the light stays. */
export class EchoRevisits {
  private readonly counts = new Map<string, number>()
  count(key: string): number {
    return this.counts.get(key) ?? 0
  }
  mark(key: string): number {
    const next = this.count(key) + 1
    this.counts.set(key, next)
    return next
  }
  reset(): void {
    this.counts.clear()
  }
}
