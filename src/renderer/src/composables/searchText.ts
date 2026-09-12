/** Shared DOM enumeration keeps search result indices aligned with rendered blocks. */
export const SEARCH_BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,.zmu-math-block,.zmu-diagram'
export function searchBlocks(root: ParentNode, includeListParents = false): Element[] {
  return [...root.querySelectorAll(SEARCH_BLOCKS)].filter(
    (el) =>
      el.matches('.zmu-diagram') ||
      (!el.closest('.zmu-diagram') &&
        (!el.querySelector(SEARCH_BLOCKS) ||
          (includeListParents && el.matches('li') && Boolean(searchableText(el).trim()))))
  )
}
export function searchableText(element: Element, omitReferences = false): string {
  return searchTextParts(element, omitReferences)
    .map((part) => part.text)
    .join('')
}

export interface SearchTextPart {
  text: string
  node: Text | Element
  atomic: boolean
}

/** Share the exact same projection between indexing and precise landing.
 * Formula source is one atomic region, independent of its rendered glyphs.
 */
export function searchTextParts(root: Element, omitReferences = false): SearchTextPart[] {
  const parts: SearchTextPart[] = []
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push({ text: node.textContent ?? '', node: node as Text, atomic: false })
      return
    }
    if (!(node instanceof Element)) return
    if (omitReferences && node.matches('.zmu-ref')) return
    // Tight nested Markdown lists put the parent's text directly in an LI.
    // Its child paragraphs/items are separate entries, not duplicated here.
    if (node !== root && root.matches('li') && node.matches(SEARCH_BLOCKS)) return
    if (node.matches('.katex-mathml')) return
    if (node.matches('.zmu-diagram')) {
      parts.push({
        text: node.querySelector('.diagram-source code')?.textContent ?? '',
        node,
        atomic: true
      })
    } else if (node.matches('.zmu-math')) {
      parts.push({
        text: (node as HTMLElement).dataset.mathSource ?? node.textContent ?? '',
        node,
        atomic: true
      })
    } else node.childNodes.forEach(visit)
  }
  visit(root)
  return parts
}
