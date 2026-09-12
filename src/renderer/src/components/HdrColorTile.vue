<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { createHdrBands, type HdrBandMotion } from '../effects/hdr-bands'
import type { ColorTile } from '../effects/color-tiles'
import { hdrState } from '../effects/hdr'
const props = defineProps<{ tile: ColorTile; motion: HdrBandMotion; hdr: boolean }>()
const canvas = ref<HTMLCanvasElement>()
let renderer: Awaited<ReturnType<typeof createHdrBands>> | undefined
let density: MediaQueryList | undefined
function densityChanged(): void {
  density?.removeEventListener('change', densityChanged)
  density = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
  density.addEventListener('change', densityChanged)
  draw()
}
let visible = false,
  disposed = false,
  preparing = false,
  dirty = true
function draw(): void {
  if (!visible || document.hidden || !renderer) return
  if (dirty) {
    renderer.setTile(props.tile)
    dirty = false
  }
  renderer.draw({ ...props.motion.current, now: performance.now() })
}
async function show(): Promise<void> {
  if (!canvas.value || preparing || disposed) return
  if (!renderer) {
    preparing = true
    try {
      const next = await createHdrBands(canvas.value, false, props.hdr)
      if (disposed) {
        next.dispose()
        return
      }
      renderer = next
    } catch (error) {
      hdrState.engine = 'unavailable'
      hdrState.error = String(error)
    } finally {
      preparing = false
    }
  }
  draw()
}
const observer = new IntersectionObserver((entries) => {
  visible = entries.some((entry) => entry.isIntersecting)
  if (visible) void show()
})
const unsubscribe = props.motion.subscribe(draw)
watch(
  () => props.tile,
  () => {
    dirty = true
    draw()
  }
)
onMounted(() => {
  if (canvas.value) observer.observe(canvas.value)
  document.addEventListener('visibilitychange', draw)
  window.addEventListener('resize', draw)
  densityChanged()
})
onBeforeUnmount(() => {
  disposed = true
  unsubscribe()
  observer.disconnect()
  renderer?.dispose()
  document.removeEventListener('visibilitychange', draw)
  window.removeEventListener('resize', draw)
  density?.removeEventListener('change', densityChanged)
})
</script>
<template>
  <canvas ref="canvas" :class="hdr ? 'hdr-canvas' : 'sdr-color-canvas'" aria-hidden="true" />
</template>
<style>
.sdr-color-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
