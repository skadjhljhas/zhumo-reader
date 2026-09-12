<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RadianceField from './RadianceField.vue'
import { createShore, type Shore } from '../effects/chaosheng/shore'
import { MotionClock } from '../effects/manuscript/motion-clock'
import {
  dampingFactor,
  nativePointerTarget,
  themedNoteTarget,
  readingConnection
} from '../effects/reading-interaction'
import { uiState } from '../composables/useSettings'
import { studio } from '../composables/useStudio'
import { readerState } from '../composables/readerStore'
import { documentSession } from '../composables/documentSession'
import { bookState } from '../composables/useBook'
import { notePeekRequest } from '../composables/notePeek'
import { echoScrollUniform } from '../composables/readingEcho'
const canvas = ref<HTMLCanvasElement>(),
  cursor = ref<HTMLElement>(),
  nib = ref<HTMLElement>()
const tether = ref('')
const off = computed(() => studio.effectsMode === 'off')
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const observed = new Set<Element>()
const resizeObserver = new ResizeObserver(() => {
  geometryDirty = true
  if (!full()) restart()
})
let engine: Shore | undefined,
  frame = 0,
  elapsed = 0,
  paused = false
const shoreTime = new MotionClock()
let present = false,
  pressing = false,
  mode = 'native',
  geometryDirty = true
let x = innerWidth * 0.72,
  y = innerHeight * 0.4,
  followX = x,
  followY = y,
  lastWake = -1
let hero: [number, number, number, number] = [0, 0, 0, 0]
let reader: [number, number, number, number] = [0.5, 0.5, 0.35, 0.6]
const ripples = new Float32Array(32)
for (let i = 0; i < 8; i++) ripples[i * 4 + 2] = -100
let ripple = 0,
  depth = 0,
  targetDepth = 0
let lastMeasure = 0
let pointerInside = false
let targetAtPointer: Element | null = null
let linkId = '',
  lastLink = 0
