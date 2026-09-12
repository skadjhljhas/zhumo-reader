import type { ParsedBook } from '../../../shared/types'
import type { SearchEntry, SearchIndex, SearchOccurrence } from './bookSearch'
import { occurrenceContext } from './bookSearch'
import { SEARCH_BLOCKS, searchBlocks, searchTextParts, searchableText } from './searchText'
import type { SearchMatchLocation } from './searchLanding'
import { textAddress, type TextAddress, type TextDocumentVersion } from './textAddress'

export interface ComparisonPassage {
  book: ParsedBook
  entry: SearchEntry
  hit: SearchOccurrence
  query: string
  before: string
  after: string
  location: number
  address: TextAddress
}
export interface ComparisonFragment {
  html: string
  from: number
  to: number
  total: number
  match?: SearchMatchLocation
}
export const COMPARISON_WINDOW = 6000
export function comparisonPassage(
  book: ParsedBook,
  index: SearchIndex,
  hit: SearchOccurrence,
  query: string,
  version: TextDocumentVersion
): ComparisonPassage | undefined {
  const entry = index.entries[hit.entryIndex]
  if (!entry || hit.start < 0 || hit.end > entry.text.length || hit.end <= hit.start) return
  const address = textAddress(version, book, entry, {
    start: hit.start,
    end: hit.end,
    text: entry.text.slice(hit.start, hit.end)
  })
  if (!address) return
  const neighbor = (delta: number): string => {
    const other = index.entries[hit.entryIndex + delta]
    if (
      !other ||
      other.id !== entry.id ||
      other.kind !== entry.kind ||
      other.title !== entry.title ||
      other.text === entry.title
    )
      return ''
    const clipped =
      delta < 0
        ? occurrenceContext(
            other.text,
            { start: other.text.length, end: other.text.length },
            320,
            0
          )
        : occurrenceContext(other.text, { start: 0, end: 0 }, 0, 320)
    return (
      (clipped.leading ? '…' : '') + clipped.before + clipped.after + (clipped.trailing ? '…' : '')
    )
  }
  return {
    book,
    entry,
    hit: { ...hit },
    query,
    address,
    before: neighbor(-1),
    after: neighbor(1),
    location: Math.max(
      0,
      Math.min(1, (entry.position + hit.start) / Math.max(1, index.lengths[entry.kind]))
    )
  }
}
export function samePassage(a: ComparisonPassage, b: ComparisonPassage): boolean {
  return (
    a.book === b.book &&
    a.entry.kind === b.entry.kind &&
    a.entry.id === b.entry.id &&
    a.entry.blockIndex === b.entry.blockIndex &&
    a.hit.start === b.hit.start &&
    a.hit.end === b.hit.end
  )
}
export function comparisonText(a: ComparisonPassage, b: ComparisonPassage): string {
  return [a, b]
    .map(
      (page, index) =>
        (index ? '右页' : '左页') +
        ' · ' +
        page.entry.title +
        '\n' +
        (page.entry.kind === 'note' ? '旁注' : '正文') +
        ' · 第 ' +
        (page.entry.blockIndex + 1) +
        ' 个文本块\n\n' +
        page.entry.text
    )
    .join('\n\n——\n\n')
}
/** A readable bounded window, preserving Unicode boundaries. */
export function comparisonBounds(text: string, center: number): { from: number; to: number } {
  let from = Math.max(0, Math.min(text.length, Math.floor(center)) - 1400)
  let to = Math.min(text.length, from + COMPARISON_WINDOW)
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from]) && /[\uD800-\uDBFF]/.test(text[from - 1]))
    from--
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to]) && /[\uD800-\uDBFF]/.test(text[to - 1]))
    to++
  return { from, to }
}
let fragmentId = 0
/** Original rich markup comes from inert parser output, never the live page.
 * Both panes keep independent SVG ids; equation links still point to the book.
 */
