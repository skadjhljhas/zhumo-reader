<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createAtmosphere, type Atmosphere } from '../effects/atmosphere'
import { MotionClock } from '../effects/manuscript/motion-clock'
import {
  dampingFactor,
  nativePointerTarget,
  themedNoteTarget,
  readingConnection
} from '../effects/reading-interaction'
import { studio } from '../composables/useStudio'
import { readerState } from '../composables/readerStore'
import { documentSession } from '../composables/documentSession'
import { uiState } from '../composables/useSettings'
import { notePeekRequest } from '../composables/notePeek'
import { bookState } from '../composables/useBook'
import { useManuscriptLight } from '../composables/manuscriptLight'
import { LucentFieldDynamics } from '../effects/lucent/dynamics'
import { readingFieldClock } from '../composables/readingFieldSession'
import { echoScrollUniform, echoState } from '../composables/readingEcho'
import HdrField from './HdrField.vue'
import { HdrFieldMotion } from '../effects/hdr-field'
import HdrThreads from './HdrThreads.vue'
import { hdrEnabled, prepareHdr } from '../effects/hdr'

const canvas = ref<HTMLCanvasElement>()
const cursor = ref<HTMLElement>()
const point = ref<HTMLElement>()
const connection = ref('')
const glint = ref({ left: 0, top: 0, width: 0, on: false })
const echoes = ref<Array<{ id: number; text: string; x: number; y: number }>>([])
const elapsed = ref(0)
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const cosmic = computed(() => studio.themeId === 'astral')
const clock = computed(
  () =>
    `${String(Math.floor(elapsed.value / 60)).padStart(2, '0')} : ${String(elapsed.value % 60).padStart(2, '0')}`
)
let engine: Atmosphere | undefined
let frame = 0,
  timer: ReturnType<typeof setInterval> | undefined
let x = innerWidth * 0.74,
  y = innerHeight * 0.34,
  followX = x,
  followY = y
let present = false,
  mode = 'air',
  lastText = '',
  lastTextTime = 0,
  echoId = 0
let noteId = '',
  lastLinkTime = 0,
  lastDraw = 0,
  paused = false
let hovered: Element | null = null
let pressing = false
let pointerFrame = 0
let linkAnchor: HTMLElement | null = null
const lightTime = new MotionClock()
const manuscript = useManuscriptLight()
const fieldDynamics = new LucentFieldDynamics()
const hdrMotion = new HdrFieldMotion()
function captureField(): void {
  const value = hdrMotion.current
  if (!value) return
  engine?.render(
    value.time,
    cosmic.value ? 1 : 0,
    value.x,
    value.y,
    value.progress,
    Math.min(devicePixelRatio, 1.75),
    value.field,
    value.scrolling,
    value.sky
  )
}
let fieldHover = { strength: 0, depth: 0, x: 0.5, y: 0.5 }
let lastFieldAudit = 0
let lastPointerMotion = 0
let renderedFrames = 0
function inspectFieldHover(target: EventTarget | null, px: number, py: number): void {
  const reference =
    target instanceof Element ? target.closest<HTMLElement>('.reader-scroll .zmu-ref') : null
  if (
    reference &&
    !pressing &&
    !window.getSelection()?.toString() &&
    documentSession.mode === 'read' &&
    !uiState.settingsOpen
  ) {
    const note = bookState.book?.notes.find((note) => note.id === reference.dataset.noteId)
    fieldHover = { strength: 1, depth: note?.level ?? 1, x: px / innerWidth, y: py / innerHeight }
  } else fieldHover = { ...fieldHover, strength: 0 }
}
function sampleField(now: number, moving: boolean): Float32Array {
  return fieldDynamics.sample(
    now,
    {
      wallTime: Date.now(),
      readingSeconds: readingFieldClock.seconds(now),
      progress: readerState.progress,
      profile: manuscript.value.profile,
      seed: manuscript.value.seed[0],
      encounter: manuscript.value.seed,
      navigation: echoScrollUniform(),
      habits: {
        textShare: echoState.textShare,
        dwell: echoState.seconds,
        stillness: present ? Math.min(1, Math.max(0, now - lastPointerMotion) / 12000) : 0,
        switches: echoState.switches
      },
      hover: fieldHover
    },
    moving
  )
}

