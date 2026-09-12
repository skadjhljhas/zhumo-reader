import type { ParsedBook } from '../../../../shared/types'
import { searchBlocks, searchTextParts, searchableText } from '../../composables/searchText'
import { manuscriptProfile, type ManuscriptProfile } from './profile'

const cache = new WeakMap<ParsedBook, ManuscriptProfile>()
const empty = manuscriptProfile({ bodyChars: 0, paragraphs: [], notes: [] })

function characters(text: string): number {
  let count = 0
  for (const character of text.replace(/\s/gu, '')) {
    if (character) count++
  }
  return count
}

/** Yield between projected blocks so long documents can share time with painting. */
function* measureBlocks(book: ParsedBook): Generator<void, ManuscriptProfile> {
  // Inert template: parsed HTML is never added to the live document.
  const template = document.createElement('template')
  const locations = new Map<string, number[]>()
  const paragraphs: number[] = []
  let position = 0
  for (const section of book.sections) {
    template.innerHTML = section.html
    const seen = new Set<Element>()
    for (const block of searchBlocks(template.content, true)) {
      let length = 0
      for (const part of searchTextParts(block)) {
        const parent = part.node instanceof Element ? part.node : part.node.parentElement
        const anchor = parent?.closest<HTMLElement>('.zmu-ref')
        if (anchor) {
          if (!seen.has(anchor)) {
            seen.add(anchor)
            const id = anchor.dataset.noteId
            if (id) {
              const positions = locations.get(id)
              if (positions) positions.push(position + length)
              else locations.set(id, [position + length])
            }
          }
        } else length += characters(part.text)
      }
      if (length) paragraphs.push(length)
      position += length
      yield
    }
  }
  const notes: Parameters<typeof manuscriptProfile>[0]['notes'] = []
  for (const note of book.notes) {
    template.innerHTML = note.html
    let chars = 0
    for (const block of searchBlocks(template.content, true)) {
      chars += characters(searchableText(block, true))
      yield
    }
    notes.push({
      chars,
      level: note.level,
      parents: note.parentIds.length,
      refs: note.refCount,
      positions: (locations.get(note.id) ?? []).map((p) => p / Math.max(1, position))
    })
  }
  return manuscriptProfile({ bodyChars: book.stats.chars, paragraphs, notes })
}

export function measureManuscript(book: ParsedBook | null): ManuscriptProfile {
  if (!book) return empty
  const cached = cache.get(book)
  if (cached) return cached
  const iterator = measureBlocks(book)
  let step = iterator.next()
  while (!step.done) step = iterator.next()
  cache.set(book, step.value)
  return step.value
}

function yieldForPainting(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const idle = typeof requestIdleCallback === 'function'
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = (): void => {
      if (idle) cancelIdleCallback(handle)
      else clearTimeout(handle)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Manuscript measurement cancelled', 'AbortError'))
    }
    if (signal?.aborted) {
      reject(new DOMException('Manuscript measurement cancelled', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    const handle = idle
      ? requestIdleCallback(finish, { timeout: 60 })
      : window.setTimeout(finish, 0)
  })
}

export async function measureManuscriptAsync(
  book: ParsedBook | null,
  options: { signal?: AbortSignal; budgetMs?: number; yield?: () => Promise<void> } = {}
): Promise<ManuscriptProfile> {
  const { signal } = options
  const check = (): void => {
    if (signal?.aborted) throw new DOMException('Manuscript measurement cancelled', 'AbortError')
  }
  check()
  if (!book) return empty
  const cached = cache.get(book)
  if (cached) return cached
  const iterator = measureBlocks(book)
  const budget = Math.max(1, Math.min(12, options.budgetMs ?? 6))
  try {
    // Let the newly opened text get its first paint before starting analysis.
    await (options.yield?.() ?? yieldForPainting(signal))
    while (true) {
      check()
      const until = performance.now() + budget
      do {
        const step = iterator.next()
        if (step.done) {
          check()
          cache.set(book, step.value)
          return step.value
        }
      } while (performance.now() < until)
      await (options.yield?.() ?? yieldForPainting(signal))
    }
  } finally {
    iterator.return(empty)
  }
}
