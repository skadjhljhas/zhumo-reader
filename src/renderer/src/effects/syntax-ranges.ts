import type { SyntaxSpan } from '../../../shared/ai-types'
import { searchableText, searchTextParts } from '../composables/searchText'
import type { SyntaxRegion } from '../../../shared/syntax-passages'

export interface SyntaxAnchor {
  projectionFrom?: number
  kind: 'section' | 'note'
  id: string
  inline: number
  text: string
  from: number
  to: number
  start: number
  end: number
  contentKind?: 'math' | 'code'
}

export interface TextSlice {
  node: Text | Element
  atomic?: boolean
  from: number
  to: number
  start: number
  end: number
}
const atomicRanges = new WeakMap<Range, Element>()
export const syntaxAtomicElement = (range: Range): Element | undefined => atomicRanges.get(range)
/** Text uses native nodes; an inline formula uses its source and one indivisible visual region.
 * No KaTeX accessibility/visual duplicate is enumerated as ordinary language. */
export function syntaxTextSlices(range: Range, quote: string): TextSlice[] {
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return []
  const root = range.commonAncestorContainer
  const parts =
    root instanceof Text
      ? [{ node: root, text: root.data, atomic: false }]
      : root instanceof Element
        ? searchTextParts(root, true)
        : []
  const slices: TextSlice[] = []
  let text = ''
  for (const part of parts) {
    const node = part.node
    if (
      !range.intersectsNode(node) ||
      node.parentElement?.closest('.zmu-ref,.zmu-diagram') ||
      (part.atomic && !(node instanceof Element && node.matches('.zmu-math')))
    )
      continue
    if (part.atomic && (node.contains(range.startContainer) || node.contains(range.endContainer)))
      return []
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : part.text.length
    if (to <= from) continue
    const value = part.text.slice(from, to)
    slices.push({
      node,
      atomic: part.atomic,
      from,
      to,
      start: text.length,
      end: text.length + value.length
    })
    text += value
  }
  const left = text.length - text.trimStart().length
  if (text.trim() !== quote) return []
  return slices.map((slice) => ({
    ...slice,
    start: slice.atomic ? Math.max(0, slice.start - left) : slice.start - left,
    end: slice.atomic ? Math.min(quote.length, slice.end - left) : slice.end - left
  }))
}
export function syntaxRegions(anchors: SyntaxAnchor[], length: number): SyntaxRegion[] {
  const regions: SyntaxRegion[] = []
  for (const a of anchors) {
    if (!a.contentKind) continue
    const start = Math.max(0, a.start),
      end = Math.min(length, a.end)
    if (end <= start) continue
    const previous = regions.at(-1)
    if (previous?.kind === a.contentKind && previous.end === start) previous.end = end
    else regions.push({ kind: a.contentKind, start, end })
  }
  return regions
}
export function syntaxSpanRanges(slices: TextSlice[], span: SyntaxSpan): Range[] {
  const ranges: Range[] = []
  for (const anchor of span.anchors ?? [span])
    for (const slice of slices) {
      const start = Math.max(slice.start, anchor.start),
        end = Math.min(slice.end, anchor.end)
      if (end <= start || !slice.node.isConnected) continue
      const range = document.createRange()
      if (slice.atomic && slice.node instanceof Element) {
        if (start !== slice.start || end !== slice.end) continue
        range.selectNode(slice.node)
        atomicRanges.set(range, slice.node)
      } else {
        range.setStart(slice.node, slice.from + start - slice.start)
        range.setEnd(slice.node, slice.from + end - slice.start)
      }
      ranges.push(range)
    }
  return ranges
}

/** Ephemeral addresses use the existing source-inline/text projection; notes retain labels.
 * The owner checks path, full source and reading session before resolving these addresses. */
export function captureSyntaxAnchors(
  range: Range,
  quote: string,
  notes: Array<{ id: string; label: string }>
): SyntaxAnchor[] {
  const anchors: SyntaxAnchor[] = []
  for (const slice of syntaxTextSlices(range, quote)) {
    const inline = (
      slice.node instanceof Element ? slice.node : slice.node.parentElement
    )?.closest<HTMLElement>('[data-source-inline]')
    const owner = inline?.closest('.section-body,.zmu-note-body')
    if (!inline || !owner) return []
    const kind = owner.matches('.section-body') ? 'section' : 'note'
    const id =
      kind === 'section'
        ? owner.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId
        : notes.find((note) => note.id === owner.closest<HTMLElement>('.note-card')?.dataset.noteId)
            ?.label
    if (!id) return []
    let offset = 0,
      found = false
    for (const part of searchTextParts(inline, true)) {
      if (part.node === slice.node) {
        found = true
        break
      }
      offset += part.text.length
    }
    if (!found) return []
    anchors.push({
      kind,
      id,
      inline: Number(inline.dataset.sourceInline),
      text: searchableText(inline, true),
      from: offset + slice.from,
      to: offset + slice.to,
      start: slice.start,
      end: slice.end,
      ...(inline.closest('[data-epub-projection]')
        ? { projectionFrom: Number(inline.dataset.sourceFrom) }
        : {}),
      ...(slice.atomic
        ? { contentKind: 'math' as const }
        : slice.node.parentElement?.closest('code')
          ? { contentKind: 'code' as const }
          : {})
    })
  }
  return anchors
}

/** Resolve only exact original inline text in currently mounted reader/note surfaces. */
export function resolveSyntaxAnchors(
  anchors: SyntaxAnchor[],
  notes: Array<{ id: string; label: string }>,
  root: ParentNode = document
): TextSlice[] {
  const slices: TextSlice[] = []
  for (const anchor of anchors) {
    const id =
      anchor.kind === 'section' ? anchor.id : notes.find((note) => note.label === anchor.id)?.id
    if (!id) continue
    const selector =
      anchor.kind === 'section'
        ? `.reader-scroll [data-section-id="${CSS.escape(id)}"] .section-body`
        : `.note-card[data-note-id="${CSS.escape(id)}"] .zmu-note-body`
    const targets = [...root.querySelectorAll(selector)].map((owner) =>
      owner.querySelector(`[data-source-inline="${anchor.inline}"]`)
    )
    if (anchor.kind === 'section')
      targets.push(
        ...root.querySelectorAll(
          `.document-overture h1[data-title-section="${CSS.escape(id)}"][data-title-inline="${anchor.inline}"]`
        )
      )
    for (const inline of targets) {
      if (!inline || searchableText(inline, true) !== anchor.text) continue
      let offset = 0
      for (const part of searchTextParts(inline, true)) {
        const from = Math.max(anchor.from, offset),
          to = Math.min(anchor.to, offset + part.text.length)
        if (
          to > from &&
          (!part.atomic ||
            (part.node instanceof Element &&
              part.node.matches('.zmu-math') &&
              from === offset &&
              to === offset + part.text.length))
        ) {
          slices.push({
            node: part.node,
            atomic: part.atomic,
            from: from - offset,
            to: to - offset,
            start: part.atomic ? anchor.start : anchor.start + from - anchor.from,
            end: part.atomic ? anchor.end : anchor.start + to - anchor.from
          })
        }
        offset += part.text.length
      }
    }
  }
  return slices
}
