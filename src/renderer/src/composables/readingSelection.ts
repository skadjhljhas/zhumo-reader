import type { ReadingSelectionAddress, ReadingInsertion } from '../parser/reading-source'
import type {
  ReadingSourceRequest,
  ReadingSourceResponse
} from '../parser/worker/reading-source.worker'
import { searchTextParts, searchableText } from './searchText'

export interface ReadingSelection {
  address: ReadingSelectionAddress
  startAddress?: ReadingSelectionAddress
  quote: string
  rect: DOMRect
  owner: HTMLElement
  origin: string
}
function parent(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}
function boundaryElement(node: Node, offset: number, end: boolean): Element | null {
  if (node.nodeType === Node.TEXT_NODE) return parent(node)
  const child = node.childNodes[end ? offset - 1 : offset]
  if (!child) return parent(node)
  let current = child
  while (end ? current.lastChild : current.firstChild)
    current = (end ? current.lastChild : current.firstChild)!
  return parent(current)
}
/** Snapshot native selection without modifying the document or stealing focus. */
export function captureReadingSelection(
  notes: Array<{ id: string; label: string; displayMark: string }>
): ReadingSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = boundaryElement(range.startContainer, range.startOffset, false)
  const end = boundaryElement(range.endContainer, range.endOffset, true)
  const first = start?.closest<HTMLElement>('.section-body, .zmu-note-body')
  const owner = end?.closest<HTMLElement>('.section-body, .zmu-note-body')
  const inline = end?.closest<HTMLElement>('[data-source-inline]')
  if (!first || !owner || !inline || !owner.contains(inline)) return null
  // Whole formula nodes can be selected; a partial selection inside rendered math cannot
  // be mapped back to a safe source boundary.
  if (
    parent(range.endContainer)?.closest('.zmu-math, .zmu-diagram, .zmu-ref') ||
    parent(range.startContainer)?.closest('.zmu-math, .zmu-diagram, .zmu-ref')
  )
    return null
  if (owner.matches('.zmu-note-body') ? first !== owner : !first.matches('.section-body'))
    return null
  if (owner.closest('.draft-preview, .writer-preview, .book-panorama')) return null
  let kind: 'section' | 'note', id: string
  let origin = '正文选段'
  if (owner.matches('.section-body')) {
    if (!owner.closest('.reader-scroll') || !first.closest('.reader-scroll')) return null
    kind = 'section'
    id = owner.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId ?? ''
  } else {
    kind = 'note'
    const noteId = owner.closest<HTMLElement>('.note-card')?.dataset.noteId
    const note = notes.find((note) => note.id === noteId)
    id = note?.label ?? ''
    origin = '注于 · ' + (note?.displayMark ?? '')
  }
  if (!id) return null
  const prefix = document.createRange()
  prefix.selectNodeContents(inline)
  if (inline.contains(range.endContainer)) prefix.setEnd(range.endContainer, range.endOffset)
  const fragment = document.createElement('div')
  fragment.append(prefix.cloneContents())
  const text = searchableText(inline, true)
  const offset = searchableText(fragment, true).length
  const quoteFragment = document.createElement('div')
  quoteFragment.append(range.cloneContents())
  const quote = searchTextParts(quoteFragment, true)
    .map((part) => part.text)
    .join('')
    .trim()
  if (!quote || offset <= 0 || offset > text.length) return null
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
  const rect = rects.at(-1)
  if (!rect) return null
  const firstInline = start?.closest<HTMLElement>('[data-source-inline]')
  let startAddress: ReadingSelectionAddress | undefined
  if (firstInline) {
    const before = document.createRange()
    before.selectNodeContents(firstInline)
    before.setEnd(range.startContainer, range.startOffset)
    const part = document.createElement('div')
    part.append(before.cloneContents())
    const firstId =
      kind === 'section' ? first.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId : id
    if (firstId)
      startAddress = {
        kind,
        id: firstId,
        inline: Number(firstInline.dataset.sourceInline),
        text: searchableText(firstInline, true),
        end: searchableText(part, true).length,
        ...(firstInline.closest('[data-epub-projection]')
          ? { projectionFrom: Number(firstInline.dataset.sourceFrom) }
          : {}),
        boundary: 'start'
      }
  }
  return {
    address: {
      kind,
      id,
      inline: Number(inline.dataset.sourceInline),
      text,
      end: offset,
      ...(inline.closest('[data-epub-projection]')
        ? { projectionFrom: Number(inline.dataset.sourceFrom) }
        : {})
    },
    quote,
    startAddress,
    rect,
    owner,
    origin
  }
}

/** Read-only work runs in a disposable worker and is cancelled on any stale selection. */
export function locateReadingSelection(
  request: ReadingSourceRequest,
  signal: AbortSignal
): Promise<ReadingInsertion> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ReadingInsertion | Error): void => {
      clearTimeout(timer)
      worker?.terminate()
      signal.removeEventListener('abort', abort)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const abort = (): void => finish(new DOMException('选区已改变', 'AbortError'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      worker = new Worker(new URL('../parser/worker/reading-source.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = ({ data }: MessageEvent<ReadingSourceResponse>) =>
        finish('insertion' in data ? data.insertion : new Error(data.error))
      worker.onerror = () => finish(new Error('暂时无法定位选区，请稍后重试或在源文中继续。'))
      timer = setTimeout(
        () => finish(new Error('定位这处选区用时较长，请缩小选区或在源文中继续。')),
        10000
      )
      worker.postMessage(request)
    } catch {
      finish(new Error('暂时无法启动选区定位，请在源文中继续。'))
    }
  })
}
