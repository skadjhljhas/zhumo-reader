import { computed, shallowRef } from 'vue'
import type { ParsedBook } from '../../../shared/types'
import { documentSession } from './documentSession'
import { normalizeSource } from './sourceText'
import {
  SourcePositionIndex,
  placeOffset,
  visibleSourcePlace,
  snapSourceOffset
} from './sourcePosition'

const normalized = computed(() => normalizeSource(documentSession.source))
export const documentPosition = shallowRef<{
  path: string
  source: string
  offset: number
  returnToReading: boolean
}>()
let activeReadingRoot: HTMLElement | null = null
let cachedBook: ParsedBook | null = null
let cachedIndex = new SourcePositionIndex()
export function bookPositionIndex(book: ParsedBook | null): SourcePositionIndex {
  if (cachedBook !== book) {
    cachedBook = book
    cachedIndex = new SourcePositionIndex(book?.sourceBlocks)
  }
  return cachedIndex
}
export function rememberDocumentPosition(offset: number, returnToReading = false): void {
  documentPosition.value = {
    path: documentSession.path,
    source: normalized.value,
    offset: snapSourceOffset(normalized.value, offset),
    returnToReading
  }
}
export function currentDocumentOffset(): number | undefined {
  const value = documentPosition.value
  return value?.path === documentSession.path && value.source === normalized.value
    ? value.offset
    : undefined
}
export function captureReadingPosition(book: ParsedBook | null): void {
  if (documentSession.mode !== 'read' || !book) return
  if (
    activeReadingRoot &&
    (!activeReadingRoot.isConnected || !activeReadingRoot.getBoundingClientRect().height) &&
    currentDocumentOffset() !== undefined
  )
    return
  const root =
    activeReadingRoot?.isConnected && activeReadingRoot.getBoundingClientRect().height
      ? activeReadingRoot
      : document.querySelector<HTMLElement>('.reader-scroll')
  if (!root) return
  const place = visibleSourcePlace(root, bookPositionIndex(book))
  if (place) rememberDocumentPosition(placeOffset(place))
}
export function trackReadingPosition(getBook: () => ParsedBook | null): () => void {
  let frame = 0
  const track = (event: Event): void => {
    if (documentSession.mode !== 'read' || !(event.target instanceof Element)) return
    const root = event.target.closest<HTMLElement>(
      '.peek-reading,.note-peek,.atlas-detail,.notes-scroll,.reader-scroll'
    )
    if (!root) return
    activeReadingRoot = root
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => captureReadingPosition(getBook()))
  }
  for (const name of ['pointerdown', 'wheel', 'focusin'])
    document.addEventListener(name, track, true)
  return () => {
    cancelAnimationFrame(frame)
    for (const name of ['pointerdown', 'wheel', 'focusin'])
      document.removeEventListener(name, track, true)
    activeReadingRoot = null
  }
}
