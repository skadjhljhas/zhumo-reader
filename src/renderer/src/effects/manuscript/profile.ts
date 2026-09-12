/** Bounded, continuous controls. These describe written structure, not intellectual merit. */
export interface ManuscriptMeasure {
  bodyChars: number
  paragraphs: number[]
  notes: Array<{ chars: number; level: number; parents: number; refs: number; positions: number[] }>
}
export interface ManuscriptProfile {
  bodyChars: number
  noteChars: number
  noteCount: number
  maxDepth: number
  volume: number
  annotation: number
  depth: number
  spread: number
  rhythm: number
  interconnection: number
  noteDensity: number
  /** Four complex moments of reference positions: order survives aggregate counts. */
  spectrum: number[]
}
const unit = (x: number): number => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))
const positive = (x: number): number => (Number.isFinite(x) ? Math.max(0, x) : 0)

export function manuscriptProfile(input: ManuscriptMeasure): ManuscriptProfile {
  const bodyChars = positive(input.bodyChars)
  let noteChars = 0,
    weightedDepth = 0,
    depthWeight = 0,
    maxDepth = 0,
    edges = 0,
    references = 0
  let weightSum = 0
  const bins = new Array<number>(12).fill(0)
  const spectrum = new Array<number>(8).fill(0)
  for (const note of input.notes) {
    const chars = positive(note.chars),
      level = Math.max(1, positive(note.level))
    const weight = 1 + Math.log1p(chars / 80)
    noteChars += chars
    maxDepth = Math.max(maxDepth, level)
    weightedDepth += (level - 1) * weight
    depthWeight += weight
    edges += positive(note.parents) + Math.max(0, positive(note.refs) - 1)
    references += Math.max(1, positive(note.refs))
    for (const location of note.positions) {
      const position = unit(location)
      bins[Math.min(11, Math.floor(position * 12))] += weight
      weightSum += weight
      for (let k = 1; k <= 4; k++) {
        spectrum[(k - 1) * 2] += weight * Math.cos(2 * Math.PI * k * position)
        spectrum[(k - 1) * 2 + 1] += weight * Math.sin(2 * Math.PI * k * position)
      }
    }
  }
  let entropy = 0
  if (weightSum) {
    for (const mass of bins) {
      const p = mass / weightSum
      if (p > 0) entropy -= p * Math.log(p)
    }
    for (let i = 0; i < spectrum.length; i++) spectrum[i] /= weightSum
  }
  const lengths = input.paragraphs.map(positive).filter(Boolean)
  const mean = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, lengths.length)
  const variance =
    lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / Math.max(1, lengths.length)
  const variation = Math.sqrt(variance) / Math.max(1, mean)
  const logVolume = Math.log1p((bodyChars + noteChars) / 512)
  const depth = Math.log1p(weightedDepth / Math.max(1, depthWeight))
  return {
    bodyChars,
    noteChars,
    noteCount: input.notes.length,
    maxDepth,
    volume: logVolume / (logVolume + 2.6),
    annotation: noteChars / Math.max(1, bodyChars + noteChars),
    depth: depth / (1 + depth),
    spread: unit(entropy / Math.log(12)),
    rhythm: variation / (1 + variation),
    interconnection: edges / Math.max(1, edges + references),
    noteDensity: input.notes.length / (input.notes.length + 2 * Math.max(1, bodyChars / 1000)),
    spectrum
  }
}

export function freshLightSeed(): number[] {
  // Four independent 32-bit words; never reseed per frame or on scrolling.
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n / 4294967296)
}