export function comparisonFragment(
  page: ComparisonPassage,
  center = page.hit.start
): ComparisonFragment {
  const source =
    page.entry.kind === 'section'
      ? page.book.sections.find((section) => section.id === page.entry.id)
      : page.book.notes.find((note) => note.id === page.entry.id)
  if (!source) throw new Error('这处原文已更新，请重新选择。')
  const template = document.createElement('template')
  template.innerHTML = source.html
  const block = searchBlocks(template.content, true)[page.entry.blockIndex]
  if (!block || searchableText(block, true) !== page.entry.text)
    throw new Error('这处原文已更新，请重新选择。')
  const parts = searchTextParts(block, true)
  let { from, to } = comparisonBounds(page.entry.text, center)
  let position = 0
  for (const part of parts) {
    const end = position + part.text.length
    if (part.atomic) {
      if (from > position && from < end) from = position
      if (to > position && to < end) to = end
    }
    position = end
  }
  let selected: Element
  if (
    (from === 0 && to === page.entry.text.length) ||
    (parts.length === 1 && parts[0].node === block && parts[0].atomic)
  ) {
    selected = block.cloneNode(true) as Element
    from = 0
    to = page.entry.text.length
  } else {
    const range = document.createRange()
    let offset = 0,
      begun = false,
      ended = false
    for (const part of parts) {
      const end = offset + part.text.length
      if (!begun && from < end) {
        if (part.atomic) range.setStartBefore(part.node)
        else range.setStart(part.node, Math.max(0, from - offset))
        begun = true
      }
      if (begun && !ended && to <= end) {
        if (part.atomic) range.setEndAfter(part.node)
        else range.setEnd(part.node, Math.max(0, to - offset))
        ended = true
        break
      }
      offset = end
    }
    if (!begun || !ended) throw new Error('暂时无法展开这一处文字。')
    if (from === 0) range.setStart(block, 0)
    if (to === page.entry.text.length) range.setEnd(block, block.childNodes.length)
    selected = block.cloneNode(false) as Element
    selected.append(range.cloneContents())
  }
  if (selected.matches('li'))
    selected.querySelectorAll(SEARCH_BLOCKS).forEach((child) => child.remove())
  if (searchableText(selected, true) !== page.entry.text.slice(from, to))
    throw new Error('暂时无法完整保留这处排版，请从原文继续。')
  selected.setAttribute('data-comparison-target', '')
  let wrapper = selected
  let child = block
  for (let parent = block.parentElement; parent; parent = parent.parentElement) {
    if (/^(BLOCKQUOTE|UL|OL|LI|TABLE|THEAD|TBODY|TR|TD|TH)$/.test(parent.tagName)) {
      const context = parent.cloneNode(false) as Element
      if (parent.tagName === 'OL' && child.tagName === 'LI') {
        const ordinal = [...parent.children].filter((node) => node.tagName === 'LI').indexOf(child)
        context.setAttribute(
          'start',
          String(Number(parent.getAttribute('start') ?? 1) + Math.max(0, ordinal))
        )
      }
      context.append(wrapper)
      wrapper = context
    }
    child = parent
  }
  const root = document.createElement('div')
  root.append(wrapper)
  const prefix = 'comparison-' + ++fragmentId + '-'
  const ids = new Map<string, string>()
  for (const element of root.querySelectorAll<HTMLElement>('[id]')) {
    const id = element.id
    if (id.startsWith('mjx-eqn:')) element.removeAttribute('id')
    else {
      ids.set(id, prefix + id)
      element.id = prefix + id
    }
  }
  for (const element of root.querySelectorAll('*')) {
    for (const name of [
      'data-source-inline',
      'data-source-block',
      'data-source-from',
      'data-source-to',
      'data-toc-id',
      'data-heading-hash'
    ])
      element.removeAttribute(name)
    for (const attribute of [...element.attributes]) {
      let value = attribute.value
      if (
        ['href', 'xlink:href'].includes(attribute.name) &&
        value.startsWith('#') &&
        ids.has(value.slice(1))
      )
        value = '#' + ids.get(value.slice(1))
      value = value.replace(/url\(#([^)]+)\)/g, (original, id: string) =>
        ids.has(id) ? 'url(#' + ids.get(id) + ')' : original
      )
      if (['aria-labelledby', 'aria-describedby'].includes(attribute.name))
        value = value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(' ')
      if (value !== attribute.value) element.setAttribute(attribute.name, value)
    }
  }
  const start = Math.max(from, page.hit.start),
    end = Math.min(to, page.hit.end)
  return {
    html: root.innerHTML,
    from,
    to,
    total: page.entry.text.length,
    ...(end > start
      ? { match: { start: start - from, end: end - from, text: page.entry.text.slice(start, end) } }
      : {})
  }
}
