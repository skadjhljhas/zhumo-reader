import type { SourceBlock } from '../../../shared/types'

export interface SourcePlace {
  block: SourceBlock
  ratio: number
  viewport: number
}
export class SourcePositionIndex {
  readonly blocks: SourceBlock[]
  private readonly maximum: number[] = []
  private readonly byStamp = new Map<string, SourceBlock>()
  constructor(blocks: SourceBlock[] = []) {
    this.blocks = [...blocks].sort((a, b) => a.from - b.from || b.to - a.to)
    let maximum = -1
    for (const block of this.blocks) {
      maximum = Math.max(maximum, block.to)
      this.maximum.push(maximum)
      this.byStamp.set(block.from + ':' + block.to + ':' + block.key, block)
    }
  }
  at(offset: number): SourceBlock | undefined {
    let low = 0,
      high = this.blocks.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.blocks[middle].from <= offset) low = middle + 1
      else high = middle
    }
    let found: SourceBlock | undefined, ending: SourceBlock | undefined
    for (let i = low - 1; i >= 0 && this.maximum[i] >= offset; i--) {
      const block = this.blocks[i]
      if (block.to < offset) continue
      if (block.to === offset) {
        if (!ending || block.to - block.from < ending.to - ending.from) ending = block
        continue
      }
      if (
        !found ||
        block.to - block.from < found.to - found.from ||
        (block.to - block.from === found.to - found.from && found.key === 'row')
      )
        found = block
    }
    if (
      ending &&
      (!found ||
        (found.kind === ending.kind &&
          found.id === ending.id &&
          ending.to - ending.from < found.to - found.from))
    )
      return ending
    return found ?? this.blocks[low] ?? this.blocks.at(-1)
  }
  element(element: HTMLElement): SourceBlock | undefined {
    return this.byStamp.get(
      element.dataset.sourceFrom +
        ':' +
        element.dataset.sourceTo +
        ':' +
        element.dataset.sourceBlock
    )
  }
}
export function sourcePlace(
  index: SourcePositionIndex,
  offset: number,
  viewport = 0.25
): SourcePlace | undefined {
  const block = index.at(offset)
  return (
    block && {
      block,
      ratio: Math.max(0, Math.min(1, (offset - block.from) / Math.max(1, block.to - block.from))),
      viewport
    }
  )
}
export function placeOffset(place: SourcePlace): number {
  return Math.round(
    place.block.from + Math.max(0, Math.min(1, place.ratio)) * (place.block.to - place.block.from)
  )
}
export function snapSourceOffset(source: string, offset: number): number {
  let position = Math.max(0, Math.min(source.length, Math.round(offset)))
  if (
    position > 0 &&
    /[\uD800-\uDBFF]/.test(source[position - 1]) &&
    /[\uDC00-\uDFFF]/.test(source[position] ?? '')
  )
    position--
  return position
}

/** Hit-test the reading band first; a bounded visible row scan handles margins.
 * Inline geometry is used for relative progress within a long paragraph.
 */
export function visibleSourcePlace(
  root: HTMLElement,
  index: SourcePositionIndex
): SourcePlace | undefined {
  const boundary = root.getBoundingClientRect()
  if (!boundary.height || !boundary.width) return
  const viewport = 0.25,
    y = boundary.top + Math.min(100, boundary.height * viewport)
  const candidates: HTMLElement[] = []
  const add = (element: Element | null): void => {
    if (!element || !root.contains(element)) return
    const mapped =
      element.closest<HTMLElement>('[data-source-block]') ??
      element
        .closest('p,h1,h2,h3,h4,h5,h6,pre,.zmu-diagram,.zmu-math-block')
        ?.querySelector<HTMLElement>('[data-source-block]')
    if (mapped && root.contains(mapped) && !candidates.includes(mapped)) candidates.push(mapped)
  }
  for (const dy of [0, 16, -16, 40]) {
    for (const x of [0.4, 0.65])
      add(document.elementFromPoint(boundary.left + boundary.width * x, y + dy))
    if (candidates.length) break
  }
  if (!candidates.length) {
    // Restrict layout reads to visible section/preview/note rows.
    const rows = root.querySelectorAll<HTMLElement>('.section-frame,.preview-row,.note-card')
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom < boundary.top || rect.top > boundary.bottom) continue
      candidates.push(...row.querySelectorAll<HTMLElement>('[data-source-block]'))
    }
  }
  let selected: { block: SourceBlock; rect: DOMRect; distance: number } | undefined
  for (const element of candidates) {
    const block = index.element(element)
    if (!block) continue
    const rect = element.getBoundingClientRect()
    if (!rect.height) continue
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    if (!selected || distance < selected.distance) selected = { block, rect, distance }
  }
  if (!selected) return
  const { block, rect } = selected
  const ratio = rect.height < 38 ? 0 : Math.max(0, Math.min(1, (y - rect.top) / rect.height))
  return { block, ratio, viewport: Math.min(100, boundary.height * viewport) / boundary.height }
}
