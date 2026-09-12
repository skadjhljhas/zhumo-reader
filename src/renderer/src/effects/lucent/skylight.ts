const TAU = Math.PI * 2
const smooth = (t: number): number => t * t * t * (10 + t * (-15 + 6 * t))
const clamp = (v: number, low: number, high: number): number => Math.min(high, Math.max(low, v))
const wrap = (angle: number): number => ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI
function hash(index: number, seed: number): number {
  let value = Math.imul(index ^ seed, 0x45d9f3b)
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296
}
function noise(time: number, seed: number): number {
  const i = Math.floor(time),
    f = smooth(time - i)
  return 2 * (hash(i, seed) * (1 - f) + hash(i + 1, seed) * f) - 1
}
/** A positive circular mixture: upper-right dominates, the upper half is favoured,
 * and every direction retains nonzero probability. Angles use screen coordinates. */
export function skylightDensity(angle: number): number {
  return (
    0.18 +
    2.6 * Math.exp(2.7 * (Math.cos(angle + Math.PI / 4) - 1)) +
    0.62 * Math.exp(Math.cos(angle + Math.PI / 2) - 1)
  )
}
const samples = 2048,
  cumulative = new Float64Array(samples + 1)
for (let i = 1; i <= samples; i++) {
  const a = -Math.PI + (TAU * (i - 1)) / samples,
    b = -Math.PI + (TAU * i) / samples
  cumulative[i] = cumulative[i - 1] + (skylightDensity(a) + skylightDensity(b)) * 0.5
}
const mass = cumulative[samples]
export function skylightQuantile(unit: number): number {
  const value = clamp(unit, 0, 1) * mass
  let left = 0,
    right = samples
  while (right - left > 1) {
    const mid = (left + right) >>> 1
    if (cumulative[mid] < value) left = mid
    else right = mid
  }
  const f = (value - cumulative[left]) / (cumulative[right] - cumulative[left])
  return -Math.PI + ((left + f) * TAU) / samples
}

/** Biased random C² angular bridges, with distance-dependent duration and bounded
 * multiscale drift. Motion changes parameters of light; it never translates with scroll. */
export class SkylightTrajectory {
  readonly values = new Float32Array(8)
  private previous: number | undefined
  private age = 0
  private from = 0
  private delta = 0
  private since = 0
  private duration = 0
  private residence = 0
  private serial = 0
  private initialized = false
  private controls = [new Float64Array(4), new Float64Array(4), new Float64Array(4)]
  constructor(private seed = crypto.getRandomValues(new Uint32Array(1))[0]) {
    this.from =
      this.random() < 0.86
        ? (-Math.PI / 2) * (0.18 + this.random() * 0.64)
        : skylightQuantile(this.random())
    this.next()
  }
  private random(): number {
    return hash(++this.serial, this.seed)
  }
  private next(): void {
    this.delta = wrap(skylightQuantile(this.random()) - this.from)
    const angle = wrap(this.from)
    // Bias time actually spent in each direction, not just the sampled destinations.
    this.residence =
      angle > -Math.PI / 2 && angle < 0
        ? 1200 + this.random() * 1200
        : angle < 0
          ? 110 + this.random() * 170
          : 35 + this.random() * 80
    this.duration = 480 + Math.abs(this.delta) * 330 + this.random() * 120
    this.since = this.age
  }
  sample(now: number, field: Float32Array, moving = true): Float32Array {
    const dt = this.previous === undefined ? 0 : clamp((now - this.previous) / 1000, 0, 1)
    this.previous = now
    if (moving)
      this.age +=
        dt *
        clamp(
          0.9 -
            0.14 * field[6] -
            0.08 * field[26] -
            0.04 * field[4] +
            0.14 * field[29] +
            0.05 * field[27],
          0.6,
          1.15
        )
    if (this.age - this.since >= this.residence + this.duration) {
      this.from += this.delta
      this.next()
    }
    const target = [
      0.035 * field[0] +
        0.03 * field[4] +
        0.045 * field[28] +
        0.025 * (field[24] - 0.5) +
        0.025 * field[8] * (field[10] - 0.5),
      0.045 * (field[12] - 0.5) + 0.018 * field[8] * (field[10] - 0.5) + 0.02 * field[30],
      0.04 * (field[5] - 0.5) + 0.018 * field[28] + 0.018 * field[14],
      0.26 * field[3] + 0.12 * (field[6] - 0.5) + 0.1 * field[7] + 0.08 * (field[25] - 0.5)
    ]
    for (let i = 0; i < 4; i++) {
      if (!this.initialized) for (const filter of this.controls) filter[i] = target[i]
      else
        for (let stage = 0; stage < 3; stage++)
          this.controls[stage][i] +=
            ((stage ? this.controls[stage - 1][i] : target[i]) - this.controls[stage][i]) *
            -Math.expm1(-dt / 9)
    }
    this.initialized = true
    const control = this.controls[2]
    const phase = clamp((this.age - this.since - this.residence) / this.duration, 0, 1)
    const angle =
      this.from +
      this.delta * smooth(phase) +
      0.022 * noise(this.age / 150, this.seed ^ 731) +
      control[0]
    const x = Math.cos(angle),
      y = Math.sin(angle)
    const radius =
      (2.25 + 0.12 * noise(this.age / 340, this.seed ^ 911)) / (x ** 8 + y ** 8) ** (1 / 8)
    this.values.set([
      0.5 + x * radius,
      0.5 + y * radius,
      0.5 + 0.045 * noise(this.age / 230, this.seed ^ 37) + control[1],
      0.5 + 0.04 * noise(this.age / 310, this.seed ^ 59) + control[2],
      clamp(control[3] + 0.21 * noise(this.age / 470, this.seed ^ 271), -1, 1),
      clamp(
        0.48 + 0.15 * noise(this.age / 290, this.seed ^ 613) + 0.08 * field[7] + 0.04 * field[8],
        0.2,
        0.8
      ),
      0.94 + 0.055 * noise(this.age / 380, this.seed ^ 431) + 0.025 * field[4],
      -y
    ])
    return this.values
  }
  suspend(): void {
    this.previous = undefined
  }
}
