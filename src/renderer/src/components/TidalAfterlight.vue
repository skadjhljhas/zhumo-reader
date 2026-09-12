<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { studio } from '../composables/useStudio'
import { createAfterlight, type Afterlight } from '../effects/chaosheng/afterlight'
import { MotionClock } from '../effects/manuscript/motion-clock'

const props = defineProps<{ count: number; selected: number }>()
const canvas = ref<HTMLCanvasElement>()
const surface = ref<HTMLElement>()
const ready = ref('static')
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
const target = computed(() => (props.count > 1 ? props.selected / (props.count - 1) : 0.5))
let engine: Afterlight | undefined
let frame = 0,
  elapsed = 0,
  chosen = target.value
const clock = new MotionClock()
let width = 0,
  height = 0,
  mounted = false,
  lost = false
let pointer: [number, number] = [0, 0]
let host: HTMLElement | null = null
let draws = 0
let attempted = false
let failed = false
function measure(): void {
  if (!surface.value || !host) return
  const note = host.querySelector<HTMLElement>('.tidal-place-note')
  const top = note ? note.offsetTop + note.offsetHeight + 10 : host.clientHeight
  const space = Math.max(0, Math.min(310, host.clientHeight - top - 16))
  surface.value.style.top = top + 'px'
  surface.value.style.height = space + 'px'
  width = surface.value?.clientWidth ?? 0
  height = surface.value?.clientHeight ?? 0
  restart()
}
const observer = new ResizeObserver(measure)
function moving(): boolean {
  return studio.effectsMode === 'full' && !reduced.matches
}
function stop(): void {
  cancelAnimationFrame(frame)
  frame = 0
  clock.suspend()
}
function draw(now: number): void {
  frame = 0
  if (!mounted || lost || document.hidden || !engine || width < 1 || height < 1) return
  const animate = moving()
  const previous = elapsed
  elapsed = clock.sample(now, animate)
  const dt = elapsed - previous
  chosen = animate ? chosen + (target.value - chosen) * (1 - Math.exp(-dt * 3.2)) : target.value
  engine.draw({
    width,
    height,
    time: elapsed,
    chosen,
    density: Math.min(1, props.count / 12),
    pointer: animate ? pointer : [0, 0]
  })
  if (canvas.value) canvas.value.dataset.frames = String(++draws)
  if (animate) frame = requestAnimationFrame(draw)
}
function restart(): void {
  stop()
  if (!mounted || lost || document.hidden) return
  if (studio.effectsMode === 'off') {
    engine?.dispose()
    engine = undefined
    ready.value = 'static'
    failed = false
    return
  }
  if (width < 1 || height < 1) return
  if (!engine && !failed && canvas.value) {
    attempted = true
    engine = createAfterlight(canvas.value)
    failed = !engine
    ready.value = engine ? 'webgl' : 'fallback'
  }
  if (engine) frame = requestAnimationFrame(draw)
}
function point(event: PointerEvent): void {
  if (!moving() || !host) return
  const rect = host.getBoundingClientRect()
  pointer = [
    Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
    Math.max(-1, Math.min(1, 1 - ((event.clientY - rect.top) / rect.height) * 2))
  ]
}
function leave(): void {
  pointer = [0, 0]
}
function lose(event: Event): void {
  event.preventDefault()
  lost = true
  stop()
  engine?.dispose()
  engine = undefined
  ready.value = 'lost'
}
function restore(): void {
  lost = false
  failed = false
  restart()
}
watch(() => studio.effectsMode, restart)
watch([target, () => props.count], () => {
  void nextTick(measure)
})
onMounted(() => {
  mounted = true
  host = surface.value?.parentElement ?? null
  host?.addEventListener('pointermove', point)
  host?.addEventListener('pointerleave', leave)
  canvas.value?.addEventListener('webglcontextlost', lose)
  canvas.value?.addEventListener('webglcontextrestored', restore)
  reduced.addEventListener('change', restart)
  document.addEventListener('visibilitychange', restart)
  if (host) {
    observer.observe(host)
    for (const item of host.querySelectorAll('.tidal-place-context,.tidal-place-note'))
      observer.observe(item)
  }
  measure()
})
onBeforeUnmount(() => {
  mounted = false
  stop()
  observer.disconnect()
  host?.removeEventListener('pointermove', point)
  host?.removeEventListener('pointerleave', leave)
  canvas.value?.removeEventListener('webglcontextlost', lose)
  canvas.value?.removeEventListener('webglcontextrestored', restore)
  reduced.removeEventListener('change', restart)
  document.removeEventListener('visibilitychange', restart)
  engine?.dispose()
  if (attempted)
    canvas.value?.getContext('webgl')?.getExtension('WEBGL_lose_context')?.loseContext()
})
</script>
<template>
  <div ref="surface" class="tidal-afterlight" aria-hidden="true" :data-ready="ready">
    <svg class="tidal-afterlight-fallback" viewBox="0 0 680 280" fill="none">
      <path d="M28 173C196 27 356 263 654 105" stroke="#a5c4ed" stroke-width="1.4" />
      <path d="M7 192C191 36 395 254 670 121" stroke="#c5c9d4" stroke-width=".7" />
      <path d="M49 145C204 32 385 246 634 140" stroke="#b7c3d9" stroke-width="1" />
    </svg>
    <canvas ref="canvas" class="tidal-afterlight-field" />
    <div class="tidal-afterlight-rule"><i /><span>读过的时间，仍有微光。</span><i /></div>
  </div>
</template>
