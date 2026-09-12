<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { hdrEnabled, hdrState, nativeInkEnabled } from '../effects/hdr'
import { createHdrBands } from '../effects/hdr-bands'
import { radianceSources, watchRadianceSources } from '../effects/radiance-sources'
import type { ColorBand } from '../effects/color-band'
import { aiState } from '../composables/aiReading'
import { studio } from '../composables/useStudio'
import { uiState } from '../composables/useSettings'
const canvas = ref<HTMLCanvasElement>(),
  visible = ref(false)
let renderer: Awaited<ReturnType<typeof createHdrBands>> | undefined
let frame = 0,
  generation = 0,
  preparing = false,
  disposed = false
let previous: ColorBand[] = [],
  width = 0,
  height = 0
let geometryDirty = true,
  trackingUntil = 0
let geometry: ColorBand[] = []
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
function gather(): ColorBand[] {
  const bands: ColorBand[] = []
  for (const layers of radianceSources())
    for (const layer of layers) {
      if (!layer.host.isConnected) continue
      const clip = layer.host.closest('.reader-scroll,.notes-scroll')?.getBoundingClientRect()
      if (!clip) continue
      const origin = layer.host.getBoundingClientRect()
      if (!origin.width || !origin.height || origin.bottom < clip.top || origin.top > clip.bottom)
        continue
      const sx = origin.width / (layer.host.offsetWidth || origin.width),
        sy = origin.height / (layer.host.offsetHeight || origin.height)
      for (const band of layer.bands) {
        if (!(band.ink.mark.radiance ?? 0)) continue
        const x = origin.x + (band.x + layer.host.clientLeft - layer.host.scrollLeft) * sx,
          y = origin.y + (band.y + layer.host.clientTop - layer.host.scrollTop) * sy
        if (
          y + band.height < clip.top ||
          y > clip.bottom ||
          x + band.width < clip.left ||
          x > clip.right
        )
          continue
        bands.push({ ...band, x, y, width: band.width * sx, height: band.height * sy })
      }
    }
  return bands
}
function start(): void {
  if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
}
function invalidate(): void {
  geometryDirty = true
  start()
}
function trackLayout(): void {
  trackingUntil = performance.now() + 1000
  invalidate()
}
async function prepare(): Promise<void> {
  if (preparing || !canvas.value) return
  const own = generation,
    target = canvas.value
  preparing = true
  try {
    const next = await createHdrBands(target, true, hdrEnabled.value)
    if (disposed || own !== generation) {
      next.dispose()
      return
    }
    renderer = next
    previous = []
    start()
  } catch (error) {
    if (own === generation) {
      hdrState.error = String(error)
      hdrState.engine = 'unavailable'
    }
  } finally {
    preparing = false
    if (!disposed && own !== generation) start()
  }
}
function paintSdr(bands: ColorBand[], now: number): void {
  const surface = canvas.value!,
    ctx = surface.getContext('2d', { alpha: true })
  if (!ctx) return
  const scale = devicePixelRatio
  if (surface.width !== Math.ceil(innerWidth * scale)) surface.width = Math.ceil(innerWidth * scale)
  if (surface.height !== Math.ceil(innerHeight * scale))
    surface.height = Math.ceil(innerHeight * scale)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, innerWidth, innerHeight)
  for (const band of bands) {
    const r = band.ink.mark.radiance ?? 0,
      t = Math.min(1, (now - band.ink.born) / 2600)
    ctx.globalAlpha = r * t * t * (3 - 2 * t) * aiState.intensity
    for (const [dx, dy, rx, ry, alpha] of [
      [0, 0, band.width * 0.7 + 55 * r, band.height + 48 * r, 0.36],
      [25 * r, -90 * r, 60 * r, 170 * r, 0.18]
    ]) {
      ctx.save()
      ctx.translate(band.x + band.width * 0.5 + dx, band.y + band.height * 0.5 + dy)
      ctx.scale(Math.max(0.01, rx), Math.max(0.01, ry))
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
      glow.addColorStop(0, '#fff8e8')
      glow.addColorStop(0.25, band.ink.palette.warm)
      glow.addColorStop(0.6, band.ink.palette.cool + '68')
      glow.addColorStop(1, band.ink.palette.cool + '00')
      ctx.globalAlpha *= alpha
      ctx.fillStyle = glow
      ctx.fillRect(-1, -1, 2, 2)
      ctx.restore()
    }
  }
}
function draw(now: number): void {
  frame = 0
  if (!canvas.value || document.hidden || disposed) return
  if (geometryDirty || now < trackingUntil) {
    geometry = gather()
    geometryDirty = false
  }
  const bands = aiState.lightsOn && studio.effectsMode !== 'off' ? geometry : []
  visible.value = bands.length > 0
  if (!bands.length) {
    previous = []
    return
  }
  if (nativeInkEnabled.value) {
    if (!renderer) {
      void prepare()
      return
    }
    if (
      width !== innerWidth ||
      height !== innerHeight ||
      previous.length !== bands.length ||
      bands.some((band, i) => {
        const old = previous[i]
        return (
          band.ink !== old.ink ||
          Math.abs(band.x - old.x) > 0.05 ||
          Math.abs(band.y - old.y) > 0.05 ||
          band.width !== old.width ||
          band.height !== old.height
        )
      })
    ) {
      width = innerWidth
      height = innerHeight
      previous = bands
      renderer.setTile({ key: 'radiance', x: 0, y: 0, width, height, bands })
    }
    renderer.draw({ now, wake: 0, intensity: aiState.intensity })
  } else paintSdr(bands, now)
  if (
    (nativeInkEnabled.value && studio.effectsMode === 'full' && !reduced.matches) ||
    bands.some((band) => now - band.ink.born < 2600)
  )
    start()
}
const off = watchRadianceSources(invalidate)
watch(
  () => [hdrEnabled.value, nativeInkEnabled.value],
  async () => {
    generation++
    renderer?.dispose()
    renderer = undefined
    previous = []
    await nextTick()
    invalidate()
  }
)
watch(() => [aiState.intensity, aiState.lightsOn, studio.effectsMode], start)
watch(() => [studio.focusMode, studio.noteWidth, uiState.tocOpen], trackLayout)
onMounted(() => {
  document.addEventListener('scroll', invalidate, true)
  window.addEventListener('resize', invalidate)
  document.addEventListener('visibilitychange', invalidate)
  reduced.addEventListener('change', start)
  start()
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  off()
  cancelAnimationFrame(frame)
  renderer?.dispose()
  document.removeEventListener('scroll', invalidate, true)
  window.removeEventListener('resize', invalidate)
  document.removeEventListener('visibilitychange', invalidate)
  reduced.removeEventListener('change', start)
})
</script>
<template>
  <canvas
    :key="hdrEnabled ? 'hdr' : nativeInkEnabled ? 'gpu-sdr' : 'canvas-sdr'"
    ref="canvas"
    class="radiance-field"
    :style="{ visibility: visible ? 'visible' : 'hidden' }"
    aria-hidden="true"
  />
</template>
<style>
.radiance-field {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 3;
}
</style>
