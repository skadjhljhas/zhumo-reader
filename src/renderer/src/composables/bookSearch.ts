export type SearchKind = 'section' | 'note'
export type SearchScope = 'all' | SearchKind

export interface SearchEntry {
  id: string
  kind: SearchKind
  title: string
  text: string
  blockIndex: number
  /** Character position within the body or annotation stream, respectively. */
  position: number
}
export interface SearchIndex {
  entries: SearchEntry[]
  lengths: Record<SearchKind, number>
}
export interface SearchOccurrence {
  entryIndex: number
  start: number
  end: number
  ordinal: number
}
interface MatchGroup {
  entryIndex: number
  starts: number[]
  /** Zero-based ordinal of the first occurrence in this paragraph. */
  first: number
}
export interface SearchBin {
  count: number
  first: number
}
export interface BookSearch {
  query: string
  total: number
  paragraphs: number
  counts: Record<SearchKind, number>
  bins: Record<SearchKind, SearchBin[]>
  at: (ordinal: number) => SearchOccurrence | undefined
  page: (offset: number, size: number) => SearchOccurrence[]
}
export const SEARCH_PAGE_SIZE = 24
export const SEARCH_BINS = 64

/** Literal matching on the original string preserves UTF-16 DOM offsets.
 * Lowercasing whole strings first can change their length (for example İ).
 * Escaping every RegExp metacharacter also makes TeX/code searches literal.
 */
export function literalPattern(query: string, caseSensitive = false): RegExp | null {
  const term = query.trim()
  return term
    ? new RegExp(term.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
    : null
}

/** Retain compact offset lists, not a text/DOM copy for every occurrence.
 * Pagination changes only what is displayed; all matches stay reachable.
 */
export function searchBook(
  index: SearchIndex,
  query: string,
  scope: SearchScope = 'all',
  caseSensitive = false
): BookSearch {
  const pattern = literalPattern(query, caseSensitive)
  const groups: MatchGroup[] = []
  const bins = {
    section: Array.from({ length: SEARCH_BINS }, () => ({ count: 0, first: -1 })),
    note: Array.from({ length: SEARCH_BINS }, () => ({ count: 0, first: -1 }))
  }
  const counts = { section: 0, note: 0 }
  let total = 0
  if (pattern) {
    index.entries.forEach((entry, entryIndex) => {
      if (scope !== 'all' && entry.kind !== scope) return
      const starts: number[] = []
      pattern.lastIndex = 0
      for (let match = pattern.exec(entry.text); match; match = pattern.exec(entry.text)) {
        starts.push(match.index)
        const position = (entry.position + match.index) / Math.max(1, index.lengths[entry.kind])
        const bin = bins[entry.kind][Math.min(SEARCH_BINS - 1, Math.floor(position * SEARCH_BINS))]
        if (bin.first < 0) bin.first = total + starts.length - 1
        bin.count++
      }
      if (starts.length) {
        groups.push({ entryIndex, starts, first: total })
        total += starts.length
        counts[entry.kind] += starts.length
      }
    })
  }
  function at(ordinal: number): SearchOccurrence | undefined {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= total) return
    let lo = 0,
      hi = groups.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (groups[mid].first <= ordinal) lo = mid
      else hi = mid - 1
    }
    const group = groups[lo]
    const start = group.starts[ordinal - group.first]
    return { entryIndex: group.entryIndex, start, end: start + query.trim().length, ordinal }
  }
  return {
    query: query.trim(),
    total,
    paragraphs: groups.length,
    counts,
    bins,
    at,
    page(offset, size) {
      const from = Math.max(0, Math.floor(offset))
      const length = Math.max(0, Math.min(Math.floor(size), total - from))
      return Array.from({ length }, (_, i) => at(from + i)!)
    }
  }
}

/** Bounded original-text context around a particular occurrence, not just the
 * first occurrence in its paragraph. Cuts never split a surrogate pair.
 */
export function occurrenceContext(
  text: string,
  occurrence: Pick<SearchOccurrence, 'start' | 'end'>,
  before = 45,
  after = 85
): { before: string; match: string; after: string; leading: boolean; trailing: boolean } {
  let from = Math.max(0, occurrence.start - before),
    to = Math.min(text.length, occurrence.end + after)
  if (/[\uDC00-\uDFFF]/.test(text[from] ?? '')) from++
  if (/[\uD800-\uDBFF]/.test(text[to - 1] ?? '')) to--
  return {
    before: text.slice(from, occurrence.start),
    match: text.slice(occurrence.start, occurrence.end),
    after: text.slice(occurrence.end, to),
    leading: from > 0,
    trailing: to < text.length
  }
}
