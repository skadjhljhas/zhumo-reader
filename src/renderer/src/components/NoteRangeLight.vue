<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { bookState } from '../composables/useBook'
import { searchTextParts } from '../composables/searchText'
let point: { x: number; y: number } | undefined
let frame = 0
function clear(): void {
  CSS.highlights?.delete('zhumo-note-range')
}
function scroll(event: Event): void {
  if (event.target instanceof Element && event.target.matches('.reader-scroll,.notes-scroll'))
    refresh()
}
function refresh(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = 0
    const underPointer = point && document.elementFromPoint(point.x, point.y)
    render(underPointer?.closest('.zmu-ref') ? underPointer : document.activeElement)
  })
}
function track(event: PointerEvent): void {
  point = { x: event.clientX, y: event.clientY }
}
function show(event: PointerEvent | FocusEvent): void {
  if (event instanceof PointerEvent) track(event)
  render(event.target instanceof Element ? event.target : null)
}
function leave(): void {
  point = undefined
  cancelAnimationFrame(frame)
  clear()
}
function render(target: Element | null | undefined): void {
  const ref = target?.closest<HTMLElement>('.zmu-ref')
  const text = bookState.book?.notes.find((note) => note.id === ref?.dataset.noteId)?.selectionRange
    ?.text
  if (!ref || !text || typeof Highlight === 'undefined') return clear()
  const owner = ref.closest('.section-body')
    ? ref.closest('.reader-scroll')
    : ref.closest('.zmu-note-body')
  if (!owner) return clear()
  const before = document.createRange()
  before.selectNodeContents(owner)
  before.setEndBefore(ref)
  const parts = searchTextParts(owner, true).filter((part) => before.intersectsNode(part.node))
  const source = parts
    .map((p) => p.text)
    .join('')
    .trimEnd()
  if (!source.endsWith(text)) return clear()
  const start = source.length - text.length,
    end = source.length
  let at = 0
  const range = document.createRange()
  let from = false,
    to = false
  for (const part of parts) {
    const next = at + part.text.length
    if (!from && start >= at && start < next) {
      if (part.atomic || !(part.node instanceof Text)) return clear()
      range.setStart(part.node, start - at)
      from = true
    }
    if (from && end > at && end <= next) {
      if (part.atomic || !(part.node instanceof Text)) return clear()
      range.setEnd(part.node, end - at)
      to = true
      break
    }
    at = next
  }
  if (from && to) CSS.highlights.set('zhumo-note-range', new Highlight(range))
  else clear()
}
onMounted(() => {
  document.addEventListener('pointerover', show)
  document.addEventListener('pointermove', track, { passive: true })
  document.documentElement.addEventListener('pointerleave', leave)
  document.addEventListener('focusin', show)
  document.addEventListener('scroll', scroll, true)
})
// A reopened book and restored scroll can replace nodes under a stationary pointer.
// Re-resolve the new source after rendering instead of requiring another mouse movement.
watch(
  () => bookState.book,
  () => {
    clear()
    refresh()
  },
  { flush: 'post' }
)
onBeforeUnmount(() => {
  leave()
  document.removeEventListener('pointerover', show)
  document.removeEventListener('pointermove', track)
  document.documentElement.removeEventListener('pointerleave', leave)
  document.removeEventListener('focusin', show)
  document.removeEventListener('scroll', scroll, true)
})
</script>
<template><span hidden aria-hidden="true"></span></template>
<style>
::highlight(zhumo-note-range) {
  background-color: color-mix(in srgb, var(--accent) 12%, transparent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent);
  text-underline-offset: 3px;
}
</style>
