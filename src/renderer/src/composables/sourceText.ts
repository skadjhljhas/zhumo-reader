export interface SourceChange {
  from: number
  to: number
  insert: string
}
export function normalizeSource(source: string): string {
  return source.replace(/\r\n?|\n/g, '\n')
}
/** CodeMirror uses LF offsets. Apply transactions to original bytes without rewriting untouched EOLs. */
export function applySourceChanges(source: string, changes: SourceChange[]): string {
  const extra: number[] = []
  let normalized = 0
  for (let i = 0; i < source.length; i++, normalized++) {
    if (source[i] === '\r' && source[i + 1] === '\n') {
      extra.push(normalized)
      i++
    }
  }
  const rawOffset = (position: number): number => {
    let lo = 0,
      hi = extra.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (extra[mid] < position) lo = mid + 1
      else hi = mid
    }
    return position + lo
  }
  const endings = source.match(/\r\n|\r|\n/g) ?? []
  const counts = new Map<string, number>()
  for (const eol of endings) counts.set(eol, (counts.get(eol) ?? 0) + 1)
  const eol = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n'
  let output = source
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    output =
      output.slice(0, rawOffset(change.from)) +
      change.insert.replace(/\n/g, eol) +
      output.slice(rawOffset(change.to))
  }
  return output
}
