import { nextTick } from 'vue'
import { bookState } from './useBook'
import { documentSession } from './documentSession'
import { readerState, requestSearchLanding, requestSidebarLocate } from './readerStore'
import { studio } from './useStudio'
import { settings } from './useSettings'
import { searchBlocks, searchableText } from './searchText'
import { searchMatchRanges } from './searchLanding'
import {
  parseTextAddress,
  sameTextVersion,
  textDocumentVersion,
  validateTextAddress,
  type TextAddress
} from './textAddress'

export type TextNavigationResult =
  | { status: 'landed'; kind: 'section' | 'note'; id: string; blockIndex: number }
  | {
      status:
        | 'cancelled'
        | 'version-changed'
        | 'invalid-address'
        | 'text-changed'
        | 'missing'
        | 'not-reading'
        | 'timeout'
    }

let navigationSerial = 0
function navigationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0
    const timer = setTimeout(finish, 100)
    function finish(): void {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve()
    }
    frame = requestAnimationFrame(finish)
  })
}

/** One read-only navigation contract for comparison, theme memories and future
 * consumers. The caller handles its own overlay and any explicit edit/save flow.
 */
export async function navigateTextAddress(
  address: TextAddress,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<TextNavigationResult> {
  const validated = parseTextAddress(address)
  if (!validated) return { status: 'invalid-address' }
  const own = ++navigationSerial
  address = validated
  const book = bookState.book,
    path = documentSession.path,
    source = documentSession.source
  if (!book || bookState.status !== 'reading' || documentSession.mode !== 'read')
    return { status: 'not-reading' }
  const stale = (): boolean =>
    own !== navigationSerial ||
    bookState.book !== book ||
    bookState.status !== 'reading' ||
    documentSession.path !== path ||
    documentSession.source !== source ||
    documentSession.mode !== 'read'
  if (options.signal?.aborted) return { status: 'cancelled' }
  const version = await textDocumentVersion(path, source)
  if (stale() || options.signal?.aborted) return { status: 'cancelled' }
  if (!sameTextVersion(address.version, version)) return { status: 'version-changed' }
  const origin = address.origin
  const container =
    origin.kind === 'section'
      ? book.sections.find((section) => section.id === origin.sectionId)
      : book.notes.find((note) => note.label === origin.label)
  if (!container) return { status: 'missing' }
  const template = document.createElement('template')
  template.innerHTML = container.html
  const original = searchBlocks(template.content, true)[address.blockIndex]
  if (!original) return { status: 'missing' }
  const valid = validateTextAddress(address, version, searchableText(original, true))
  if (valid !== 'valid') return { status: valid }
  const kind = address.origin.kind,
    id = container.id
  if (kind === 'note') {
    settings.sidebarVisible = true
    studio.focusMode = false
    await nextTick()
    if (stale() || options.signal?.aborted) return { status: 'cancelled' }
    requestSidebarLocate(id, address.blockIndex, address.match)
  } else requestSearchLanding(id, address.blockIndex, address.match)
  const seq = kind === 'note' ? readerState.sidebarRequest.seq : readerState.scrollRequest.seq
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 7000
  const deadline = performance.now() + Math.max(100, Math.min(12000, timeout))
  let stable = 0,
    previousTop = Number.NaN
  while (performance.now() < deadline) {
    await navigationFrame()
    if (
      stale() ||
      options.signal?.aborted ||
      seq !== (kind === 'note' ? readerState.sidebarRequest.seq : readerState.scrollRequest.seq)
    )
      return { status: 'cancelled' }
    const root =
      kind === 'note'
        ? document.querySelector<HTMLElement>('.notes-scroll')
        : document.querySelector<HTMLElement>('.reader-scroll')
    const scope = root?.querySelector(
      kind === 'note'
        ? '.note-card[data-note-id="' + CSS.escape(id) + '"] .zmu-note-body'
        : '.section-frame[data-section-id="' + CSS.escape(id) + '"] .section-body'
    )
    let target = scope && searchBlocks(scope, true)[address.blockIndex]
    if (target?.tagName === 'H1' && !target.getClientRects().length)
      target = root?.querySelector('.document-overture h1') ?? target
    const expected = target && searchMatchRanges(target, address.match)
    const painted = CSS.highlights?.get('zhumo-search-match')
    const ranges = painted ? [...painted] : []
    const highlighted =
      expected &&
      expected.atoms.every((node) => node.classList.contains('search-source-landed')) &&
      expected.ranges.every((wanted) =>
        ranges.some(
          (range) =>
            range.startContainer === wanted.startContainer &&
            range.startOffset === wanted.startOffset &&
            range.endContainer === wanted.endContainer &&
            range.endOffset === wanted.endOffset
        )
      )
    const rect = expected?.rect(),
      boundary = root?.getBoundingClientRect()
    if (
      highlighted &&
      rect &&
      boundary &&
      rect.bottom > boundary.top &&
      rect.top < boundary.bottom &&
      rect.right > boundary.left &&
      rect.left < boundary.right
    ) {
      stable = Math.abs(rect.top - previousTop) < 2 ? stable + 1 : 0
      previousTop = rect.top
      if (stable >= 2) return { status: 'landed', kind, id, blockIndex: address.blockIndex }
    } else stable = 0
  }
  return { status: 'timeout' }
}
