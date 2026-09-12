<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { hdrEnabled } from '../effects/hdr'
import { settings, uiState } from '../composables/useSettings'
import { studio } from '../composables/useStudio'
import { GlyphFonts } from '../effects/lucent/glyph-fonts'
import type { HdrFieldMotion, HdrFieldFrame } from '../effects/hdr-field'
import { createGlyphReflections } from '../effects/lucent/reflections'
import {
  captureGlyphMask,
  needsGlyphMaskRefresh,
  type GlyphMask
} from '../effects/lucent/glyph-mask'
const props = defineProps<{ motion: HdrFieldMotion; enabled: boolean }>()
const ready = ref(false),
  canvas = ref<HTMLCanvasElement>()
let renderer: Awaited<ReturnType<typeof createGlyphReflections>> | undefined
let masks: GlyphMask[] = [],
  dirty = true,
  lastCapture = -Infinity,
  generation = 0,
  disposed = false,
  building = false,
  failed = false
const observed = new Set<Element>()
let requestedFrame = 0
function requestDraw(): void {
  if (disposed || requestedFrame || document.hidden || !props.enabled) return
  requestedFrame = requestAnimationFrame(() => {
    requestedFrame = 0
    if (props.motion.current) drawFrame(props.motion.current)
  })
}
const markDirty = (): void => {
  dirty = true
  requestDraw()
}
const fonts = new GlyphFonts(markDirty)
const nestedScroll = (event: Event): void => {
  if (!(event.target instanceof Element) || !event.target.closest('.reader-scroll,.notes-scroll'))
    return
  if (!event.target.matches('.reader-scroll,.notes-scroll')) dirty = true
  requestDraw()
}
const resourceLoaded = (event: Event): void => {
  if (event.target instanceof Element && event.target.closest('.reader-scroll,.notes-scroll'))
    markDirty()
}
const resizeObserver = new ResizeObserver(markDirty)
function observeContent(ports: HTMLElement[]): void {
  const next = new Set<Element>()
  for (const port of ports) {
    next.add(port)
    const box = port.getBoundingClientRect()
    for (const element of port.querySelectorAll('.section-body,.note-card')) {
      const rect = element.getBoundingClientRect()
      if (rect.height && rect.bottom >= box.top - 120 && rect.top <= box.bottom + 120)
        next.add(element)
    }
  }
  for (const element of observed)
    if (!next.has(element)) {
      resizeObserver.unobserve(element)
      observed.delete(element)
    }
  for (const element of next)
    if (!observed.has(element)) {
      observed.add(element)
      resizeObserver.observe(element)
    }
}
const observer = new MutationObserver((records) => {
  const content = records.some((record) => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    return (
      target?.closest('.reader-scroll,.notes-scroll') &&
      !target.closest('.reading-color-light,.syntax-light-layer')
    )
  })
  if (content) markDirty()
  else if (
    records.some(
      (record) =>
        record.type === 'attributes' ||
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(
              'dialog,.reading-selection,.settings-panel,.reader-scroll,.notes-scroll'
            ) ||
              node.querySelector('.reader-scroll,.notes-scroll'))
        )
    )
  )
    requestDraw()
})
async function prepare(): Promise<void> {
  if (building || failed || !canvas.value || !props.enabled) return
  const own = generation
  building = true
  try {
    const next = await createGlyphReflections(canvas.value, hdrEnabled.value, () => {
      if (disposed || own !== generation) return
      generation++
      renderer = undefined
      masks = []
      failed = false
      markDirty()
    })
    if (own !== generation || disposed) {
      next.dispose()
      return
    }
    renderer = next
    if (canvas.value) delete canvas.value.dataset.reflectionError
    dirty = true
    if (props.motion.current) drawFrame(props.motion.current)
  } catch (error) {
    if (own === generation && !disposed) {
      failed = true
      if (canvas.value) canvas.value.dataset.reflectionError = String(error)
    }
  } finally {
    building = false
    if (own !== generation && !disposed) void prepare()
  }
}
function drawFrame(frame: HdrFieldFrame): void {
  if (!canvas.value || disposed || document.hidden) return
  const visible =
    props.enabled && !document.querySelector('dialog[open],.reading-selection,.settings-panel')
  canvas.value.style.visibility = visible ? 'visible' : 'hidden'
  if (!visible) return
  if (!renderer) {
    void prepare()
    return
  }
  const now = performance.now()
  const ports = [...document.querySelectorAll<HTMLElement>('.reader-scroll,.notes-scroll')].filter(
    (port) => port.getBoundingClientRect().height > 0
  )
  const rebuild = dirty || ports.length !== masks.length || masks.some(needsGlyphMaskRefresh)
  if (rebuild && (now - lastCapture > 120 || !masks.length)) {
    masks = ports.map((port) => {
      const old = masks.find((mask) => mask.port === port)
      return !dirty && old && !needsGlyphMaskRefresh(old)
        ? old
        : captureGlyphMask(port, old, (style, text) => fonts.family(style, text))
    })
    renderer.setMasks(masks.filter((mask) => mask.glyphs > 0))
    observeContent(ports)
    lastCapture = now
    dirty = false
  } else if (rebuild) requestDraw()
  renderer.draw(frame)
}
const off = props.motion.subscribe(drawFrame)
watch(
  () => hdrEnabled.value,
  async () => {
    generation++
    renderer?.dispose()
    renderer = undefined
    masks = []
    failed = false
    await nextTick()
    void prepare()
  }
)
watch(
  () => props.enabled,
  (value) => {
    if (value) {
      if (!renderer) failed = false
      markDirty()
    }
  }
)
watch(
  () => [
    settings.fontSize,
    settings.lineHeight,
    settings.contentWidth,
    settings.bodyFont,
    settings.noteFont,
    settings.paragraphStyle,
    settings.sidebarVisible,
    studio.noteWidth,
    studio.noteFontSize,
    studio.focusMode,
    uiState.tocOpen
  ],
  markDirty,
  { flush: 'post' }
)
watch(() => studio.effectsMode, requestDraw, { flush: 'post' })
onMounted(() => {
  ready.value = true
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['open']
  })
  window.addEventListener('resize', markDirty)
  document.fonts.addEventListener('loadingdone', markDirty)
  document.addEventListener('scroll', nestedScroll, true)
  document.addEventListener('visibilitychange', requestDraw)
  document.addEventListener('load', resourceLoaded, true)
  void nextTick().then(prepare)
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  off()
  cancelAnimationFrame(requestedFrame)
  renderer?.dispose()
  observer.disconnect()
  resizeObserver.disconnect()
  fonts.dispose()
  window.removeEventListener('resize', markDirty)
  document.fonts.removeEventListener('loadingdone', markDirty)
  document.removeEventListener('scroll', nestedScroll, true)
  document.removeEventListener('visibilitychange', requestDraw)
  document.removeEventListener('load', resourceLoaded, true)
})
</script>
<template>
  <Teleport v-if="ready" to=".studio-frame"
    ><canvas
      :key="hdrEnabled ? 'hdr' : 'sdr'"
      ref="canvas"
      class="glyph-reflection-field"
      :style="{ visibility: enabled ? 'visible' : 'hidden' }"
      aria-hidden="true"
  /></Teleport>
</template>
<style>
.glyph-reflection-field {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 3;
}
</style>
