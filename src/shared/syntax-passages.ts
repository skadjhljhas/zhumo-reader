export interface SyntaxRegion {
  kind: 'math' | 'code'
  start: number
  end: number
}
export interface SyntaxTarget {
  regions: SyntaxRegion[]
  beginsMidSentence: boolean
  endsMidSentence: boolean
}
export interface SyntaxPassage {
  start: number
  end: number
  sentenceStart: number
  sentenceEnd: number
}
/** Lazily refine an oversized reading window; children retain the original sentence bounds.
 * Refinement is anchored to source text, never to the current scroll offset. */
export function syntaxPassageChildren(
  text: string,
  regions: SyntaxRegion[],
  parent: SyntaxPassage
): SyntaxPassage[] {
  if (parent.end - parent.start <= 60) return []
  const local = regions
    .filter((r) => r.start >= parent.start && r.end <= parent.end)
    .map((r) => ({ ...r, start: r.start - parent.start, end: r.end - parent.start }))
  return syntaxPassages(
    text.slice(parent.start, parent.end),
    local,
    Math.max(40, Math.floor((parent.end - parent.start) / 2))
  )
    .map((p) => ({
      start: parent.start + p.start,
      end: parent.start + p.end,
      sentenceStart: parent.sentenceStart,
      sentenceEnd: parent.sentenceEnd
    }))
    .filter((p) => p.start > parent.start || p.end < parent.end)
}
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const inside = (offset: number, regions: SyntaxRegion[]): boolean =>
  regions.some((r) => offset > r.start && offset < r.end)
export function syntaxHasProse(
  text: string,
  regions: SyntaxRegion[],
  start = 0,
  end = text.length
): boolean {
  let at = start,
    prose = ''
  for (const r of regions) {
    if (r.end <= start || r.start >= end) continue
    prose += text.slice(at, Math.max(at, r.start))
    at = Math.max(at, Math.min(end, r.end))
  }
  return /[\p{L}\p{N}]/u.test(prose + text.slice(at, end))
}
/** Stable, source-based windows, independent of scroll position. Atomic formula/code spans
 * cannot introduce sentence boundaries or be sliced into invented linguistic tokens. */
export function syntaxPassages(
  text: string,
  regions: SyntaxRegion[],
  budget = 480
): SyntaxPassage[] {
  let masked = '',
    at = 0
  for (const r of regions) {
    masked += text.slice(at, r.start) + '\uFFFC'.repeat(r.end - r.start)
    at = r.end
  }
  masked += text.slice(at)
  const result: SyntaxPassage[] = []
  for (const sentence of sentences.segment(masked)) {
    const first = sentence.index,
      last = first + sentence.segment.length
    let start = first
    while (start < last) {
      let end = last
      if (last - start > budget) {
        const upper = Math.min(last, start + budget)
        const clause = [...masked.slice(start, upper).matchAll(/[，,；;：:、—]/gu)]
          .map((m) => start + m.index + m[0].length)
          .filter((p) => p > start + budget * 0.45 && !inside(p, regions))
        const word = [...words.segment(masked.slice(start, upper))]
          .map((w) => start + w.index)
          .filter((p) => p > start + budget * 0.45 && !inside(p, regions))
        end = clause.at(-1) ?? word.at(-1) ?? upper
        if (inside(end, regions)) {
          const atom = regions.find((r) => end > r.start && end < r.end)!
          end = atom.start > start ? atom.start : atom.end
        }
        // Avoid cutting an emoji, combining mark or surrogate pair at a fallback boundary.
        if (!inside(end, regions) && !regions.some((r) => r.end === end)) {
          const boundary = [...graphemes.segment(text.slice(start, end + 32))]
            .map((g) => start + g.index)
            .filter((p) => p <= end)
            .at(-1)
          if (boundary !== undefined && boundary > start) end = boundary
        }
      }
      if (end <= start) break
      let a = start,
        b = end
      while (a < b && /\s/u.test(text[a]) && !regions.some((r) => r.start <= a && r.end > a)) a++
      while (b > a && /\s/u.test(text[b - 1]) && !regions.some((r) => r.start < b && r.end >= b))
        b--
      if (b - a >= 4 && b - a <= 12000 && syntaxHasProse(text, regions, a, b))
        result.push({ start: a, end: b, sentenceStart: first, sentenceEnd: last })
      start = end
    }
  }
  return result
}
