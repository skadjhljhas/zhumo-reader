import { shallowRef } from 'vue'

export interface NotePeekRequest {
  noteId: string
  origin: HTMLElement
  expand: boolean
}
export const notePeekRequest = shallowRef<NotePeekRequest | null>(null)
export function openNotePeek(noteId: string, origin: HTMLElement, expand = false): void {
  notePeekRequest.value = { noteId, origin, expand }
}
export function closeNotePeek(): void {
  notePeekRequest.value = null
}

/** Keep an anchored sheet reachable without changing the document's scroll position. */
export function placeNotePeek(
  anchor: { left: number; top: number; right: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  expanded = false
): { left: number; top: number; connection: string } {
  const gap = 18,
    inset = 16
  const clamp = (value: number, size: number, available: number): number =>
    Math.max(inset, Math.min(value, available - size - inset))
  let left: number, top: number
  if (expanded) {
    left = (viewport.width - panel.width) / 2
    top = (viewport.height - panel.height) / 2
  } else if (anchor.right + gap + panel.width <= viewport.width - inset) {
    left = anchor.right + gap
    top = anchor.top - 58
  } else if (anchor.left - gap - panel.width >= inset) {
    left = anchor.left - gap - panel.width
    top = anchor.top - 58
  } else {
    left = (anchor.left + anchor.right - panel.width) / 2
    top =
      anchor.bottom + gap + panel.height <= viewport.height - inset
        ? anchor.bottom + gap
        : anchor.top - gap - panel.height
  }
  left = clamp(left, panel.width, viewport.width)
  top = clamp(top, panel.height, viewport.height)
  const x = (anchor.left + anchor.right) / 2,
    y = (anchor.top + anchor.bottom) / 2
  const inside = x >= left && x <= left + panel.width && y >= top && y <= top + panel.height
  if (inside || x < 0 || y < 0 || x > viewport.width || y > viewport.height)
    return { left, top, connection: '' }
  const endX = Math.max(left, Math.min(x, left + panel.width))
  const endY = Math.max(top + 20, Math.min(y, top + panel.height - 20))
  const middle = (x + endX) / 2
  return { left, top, connection: `M${x} ${y} C${middle} ${y} ${middle} ${endY} ${endX} ${endY}` }
}