function setMode(value: string): void {
  mode = value
  document.documentElement.dataset.cursorField = value
  if (cursor.value) cursor.value.dataset.mode = value
}
function clearHover(): void {
  hovered?.removeAttribute('data-optical-hover')
  hovered = null
  glint.value.on = false
}
function leave(): void {
  fieldHover.strength = 0
  present = false
  linkAnchor = null
  clearHover()
  connection.value = ''
  noteId = ''
  document.documentElement.dataset.cursorField = 'native'
}
function move(event: Pick<PointerEvent, 'target' | 'clientX' | 'clientY' | 'pointerType'>): void {
  const wasPresent = present
  if (Math.hypot(event.clientX - x, event.clientY - y) > 2) lastPointerMotion = performance.now()
  x = event.clientX
  y = event.clientY
  const target = event.target
  inspectFieldHover(target, x, y)
  if (
    !(target instanceof Element) ||
    documentSession.mode === 'edit' ||
    document.querySelector('dialog[open],.settings-panel') ||
    (notePeekRequest.value && !themedNoteTarget(target)) ||
    studio.effectsMode !== 'full' ||
    reducedMotion.matches ||
    event.pointerType !== 'mouse'
  ) {
    leave()
    return
  }
  if (pressing || window.getSelection()?.toString()) {
    leave()
    return
  }
  present = true
  const noteControl = themedNoteTarget(target)
  const control = nativePointerTarget(target) && !noteControl
  const textRegion = target.closest(
    '.section-body,.zmu-note-body,.welcome-copy h1,.document-overture h1'
  )
  let isText = false
  if (textRegion && !control && !noteControl) {
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const range = documentWithCaret.caretRangeFromPoint?.(x, y)
    const node = range?.startContainer
    if (range && node?.nodeType === Node.TEXT_NODE && textRegion.contains(node)) {
      const text = node.textContent ?? ''
      const offset = Math.min(range.startOffset, Math.max(0, text.length - 1))
      range.setStart(node, offset)
      range.setEnd(node, Math.min(text.length, offset + 1))
      const rect = range.getBoundingClientRect()
      isText =
        rect.width > 0 &&
        x >= rect.left - 5 &&
        x <= rect.right + 5 &&
        y >= rect.top - 3 &&
        y <= rect.bottom + 3
      if (isText) {
        lastText = text
          .slice(Math.max(0, offset - 1), offset + 5)
          .replace(/\s+/g, '')
          .trim()
        lastTextTime = performance.now()
        glint.value = {
          left: rect.left - 1,
          top: rect.bottom - 2,
          width: Math.max(10, rect.width + 2),
          on: true
        }
      }
    }
  }
  const nextMode = noteControl
    ? 'control'
    : control
      ? cosmic.value
        ? 'control'
        : 'native'
      : isText
        ? 'text'
        : 'air'
  if (control && !cosmic.value) present = false
  if (!wasPresent && present) {
    followX = x
    followY = y
  }
  if (
    cosmic.value &&
    mode === 'text' &&
    nextMode === 'air' &&
    lastText &&
    performance.now() - lastTextTime < 700
  ) {
    echoes.value = [
      ...echoes.value.slice(-1),
      {
        id: ++echoId,
        text: lastText,
        x: Math.min(innerWidth - 140, x + 24),
        y: Math.min(innerHeight - 70, y + 22)
      }
    ]
  }
  setMode(nextMode)
  const paragraph = isText ? target.closest('p,h1,h2,h3,li') : null
  if (paragraph !== hovered) {
    clearHover()
    hovered = paragraph
    if (cosmic.value) hovered?.setAttribute('data-optical-hover', 'true')
  }
  if (!isText || !cosmic.value) glint.value.on = false
  const nextId = target.closest<HTMLElement>('.zmu-ref,.note-card')?.dataset.noteId ?? ''
  const nextAnchor = target.closest<HTMLElement>('.reader-scroll .zmu-ref')
  if (nextId !== noteId || nextAnchor !== linkAnchor) {
    noteId = nextId
    linkAnchor = nextAnchor
    connection.value = readingConnection(noteId, linkAnchor)
  }
}
function pointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && themedNoteTarget(event.target)) return
  pressing = true
  leave()
}
watch(notePeekRequest, (request) => {
  if (request && !themedNoteTarget(document.elementFromPoint(x, y))) leave()
})
function pointerUp(event: PointerEvent): void {
  pressing = false
  if (event.pointerType === 'mouse' && themedNoteTarget(event.target)) move(event)
}
function updateConnection(): void {
  connection.value = readingConnection(noteId, linkAnchor)
}
function draw(now: number): void {
  frame = 0
  if (document.hidden || (paused && !hdrMotion.ready)) return
  const full = studio.effectsMode === 'full' && !reducedMotion.matches
  // Arm the next frame before doing work: a recoverable paint error must not kill the loop.
  if (full) frame = requestAnimationFrame(draw)
  if (studio.effectsMode !== 'off' && (full || !lastDraw)) {
    const field = sampleField(now, full)
    const phase = lightTime.sample(now, full)
    hdrMotion.update({
      time: phase,
      x: followX / innerWidth,
      y: followY / innerHeight,
      progress: readerState.progress,
      field,
      scrolling: echoScrollUniform(),
      sky: fieldDynamics.sky
    })
    if (!hdrEnabled.value || !hdrMotion.ready)
      engine?.render(
        phase,
        cosmic.value ? 1 : 0,
        followX / innerWidth,
        followY / innerHeight,
        readerState.progress,
        Math.min(devicePixelRatio, full ? 1.75 : 1),
        field,
        echoScrollUniform(),
        fieldDynamics.sky
      )
    renderedFrames++
    if (canvas.value && now - lastFieldAudit > 500) {
      canvas.value.dataset.readingSeconds = readingFieldClock.seconds(now).toFixed(1)
      canvas.value.dataset.fieldHover = field[8].toFixed(3)
      canvas.value.dataset.motionTime = phase.toFixed(3)
      canvas.value.dataset.frames = String(renderedFrames)
      canvas.value.dataset.fieldVersion = cosmic.value ? 'astral' : 'lucent-air-14'
      canvas.value.dataset.skySource = [...fieldDynamics.sky.subarray(0, 4)]
        .map((v) => v.toFixed(4))
        .join(',')
      lastFieldAudit = now
    }
    lastDraw = now
  }
  const response = pointerFrame ? dampingFactor(now - pointerFrame, mode === 'text' ? 24 : 80) : 1
  pointerFrame = now
  followX += (x - followX) * response
  followY += (y - followY) * response
  if (cursor.value) {
    const dx = x - followX,
      dy = y - followY
    const motion = Math.min(1, Math.hypot(dx, dy) / 54)
    if (motion > 0.025)
      cursor.value.style.setProperty('--flow-angle', (Math.atan2(dy, dx) * 180) / Math.PI + 'deg')
    cursor.value.style.setProperty('--flow-length', 12 + motion * 28 + 'px')
    cursor.value.style.setProperty('--flow-opacity', String(0.35 + motion * 0.5))
    cursor.value.style.transform = `translate3d(${followX}px,${followY}px,0)`
    cursor.value.style.opacity = present && full ? '1' : '0'
  }
  if (point.value) {
    point.value.style.transform = `translate3d(${x}px,${y}px,0)`
    point.value.style.opacity = present && full ? '1' : '0'
  }
  if (noteId && now - lastLinkTime > 60) {
    updateConnection()
    lastLinkTime = now
  }
}
function restart(): void {
  if (frame) cancelAnimationFrame(frame)
  if (
    studio.effectsMode !== 'off' &&
    !engine &&
    !paused &&
    canvas.value?.dataset.ready === 'pending'
  ) {
    contextRestored()
    return
  }
  frame = 0
  lastDraw = 0
  pointerFrame = 0
  lightTime.suspend()
  fieldDynamics.suspend()
  document.documentElement.dataset.optics = studio.effectsMode
  if (studio.effectsMode === 'off' || cosmic.value)
    if (studio.effectsMode !== 'full' || reducedMotion.matches) leave()
  frame = requestAnimationFrame(draw)
}
function contextLost(event: Event): void {
  event.preventDefault()
  paused = true
  if (frame) cancelAnimationFrame(frame)
  if (hdrEnabled.value && hdrMotion.ready) {
    frame = requestAnimationFrame(draw)
    return
  }
  leave()
  if (canvas.value) canvas.value.dataset.ready = 'fallback'
}
function contextRestored(): void {
  paused = false
  if (canvas.value) {
    if (studio.effectsMode === 'off') {
      engine = undefined
      canvas.value.dataset.ready = 'pending'
    } else {
      engine = createAtmosphere(canvas.value)
      if (engine)
        engine.render(
          lightTime.sample(performance.now(), false),
          cosmic.value ? 1 : 0,
          followX / innerWidth,
          followY / innerHeight,
          readerState.progress,
          Math.min(devicePixelRatio, 1.75),
          sampleField(performance.now(), false),
          echoScrollUniform(),
          fieldDynamics.sky
        )
      canvas.value.dataset.ready = engine ? 'webgl' : 'fallback'
    }
  }
  restart()
}
watch(() => [studio.themeId, studio.effectsMode, hdrEnabled.value], restart)
watch(() => documentSession.mode, leave)
watch(
  () => uiState.settingsOpen,
  (open) => {
    if (open) leave()
  }
)
watch(() => bookState.book, leave)
watch(
  () => bookState.status,
  (status) => {
    if (status !== 'reading') leave()
  }
)
onMounted(() => {
  if (navigator.gpu && studio.effectsMode !== 'off') void prepareHdr().catch(() => undefined)
  window.addEventListener('zhumo:capture-optics', captureField)
  if (canvas.value) {
    canvas.value.dataset.ready = 'pending'
  }
  document.documentElement.dataset.flagship = 'true'
  window.addEventListener('pointermove', move, { passive: true })
  window.addEventListener('pointerdown', pointerDown, { passive: true })
  window.addEventListener('pointerup', pointerUp, { passive: true })
  window.addEventListener('blur', leave)
  document.addEventListener('mouseleave', leave)
  document.addEventListener('visibilitychange', restart)
  window.addEventListener('pageshow', restart)
  reducedMotion.addEventListener('change', restart)
  window.addEventListener('resize', restart)
  canvas.value?.addEventListener('webglcontextlost', contextLost)
  canvas.value?.addEventListener('webglcontextrestored', contextRestored)
  timer = setInterval(() => {
    if (!document.hidden) elapsed.value++
    // Recovery only; no clock reset or reseeding. Quiet/hidden pages remain quiet.
    if (
      !document.hidden &&
      !paused &&
      studio.effectsMode === 'full' &&
      !reducedMotion.matches &&
      lastDraw &&
      performance.now() - lastDraw > 2500
    ) {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    }
  }, 1000)
  restart()
})
onBeforeUnmount(() => {
  window.removeEventListener('zhumo:capture-optics', captureField)
  if (frame) cancelAnimationFrame(frame)
  if (timer) clearInterval(timer)
  canvas.value?.removeEventListener('webglcontextlost', contextLost)
  canvas.value?.removeEventListener('webglcontextrestored', contextRestored)
  engine?.dispose()
  leave()
  document.documentElement.dataset.flagship = 'false'
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerdown', pointerDown)
  window.removeEventListener('pointerup', pointerUp)
  window.removeEventListener('blur', leave)
  document.removeEventListener('mouseleave', leave)
  document.removeEventListener('visibilitychange', restart)
  window.removeEventListener('pageshow', restart)
  reducedMotion.removeEventListener('change', restart)
  window.removeEventListener('resize', restart)
})
</script>
<template>
  <HdrThreads :paths="studio.hoverNotes ? [connection] : []" />
  <div
    class="reading-atmosphere"
    :class="{ cosmic, 'optics-off': studio.effectsMode === 'off' }"
    aria-hidden="true"
  >
    <canvas ref="canvas" class="optical-field" />
    <HdrField v-if="hdrEnabled" :motion="hdrMotion" />
    <div class="optical-grain" />
    <div v-if="!readerState.currentSectionId" class="space-latitude">
      <i /><span>{{ cosmic ? 'A DISTANCE MADE OF WORDS' : 'LIGHT BECOMES LANGUAGE' }}</span
      ><i />
    </div>
  </div>
  <div class="optical-overlays" aria-hidden="true">
    <svg class="thought-thread">
      <defs>
        <linearGradient id="thought-light">
          <stop stop-color="#68e9e8" />
          <stop offset=".5" stop-color="#b0a5ff" />
          <stop offset="1" stop-color="#ecbb7d" />
        </linearGradient>
      </defs>
      <path v-if="connection" :d="connection" class="thought-thread-glow" />
      <path v-if="connection" :d="connection" class="thought-thread-line" />
    </svg>
    <div ref="cursor" class="optical-cursor" data-mode="air"><i /><b /><span /></div>
    <div ref="point" class="optical-point" />
    <div
      class="reading-glint"
      :style="{
        left: `${glint.left}px`,
        top: `${glint.top}px`,
        width: `${glint.width}px`,
        opacity: glint.on ? 1 : 0
      }"
    />
    <span
      v-for="echo in echoes"
      :key="echo.id"
      class="word-afterimage"
      :style="{ left: `${echo.x}px`, top: `${echo.y}px` }"
      >{{ echo.text }}</span
    >
  </div>
  <div
    v-if="documentSession.mode === 'read' && uiState.tocOpen && !studio.focusMode"
    class="reading-spacetime"
    aria-hidden="true"
  >
    <span>{{ cosmic ? '星辰之间' : '光的此刻' }}</span
    ><b>{{ clock }}</b
    ><i /><span
      >{{
        Math.round(readerState.progress * 100)
          .toString()
          .padStart(2, '0')
      }}
      / 100</span
    >
  </div>
</template>
