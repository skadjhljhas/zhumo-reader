/** Integrate visible elapsed time, including slow frames. Explicit suspension
 * preserves the phase; unexpectedly long visible frames advance by a bounded step. */
export class MotionClock {
  private previous: number | undefined
  private elapsed = 0

  sample(now: number, running = true): number {
    if (!running || !Number.isFinite(now)) {
      this.suspend()
      return this.elapsed
    }
    if (this.previous !== undefined) {
      const delta = now - this.previous
      // Never discard a visible frame just because rendering took longer than
      // 250 ms: repeated slow frames would otherwise freeze the entire field.
      // Visibility/pause handlers call suspend(); bound unexpected stalls here
      // without treating low frame rates as an indefinitely suspended window.
      if (delta >= 0) this.elapsed += Math.min(delta, 1000) / 1000
    }
    this.previous = now
    return this.elapsed
  }
  suspend(): void {
    this.previous = undefined
  }
  seek(seconds: number): void {
    this.elapsed = Number.isFinite(seconds) ? Math.max(0, seconds) : this.elapsed
    this.suspend()
  }
}
