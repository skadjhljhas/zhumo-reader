<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useManuscriptLight } from '../composables/manuscriptLight'
import { studio } from '../composables/useStudio'
import { createManuscriptLight, type ManuscriptLightRenderer } from '../effects/manuscript/render'
import { MotionClock } from '../effects/manuscript/motion-clock'
import { fallbackStrokes } from '../effects/manuscript/fallback'
import HdrCanvas from './HdrCanvas.vue'
import { markHdrSourceDirty } from '../effects/hdr'

const canvas = ref<HTMLCanvasElement>()
const manuscriptLight = useManuscriptLight()
const ready = ref('pending')
const id = useId()
const fallback = computed(() =>
  fallbackStrokes(
    manuscriptLight.value.profile,
    manuscriptLight.value.seed,
    studio.themeId === 'chaosheng'
  )
)
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
const clock = new MotionClock()
let renderer: ManuscriptLightRenderer | undefined,
  frame = 0
let visible = true,
  lost = false
const moving = (): boolean => studio.effectsMode === 'full' && !reduced.matches
function draw(now: number): void {
  frame = 0
  if (!visible || document.hidden || lost || studio.effectsMode === 'off') {
    clock.suspend()
    return
  }
  const elapsed = clock.sample(now, moving())
  const { profile, seed } = manuscriptLight.value
  if (profile)
    renderer?.draw(elapsed, studio.themeId === 'chaosheng' ? 1 : 0, profile, seed, new Date(), {
      smoothChanges: moving()
    })
  if (moving() && renderer && profile) frame = requestAnimationFrame(draw)
  markHdrSourceDirty(canvas.value)
}
function restart(): void {
  cancelAnimationFrame(frame)
  clock.suspend()
  frame = requestAnimationFrame(draw)
}
const resize = new ResizeObserver((entries) => {
  if (!canvas.value) return
  const size = entries[0].contentRect,
    scale = Math.min(devicePixelRatio, 2)
  const width = Math.max(1, Math.round(size.width * scale)),
    height = Math.max(1, Math.round(size.height * scale))
  if (canvas.value.width !== width) canvas.value.width = width
  if (canvas.value.height !== height) canvas.value.height = height
  restart()
})
const intersection = new IntersectionObserver((entries) => {
  visible = entries[0].isIntersecting
  restart()
})
function contextLost(event: Event): void {
  event.preventDefault()
  lost = true
  cancelAnimationFrame(frame)
  clock.suspend()
  ready.value = 'fallback'
  if (canvas.value) canvas.value.dataset.ready = 'fallback'
}
function restore(): void {
  if (!canvas.value) return
  if (studio.effectsMode === 'off') {
    renderer = undefined
    ready.value = 'pending'
    canvas.value.dataset.ready = 'pending'
    lost = false
    restart()
    return
  }
  renderer = createManuscriptLight(canvas.value)
  const { profile, seed } = manuscriptLight.value
  if (renderer && profile)
    renderer.draw(
      clock.sample(performance.now(), false),
      studio.themeId === 'chaosheng' ? 1 : 0,
      profile,
      seed,
      new Date()
    )
  ready.value = renderer ? 'webgl' : 'fallback'
  canvas.value.dataset.ready = ready.value
  lost = false
  restart()
}
watch(() => [studio.themeId, studio.effectsMode, manuscriptLight.value], restart)
watch(
  () => studio.effectsMode,
  (mode) => {
    if (mode !== 'off' && ready.value === 'pending') restore()
  }
)
onMounted(() => {
  if (!canvas.value) return
  if (studio.effectsMode !== 'off') restore()
  resize.observe(canvas.value)
  intersection.observe(canvas.value)
  canvas.value.addEventListener('webglcontextlost', contextLost)
  canvas.value.addEventListener('webglcontextrestored', restore)
  document.addEventListener('visibilitychange', restart)
  reduced.addEventListener('change', restart)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  resize.disconnect()
  intersection.disconnect()
  canvas.value?.removeEventListener('webglcontextlost', contextLost)
  canvas.value?.removeEventListener('webglcontextrestored', restore)
  document.removeEventListener('visibilitychange', restart)
  reduced.removeEventListener('change', restart)
  renderer?.dispose()
})
</script>
<template>
  <div
    class="manuscript-light"
    aria-hidden="true"
    :data-measured="Boolean(manuscriptLight.profile)"
  >
    <canvas ref="canvas" class="manuscript-light-canvas" />
    <HdrCanvas :source="canvas" />
    <svg
      v-if="ready !== 'webgl'"
      class="manuscript-light-fallback"
      viewBox="0 0 440 240"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient :id="id + '-light'" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="var(--fallback-blue)" stop-opacity="0" />
          <stop offset=".25" stop-color="var(--fallback-blue)" stop-opacity=".65" />
          <stop offset=".53" stop-color="var(--fallback-white)" />
          <stop offset=".77" stop-color="var(--fallback-violet)" stop-opacity=".6" />
          <stop offset="1" stop-color="var(--fallback-violet)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="fallback-aura" :stroke="'url(#' + id + '-light)'" stroke-width="9">
        <path
          v-for="(stroke, i) in fallback"
          :key="i"
          :d="stroke.path"
          :opacity="stroke.opacity * 0.25"
        />
      </g>
      <g :stroke="'url(#' + id + '-light)'" stroke-width="1.1">
        <path v-for="(stroke, i) in fallback" :key="i" :d="stroke.path" :opacity="stroke.opacity" />
      </g>
    </svg>
  </div>
</template>
