import { searchTextParts } from './searchText'

export interface SearchMatchLocation {
  start: number
  end: number
  text: string
}
let timer: ReturnType<typeof setTimeout> | undefined
let atomic: Element[] = []
export function clearSearchHighlight(): void {
  clearTimeout(timer)
  CSS.highlights?.delete('zhumo-search-match')
  atomic.forEach((node) => node.classList.remove('search-source-landed'))
  atomic = []
}

/** Paint without wrapping nodes, changing source HTML, or stealing selection.
 * Returns live geometry so a match far down a single paragraph stays reachable.
 */
export function searchMatchRanges(
  block: Element,
  match: SearchMatchLocation
):
  | {
      ranges: Range[]
      atoms: Element[]
      rect: () => DOMRect | undefined
    }
  | undefined {
  const parts = searchTextParts(block, true)
  if (
    parts
      .map((part) => part.text)
      .join('')
      .slice(match.start, match.end) !== match.text
  )
    return
  const ranges: Range[] = []
  const atoms: Element[] = []
  let position = 0,
    first: Range | Element | undefined
  for (const part of parts) {
    const from = Math.max(0, match.start - position),
      to = Math.min(part.text.length, match.end - position)
    position += part.text.length
    if (to <= from) continue
    if (part.atomic) {
      const el = part.node as Element
      atoms.push(el)
      first ??= el
    } else {
      const range = document.createRange()
      range.setStart(part.node, from)
      range.setEnd(part.node, to)
      ranges.push(range)
      first ??= range
    }
  }
  return { ranges, atoms, rect: () => first?.getBoundingClientRect() }
}
export function paintSearchMatch(
  block: Element,
  match?: SearchMatchLocation
): (() => DOMRect | undefined) | undefined {
  clearSearchHighlight()
  if (!match) return
  const found = searchMatchRanges(block, match)
  if (!found) return
  atomic = found.atoms
  atomic.forEach((node) => node.classList.add('search-source-landed'))
  if (found.ranges.length && typeof Highlight !== 'undefined' && CSS.highlights)
    CSS.highlights.set('zhumo-search-match', new Highlight(...found.ranges))
  timer = setTimeout(clearSearchHighlight, 8000)
  return found.rect
}
