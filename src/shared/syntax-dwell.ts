/** Monotonic, continuous on-screen dwell. Hidden time and long stalled frames never count. */
export class SyntaxDwell {
  private at: number | undefined
  private durations = new Map<string, number>()
  reset(): void {
    this.at = undefined
    this.durations.clear()
  }
  tick(now: number, visible: string[], enabled: boolean, waitMs = 5000): string[] {
    const threshold = Number.isFinite(waitMs) ? Math.max(1000, Math.min(15000, waitMs)) : 5000
    const dt = this.at === undefined ? 0 : Math.max(0, Math.min(750, now - this.at))
    this.at = now
    if (!enabled) {
      this.durations.clear()
      return []
    }
    const keys = new Set(visible)
    for (const key of this.durations.keys()) if (!keys.has(key)) this.durations.delete(key)
    for (const key of visible) this.durations.set(key, (this.durations.get(key) ?? -dt) + dt)
    return visible.filter((key) => this.durations.get(key)! >= threshold)
  }
}
