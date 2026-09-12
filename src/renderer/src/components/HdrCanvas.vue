<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { createHdrPresenter, hdrEnabled, hdrState, watchHdrSource } from '../effects/hdr'
import { studio } from '../composables/useStudio'
import type { HdrDamage } from '../effects/hdr-damage'
const props = defineProps<{ source?: HTMLCanvasElement; kind?: 'field' | 'light' }>()
const canvas = ref<HTMLCanvasElement>()
let presenter: Awaited<ReturnType<typeof createHdrPresenter>> | undefined,
  generation = 0
let unsubscribe: (() => void) | undefined
let visible = false
const intersection = new IntersectionObserver((entries) => {
  visible = entries.some((entry) => entry.isIntersecting)
  if (visible) draw()
})
function stop(): void {
  ++generation
  unsubscribe?.()
  unsubscribe = undefined
  intersection.disconnect()
  visible = false
  presenter?.dispose()
  presenter = undefined
}
function draw(damage?: HdrDamage): void {
  if (props.source && presenter && visible && !document.hidden) {
    try {
      presenter.draw(props.source, damage)
    } catch (error) {
      hdrState.engine = 'unavailable'
      hdrState.error = String(error)
      console.warn('[zhumo] HDR 光层已回退：', error)
      return
    }
  }
}
watch(
  () => [hdrEnabled.value, props.source, canvas.value, studio.effectsMode],
  async () => {
    stop()
    if (!hdrEnabled.value || !canvas.value || !props.source) return
    const ticket = generation
    try {
      const next = await createHdrPresenter(canvas.value, props.kind ?? 'light')
      if (ticket !== generation) {
        next.dispose()
        return
      }
      presenter = next
      unsubscribe = watchHdrSource(props.source, draw)
      intersection.observe(canvas.value)
      draw()
    } catch {
      /* Capability status already explains fallback. */
    }
  },
  { flush: 'post' }
)
onBeforeUnmount(stop)
const visibilityChanged = (): void => draw()
document.addEventListener('visibilitychange', visibilityChanged)
onBeforeUnmount(() => document.removeEventListener('visibilitychange', visibilityChanged))
</script>
<template><canvas v-if="hdrEnabled" ref="canvas" class="hdr-canvas" aria-hidden="true" /></template>
<style>
.hdr-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
