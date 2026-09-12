export const ECHO_START_SECONDS = 3

/** A delayed, smooth visual response: silent before 3 s, fully developed at 15 s. */
export function echoEnvelope(seconds: number): number {
  const t = Math.max(0, Math.min(1, (seconds - ECHO_START_SECONDS) / (15 - ECHO_START_SECONDS)))
  return t * t * (3 - 2 * t)
}
export interface EchoHabitsSnapshot {
  textSeconds: number
  airSeconds: number
  switches: number
  scrollDistance: number
  reversals: number
  textShare: number
  direction: number
  activity: number
  returnImpulse: number
}
export class EchoHabits {
  private previous = 0
  private region = ''
  private lastDirection = 0
  readonly value: EchoHabitsSnapshot = {
    textSeconds: 0,
    airSeconds: 0,
    switches: 0,
    scrollDistance: 0,
    reversals: 0,
    textShare: 0.5,
    direction: 0,
    activity: 0,
    returnImpulse: 0
  }
  sample(now: number, region: 'text' | 'air' | 'outside'): EchoHabitsSnapshot {
    const dt = this.previous ? Math.max(0, Math.min(0.25, (now - this.previous) / 1000)) : 0
    this.previous = now
    if (region === 'text') this.value.textSeconds += dt
    if (region === 'air') this.value.airSeconds += dt
    if (this.region && region !== 'outside' && this.region !== 'outside' && this.region !== region)
      this.value.switches++
    this.region = region
    const total = this.value.textSeconds + this.value.airSeconds
    this.value.textShare = total ? this.value.textSeconds / total : 0.5
    this.value.direction *= Math.exp(-dt / 7)
    this.value.activity *= Math.exp(-dt / 9)
    this.value.returnImpulse *= Math.exp(-dt / 12)
    return this.value
  }
  scroll(delta: number, height: number): void {
    if (!Number.isFinite(delta) || Math.abs(delta) < 2) return
    const direction = Math.sign(delta),
      charge = Math.min(0.35, Math.abs(delta) / Math.max(200, height))
    if (this.lastDirection && this.lastDirection !== direction) {
      this.value.reversals++
      this.value.returnImpulse = Math.min(1, this.value.returnImpulse + 0.14)
    }
    this.lastDirection = direction
    this.value.scrollDistance += Math.abs(delta) / Math.max(200, height)
    this.value.direction = Math.max(
      -1,
      Math.min(1, this.value.direction + direction * charge * 0.65)
    )
    this.value.activity = Math.min(1, this.value.activity + charge)
  }
  suspend(): void {
    this.previous = 0
    this.region = ''
  }
}
export function echoHash(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0) / 4294967296
}