let linkAnchor: HTMLElement | null = null
let pointerFrame = 0
const full = (): boolean => studio.effectsMode === 'full' && !reduced.matches
function cursorMode(value: string): void {
  mode = value
  document.documentElement.dataset.tideCursor = value
  if (cursor.value) cursor.value.dataset.mode = value
}
function leave(): void {
  present = false
  linkAnchor = null
  cursorMode('native')
  linkId = ''
  tether.value = ''
}
function forget(): void {
  leave()
  geometryDirty = true
}
function outside(): void {
  pointerInside = false
  targetAtPointer = null
  leave()
}
function bounds(): void {
  targetAtPointer = null
  const layout = new Set(
    document.querySelectorAll('.reader-column,.document-overture,.welcome-art,.app-center')
  )
  for (const element of observed) {
    if (!layout.has(element)) {
      resizeObserver.unobserve(element)
      observed.delete(element)
    }
  }
  for (const element of layout) {
    if (!observed.has(element)) {
      resizeObserver.observe(element)
      observed.add(element)
    }
  }
  const art = document.querySelector<HTMLElement>(
    '.document-overture .theme-art, .welcome-art .theme-art'
  )
  if (art) {
    const rect = art.getBoundingClientRect()
    hero = [
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      Math.min(rect.width, rect.height) * 0.43,
      rect.bottom > 70 && rect.top < innerHeight - 34 ? 1 : 0
    ]
  } else hero[3] = 0
  const column = document.querySelector('.reader-column')?.getBoundingClientRect()
  if (column)
    reader = [
      (column.left + column.width / 2) / innerWidth,
      (column.top + column.height / 2) / innerHeight,
      column.width / innerWidth,
      column.height / innerHeight
    ]
  geometryDirty = false
}
function wordAt(region: Element): Range | undefined {
  const caretDocument = document as Document & {
    caretRangeFromPoint(x: number, y: number): Range | null
  }
  const caret = caretDocument.caretRangeFromPoint(x, y)
  if (
    !caret ||
    caret.startContainer.nodeType !== Node.TEXT_NODE ||
    !region.contains(caret.startContainer)
  )
    return
  const node = caret.startContainer,
    text = node.textContent ?? ''
  for (const offset of [caret.startOffset, caret.startOffset - 1]) {
    if (offset < 0 || offset >= text.length) continue
    const glyph = document.createRange()
    glyph.setStart(node, offset)
    glyph.setEnd(node, Math.min(text.length, offset + 1))
    const rect = glyph.getBoundingClientRect()
    if (x < rect.left - 1 || x > rect.right + 1 || y < rect.top || y > rect.bottom) continue
    const start = Math.max(0, offset - 70)
    for (const token of segmenter.segment(text.slice(start, offset + 72))) {
      const from = start + token.index,
        to = from + token.segment.length
      if (from <= offset && to > offset && token.segment.trim()) {
        const range = document.createRange()
        range.setStart(node, from)
        range.setEnd(node, to)
        return range
      }
    }
  }
  return
}
function move(event: Pick<PointerEvent, 'target' | 'clientX' | 'clientY' | 'pointerType'>): void {
  const wasPresent = present
  const oldX = x,
    oldY = y
  x = event.clientX
  y = event.clientY
  const target = event.target
  pointerInside = event.pointerType === 'mouse'
  targetAtPointer = target instanceof Element ? target : null
  if (
    !(target instanceof Element) ||
    !full() ||
    pressing ||
    event.pointerType !== 'mouse' ||
    documentSession.mode !== 'read' ||
    document.querySelector('dialog[open],.settings-panel') ||
    (notePeekRequest.value && !themedNoteTarget(target)) ||
    window.getSelection()?.toString()
  ) {
    leave()
    return
  }
  const noteControl = themedNoteTarget(target)
  const control = nativePointerTarget(target) && !noteControl
  const nextId = target.closest<HTMLElement>('.zmu-ref,.note-card')?.dataset.noteId ?? ''
  const nextAnchor = target.closest<HTMLElement>('.reader-scroll .zmu-ref')
  if (nextId !== linkId || nextAnchor !== linkAnchor) {
    linkId = nextId
    linkAnchor = nextAnchor
    tether.value = readingConnection(linkId, linkAnchor)
  }
  if (control) {
    present = false
    cursorMode('native')
    return
  }
  present = true
  if (!wasPresent) {
    followX = x
    followY = y
  }
  const region = target.closest(
    '.section-body,.zmu-note-body,.document-overture h1,.welcome-copy h1'
  )
  const candidate = region && !noteControl ? wordAt(region) : undefined
  cursorMode(noteControl ? 'control' : candidate ? 'text' : 'air')
  const speed = Math.hypot(x - oldX, y - oldY)
  if (elapsed - lastWake > 0.09 && speed > 1.5) {
    const slot = (ripple++ % 8) * 4
    ripples[slot] = x / innerWidth
    ripples[slot + 1] = 1 - y / innerHeight
    ripples[slot + 2] = elapsed
    ripples[slot + 3] = Math.min(1, speed / 30) * (candidate ? 0.16 : 1)
    lastWake = elapsed
  }
}
function down(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && themedNoteTarget(event.target)) return
  pressing = true
  leave()
}
function up(event: PointerEvent): void {
  pressing = false
  targetAtPointer = null
  if (event.pointerType === 'mouse' && themedNoteTarget(event.target)) move(event)
}
function connect(): void {
  tether.value = readingConnection(linkId, linkAnchor)
}
function draw(now: number): void {
  frame = 0
  if (document.hidden || paused) {
    shoreTime.suspend()
    return
  }
  elapsed = shoreTime.sample(now, full())
  const changedLayout = geometryDirty
  if (geometryDirty) bounds()
  const delta = pointerFrame ? now - pointerFrame : 16
  pointerFrame = now
  depth = full() ? depth + (targetDepth - depth) * dampingFactor(delta, 290) : targetDepth
  const response = dampingFactor(delta, mode === 'text' ? 28 : 110)
  followX += (x - followX) * response
  followY += (y - followY) * response
  if (!off.value)
    engine?.draw({
      time: elapsed,
      progress: readerState.progress,
      depth,
      pointer: [followX / innerWidth, followY / innerHeight],
      presence: present ? 1 : 0,
      hero,
      reader,
      ripples,
      scale: Math.min(devicePixelRatio, full() ? 2 : 1.5),
      moving: full(),
      contact: [x / innerWidth, y / innerHeight],
      interaction: present ? (mode === 'text' ? 0.12 : 1) : 0,
      scrolling: echoScrollUniform()
    })
  if (cursor.value) {
    cursor.value.style.transform = 'translate3d(' + followX + 'px,' + followY + 'px,0)'
    cursor.value.style.opacity = present && full() ? '1' : '0'
  }
  if (nib.value) {
    nib.value.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'
    nib.value.style.opacity = present && full() ? '1' : '0'
    nib.value.dataset.mode = mode
  }
  if (full()) {
    if (now - lastMeasure > 100) {
      // A drawer closing, paragraph reflowing or scroll settling can expose a
      // different glyph beneath a stationary pointer without a pointermove.
      if (pointerInside && !pressing) {
        const target = document.elementFromPoint(x, y)
        if (changedLayout || target !== targetAtPointer)
          move({ target, clientX: x, clientY: y, pointerType: 'mouse' })
      }
      lastMeasure = now
    }
    if (now - lastLink > 75) {
      connect()
      lastLink = now
    }
    frame = requestAnimationFrame(draw)
  }
}
function restart(): void {
  cancelAnimationFrame(frame)
  if (!off.value && !engine && !paused && canvas.value?.dataset.ready === 'pending') {
    restored()
    return
  }
  frame = 0
  shoreTime.suspend()
  pointerFrame = 0
  document.documentElement.dataset.tideMotion = full() ? 'full' : 'still'
  if (!full()) leave()
  geometryDirty = true
  if (!document.hidden) frame = requestAnimationFrame(draw)
}
function scroll(): void {
  geometryDirty = true
  leave()
  if (!full()) restart()
}
function lost(event: Event): void {
  event.preventDefault()
  paused = true
  cancelAnimationFrame(frame)
  frame = 0
  leave()
  document.documentElement.dataset.tideReady = 'fallback'
  if (canvas.value) canvas.value.dataset.ready = 'fallback'
}
function restored(): void {
  paused = false
  if (canvas.value) {
    if (off.value) {
      engine = undefined
      canvas.value.dataset.ready = 'pending'
    } else {
      engine = createShore(canvas.value)
      if (engine) draw(performance.now())
      canvas.value.dataset.ready = engine ? 'webgl' : 'fallback'
    }
    document.documentElement.dataset.tideReady = canvas.value.dataset.ready
  }
  restart()
}
watch(() => studio.effectsMode, restart)
watch(
  () => uiState.settingsOpen,
  (open) => {
    if (open) leave()
  }
)
watch(() => documentSession.mode, forget)
watch(
  () => bookState.book,
  () => {
    forget()
    restart()
  }
)
watch(
  () => bookState.status,
  (status) => {
    if (status !== 'reading') leave()
  }
)
watch(
  () => [readerState.focusNoteId, notePeekRequest.value?.noteId],
  () => {
    const id = notePeekRequest.value?.noteId || readerState.focusNoteId
    targetDepth = bookState.book?.notes.find((note) => note.id === id)?.level ?? 0
    if (notePeekRequest.value && !themedNoteTarget(document.elementFromPoint(x, y))) leave()
    if (!full()) restart()
  }
)
onMounted(() => {
  restored()
  window.addEventListener('pointermove', move, { passive: true })
  window.addEventListener('pointerdown', down, { passive: true })
  window.addEventListener('pointerup', up, { passive: true })
  window.addEventListener('blur', outside)
  window.addEventListener('pointerover', move, { passive: true })
  window.addEventListener('resize', restart)
  document.addEventListener('scroll', scroll, true)
  document.addEventListener('visibilitychange', restart)
  document.addEventListener('mouseleave', outside)
  reduced.addEventListener('change', restart)
  canvas.value?.addEventListener('webglcontextlost', lost)
  canvas.value?.addEventListener('webglcontextrestored', restored)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  resizeObserver.disconnect()
  observed.clear()
  canvas.value?.removeEventListener('webglcontextlost', lost)
  canvas.value?.removeEventListener('webglcontextrestored', restored)
  engine?.dispose()
  forget()
  delete document.documentElement.dataset.tideReady
  delete document.documentElement.dataset.tideMotion
  delete document.documentElement.dataset.tideCursor
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerdown', down)
  window.removeEventListener('pointerup', up)
  window.removeEventListener('blur', outside)
  window.removeEventListener('pointerover', move)
  window.removeEventListener('resize', restart)
  document.removeEventListener('scroll', scroll, true)
  document.removeEventListener('visibilitychange', restart)
  document.removeEventListener('mouseleave', outside)
  reduced.removeEventListener('change', restart)
})
</script>
<template>
  <div class="chaosheng-atmosphere" :class="{ 'tide-off': off }" aria-hidden="true">
    <canvas ref="canvas" class="tidal-field" />
    <RadianceField />
    <div class="tidal-vignette" />
  </div>
  <div class="tidal-overlays" aria-hidden="true">
    <svg class="tidal-tether"><path v-if="tether" :d="tether" /></svg>
    <div ref="cursor" class="tidal-cursor"><i /><b /></div>
    <div ref="nib" class="tidal-nib" />
  </div>
</template>
