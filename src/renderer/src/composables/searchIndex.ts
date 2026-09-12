import type { ParsedBook } from '../../../shared/types'
import type { SearchIndex, SearchKind } from './bookSearch'
import { searchBlocks, searchableText } from './searchText'

/** Only text and addresses survive indexing. Templates remain inert and
 * detached, so indexing does not render diagrams, math or book images.
 */
export async function createSearchIndex(
  book: ParsedBook,
  signal: AbortSignal,
  progress: (fraction: number) => void
): Promise<SearchIndex | null> {
  const index: SearchIndex = { entries: [], lengths: { section: 0, note: 0 } }
  const sources = [
    ...book.sections.map((s) => ({ ...s, kind: 'section' as SearchKind })),
    ...book.notes.map((n) => ({
      id: n.id,
      html: n.html,
      title: '旁注 ' + n.displayMark,
      kind: 'note' as SearchKind
    }))
  ]
  let deadline = performance.now() + 12
  for (let i = 0; i < sources.length; i++) {
    if (signal.aborted) return null
    const source = sources[i]
    const template = document.createElement('template')
    template.innerHTML = source.html
    let title = source.title
    const blocks = searchBlocks(template.content, true)
    blocks.forEach((block, blockIndex) => {
      const text = searchableText(block, true)
      if (source.kind === 'section' && /^H[1-6]$/.test(block.tagName)) title = text
      if (text.trim()) {
        index.entries.push({
          id: source.id,
          kind: source.kind,
          title,
          text,
          blockIndex,
          position: index.lengths[source.kind]
        })
        index.lengths[source.kind] += text.length + 1
      }
    })
    if (performance.now() > deadline) {
      progress((i + 1) / sources.length)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      deadline = performance.now() + 12
    }
  }
  progress(1)
  return signal.aborted ? null : index
}
