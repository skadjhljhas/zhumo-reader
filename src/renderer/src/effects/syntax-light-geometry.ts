import type { SyntaxSpan } from '../../../shared/ai-types'
import { syntaxSpanRanges, syntaxAtomicElement } from './syntax-ranges'
export interface SyntaxLightBand {
  x: number
  y: number
  top: number
  width: number
  height: number
  index: number
  key: string
  first?: boolean
  last?: boolean
  inkTop?: number
  inkBottom?: number
  roomAbove?: number
  roomBelow?: number
  inkRight?: number
  clipRight?: number
}
interface InkRow {
  top: number
  bottom: number
  right: number
}
const inkRows = new WeakMap<Element, InkRow[]>()
function clearance(
  root: Element,
  top: number,
  bottom: number,
  local = false
): {
  top: number
  bottom: number
  above: number
  below: number
  inkRight: number
  clipRight: number
} {
  let rows = inkRows.get(root)
  if (!rows) {
    const rectangles: InkRow[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (
        !node.textContent?.trim() ||
        node.parentElement?.closest('svg,script,style,.zmu-math,.zmu-diagram')
      )
        continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects())
        if (rect.width > 0 && rect.height > 0)
          rectangles.push({ top: rect.top, bottom: rect.bottom, right: rect.right })
    }
    for (const atom of root.querySelectorAll('.zmu-math,img,.zmu-diagram,video,canvas')) {
      const rect = atom.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        rectangles.push({ top: rect.top, bottom: rect.bottom, right: rect.right })
    }
    rows = []
    for (const rect of rectangles.sort((a, b) => a.top - b.top)) {
      const last = rows.at(-1)
      if (last && rect.top < last.bottom - 0.5) {
        last.bottom = Math.max(last.bottom, rect.bottom)
        last.right = Math.max(last.right, rect.right)
      } else rows.push({ ...rect })
    }
    inkRows.set(root, rows)
    // Reuse within a single synchronous measurement, never across a font/layout update.
    queueMicrotask(() => inkRows.delete(root))
  }
  const own = rows.find((r) => r.top <= top + 1 && r.bottom >= bottom - 1) ?? {
    top,
    bottom,
    right: 0
  }
  const previous = Math.max(
    own.top - 32,
    ...rows.filter((r) => r.bottom <= own.top).map((r) => r.bottom)
  )
  const next = Math.min(
    own.bottom + 32,
    ...rows.filter((r) => r.top >= own.bottom).map((r) => r.top)
  )
  const clip = root.getBoundingClientRect()
  const visible = rows.filter(
    (r) => local || (r.bottom > Math.max(0, clip.top) && r.top < Math.min(innerHeight, clip.bottom))
  )
  return {
    ...own,
    above: Math.max(0, own.top - previous),
    below: Math.max(0, next - own.bottom),
    inkRight: Math.max(clip.left, ...visible.map((r) => r.right)),
    clipRight: clip.right - 6
  }
}
/** Produce one band per actual printed line; clipping never changes the analysis itself. */
export function syntaxLightBands(
  slices: Parameters<typeof syntaxSpanRanges>[0],
  units: Array<{ span: SyntaxSpan; index: number; id: string }>,
  local?: HTMLElement
): SyntaxLightBand[] {
  const result: SyntaxLightBand[] = []
  const owners = new Map<SyntaxLightBand, Element>()
  const extents = new Map<Element, { top: number; bottom: number }>()
  const origin = local?.getBoundingClientRect()
  for (const { span, index, id } of units) {
    const lines = syntaxSpanRanges(slices, span)
      .flatMap((range) => {
        const atom = syntaxAtomicElement(range)
        const owner = atom ?? range.startContainer.parentElement
        const root =
          local ?? owner?.closest('.reader-scroll,.notes-scroll,.peek-scroll,.note-atlas')
        if (!root) return []
        return (atom ? [atom.getBoundingClientRect()] : [...range.getClientRects()]).map(
          (rect) => ({ rect, root })
        )
      })
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    let ordinal = 0
    for (const { rect, root } of lines) {
      const position = ordinal++
      if (rect.width <= 0 || rect.height <= 0) continue
      const clip = root.getBoundingClientRect()
      if (
        !local &&
        (rect.top < Math.max(0, clip.top) || rect.bottom > Math.min(innerHeight - 20, clip.bottom))
      )
        continue
      const x = Math.max(rect.left, clip.left),
        right = Math.min(rect.right, clip.right)
      if (right <= x) continue
      if (!local) {
        // Check both ends as well as the middle: a floating panel may cover half a line.
        const points = [
          x + Math.min(2, (right - x) / 2),
          (x + right) / 2,
          right - Math.min(2, (right - x) / 2)
        ]
        if (
          points.some((px) => {
            const el = document.elementFromPoint(px, rect.top + rect.height / 2)
            return !el || !root.contains(el)
          })
        )
          continue
      }
      const left = x - (origin?.left ?? 0),
        y = rect.bottom + 2 - (origin?.top ?? 0)
      const room = clearance(root, rect.top, rect.bottom, Boolean(local))
      const extent = extents.get(root)
      extents.set(root, {
        top: Math.min(extent?.top ?? Infinity, room.top),
        bottom: Math.max(extent?.bottom ?? -Infinity, room.bottom)
      })
      const before = result.at(-1)
      if (
        before?.index === index &&
        (Math.abs(before.y - y) < 2 ||
          (Math.abs((before.inkTop ?? before.top) - (room.top - (origin?.top ?? 0))) < 1 &&
            Math.abs((before.inkBottom ?? before.y - 2) - (room.bottom - (origin?.top ?? 0))) <
              1)) &&
        left - before.x - before.width < 3 &&
        left >= before.x
      ) {
        before.width = right - (origin?.left ?? 0) - before.x
        before.y = Math.max(before.y, y)
        before.top = Math.min(before.top, rect.top - (origin?.top ?? 0))
        before.height = before.y - 2 - before.top
        before.last = position === lines.length - 1
      } else {
        const band: SyntaxLightBand = {
          x: left,
          y,
          top: rect.top - (origin?.top ?? 0),
          width: right - x,
          height: rect.height,
          index,
          key: id + '-' + position,
          first: position === 0,
          last: position === lines.length - 1,
          inkTop: room.top - (origin?.top ?? 0),
          inkBottom: room.bottom - (origin?.top ?? 0),
          roomAbove: room.above,
          roomBelow: room.below,
          inkRight: room.inkRight - (origin?.left ?? 0),
          clipRight: room.clipRight - (origin?.left ?? 0)
        }
        result.push(band)
        owners.set(band, root)
      }
    }
  }
  // The corridor must clear every intervening row, but an unrelated wide paragraph
  // above/below this relation must not drag a short sentence's light across the page.
  const rights = new Map<Element, number>()
  for (const [root, extent] of extents) {
    const rows = (inkRows.get(root) ?? []).filter(
      (row) => row.bottom >= extent.top && row.top <= extent.bottom
    )
    rights.set(
      root,
      Math.max(root.getBoundingClientRect().left, ...rows.map((row) => row.right)) -
        (origin?.left ?? 0)
    )
  }
  for (const band of result) band.inkRight = rights.get(owners.get(band)!) ?? band.inkRight
  return result
}
