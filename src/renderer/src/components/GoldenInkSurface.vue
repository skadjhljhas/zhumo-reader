<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { ColorBand, ColorLayer } from '../effects/color-band'
import { captureGlyphMask, type GlyphMask } from '../effects/lucent/glyph-mask'
import { GlyphFonts } from '../effects/lucent/glyph-fonts'
import { createGoldenInk } from '../effects/golden-ink'
import { hdrEnabled, nativeInkEnabled, prepareHdr } from '../effects/hdr'
import { activeColorSurfaces } from '../effects/reading-palette'
import { studio } from '../composables/useStudio'
import { aiState } from '../composables/aiReading'
const props = defineProps<{ layer: ColorLayer; band: ColorBand }>()
const canvas = ref<HTMLCanvasElement>()
const padding = 20
let frame = 0,
  visible = false,
  disposed = false,
  dirty = true,
  generation = 0,
  preparing = false
let renderer: Awaited<ReturnType<typeof createGoldenInk>> | undefined
let mask: GlyphMask | undefined
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
function start(): void {
  if (!frame && visible && !disposed && !document.hidden) frame = requestAnimationFrame(draw)
}
function invalidate(): void {
  dirty = true
  start()
}
const fonts = new GlyphFonts(invalidate)
const observer = new IntersectionObserver((entries) => {
  visible = entries.some((entry) => entry.isIntersecting)
  if (visible) start()
  else {
    cancelAnimationFrame(frame)
    frame = 0
  }
})
async function prepare(): Promise<void> {
  if (preparing || !canvas.value) return
  preparing = true
  const own = generation
  try {
    const next = await createGoldenInk(canvas.value, hdrEnabled.value, () => {
      renderer = undefined
      invalidate()
    })
    if (disposed || own !== generation) next.dispose()
    else {
      renderer = next
      dirty = true
      start()
    }
  } catch {
    /* Original ink and the SDR fallback remain readable. */
  } finally {
    preparing = false
    if (own !== generation) start()
  }
}
function paintSdr(time: number, opacity: number): void {
  if (!mask || !canvas.value) return
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return
  const w = mask.canvas.width,
    h = mask.canvas.height
  if (canvas.value.width !== w) canvas.value.width = w
  if (canvas.value.height !== h) canvas.value.height = h
  ctx.clearRect(0, 0, w, h)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(mask.canvas, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  const x = Math.sin(time * 0.21) * w * 0.25
  const gold = ctx.createLinearGradient(x, 0, w + x, h)
  for (const [offset, color] of [
    [0, '#916020'],
    [0.25, '#c89939'],
    [0.44, '#ffe497'],
    [0.5, '#b38022'],
    [0.72, '#d3a647'],
    [1, '#916020']
  ] as const)
    gold.addColorStop(offset, color)
  ctx.fillStyle = gold
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.globalAlpha = opacity
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}
function draw(now: number): void {
  frame = 0
  if (!visible || disposed || document.hidden || !canvas.value) return
  if (dirty) {
    const { layer, band } = props,
      origin = layer.host.getBoundingClientRect()
    const bounds = new DOMRect(
      origin.left + band.x + layer.host.clientLeft,
      origin.top + band.y + layer.host.clientTop,
      band.width,
      band.height
    )
    mask = captureGlyphMask(layer.host, mask, (style, text) => fonts.family(style, text), {
      ranges: band.ink.ranges,
      bounds,
      padding
    })
    canvas.value.dataset.glyphs = String(mask.glyphs)
    renderer?.upload(mask.canvas, mask.width, mask.height)
    dirty = false
  }
  const t = Math.min(1, Math.max(0, (now - props.band.ink.born) / 2600))
  const reveal = t * t * (3 - 2 * t)
  const strength = Math.min(1, (props.band.ink.mark.radiance ?? 0) ** 0.6) * aiState.intensity
  const moving = studio.effectsMode === 'full' && !reduced.matches
  const time = moving ? now / 1000 : 5
  if (nativeInkEnabled.value) {
    if (!renderer) {
      void prepare()
      return
    }
    renderer.draw(time, strength, reveal)
  } else paintSdr(time, strength * reveal)
  if (moving || t < 1) start()
}
watch(() => [props.band, props.layer.width, props.layer.height, studio.themeId], invalidate)
watch(() => [studio.effectsMode, aiState.intensity], start)
watch(
  () => [hdrEnabled.value, nativeInkEnabled.value],
  async () => {
    generation++
    renderer?.dispose()
    renderer = undefined
    await nextTick()
    observer.disconnect()
    if (canvas.value) {
      activeColorSurfaces.add(canvas.value)
      observer.observe(canvas.value)
    }
    invalidate()
  }
)
onMounted(() => {
  if (canvas.value) {
    activeColorSurfaces.add(canvas.value)
    observer.observe(canvas.value)
  }
  if (navigator.gpu) void prepareHdr().catch(() => undefined)
  document.fonts.addEventListener('loadingdone', invalidate)
  window.addEventListener('zhumo-fonts-changed', invalidate)
  document.addEventListener('visibilitychange', start)
  reduced.addEventListener('change', start)
})
onBeforeUnmount(() => {
  disposed = true
  generation++
  cancelAnimationFrame(frame)
  observer.disconnect()
  renderer?.dispose()
  fonts.dispose()
  document.fonts.removeEventListener('loadingdone', invalidate)
  window.removeEventListener('zhumo-fonts-changed', invalidate)
  document.removeEventListener('visibilitychange', start)
  reduced.removeEventListener('change', start)
})
</script>
<template>
  <canvas
    ref="canvas"
    :key="hdrEnabled ? 'hdr' : nativeInkEnabled ? 'sdr-gpu' : 'sdr-canvas'"
    class="golden-ink-surface"
    aria-hidden="true"
    :data-quote="band.ink.mark.quote"
    :style="{
      left: band.x - padding + 'px',
      top: band.y - padding + 'px',
      width: band.width + padding * 2 + 'px',
      height: band.height + padding * 2 + 'px'
    }"
  />
</template>
<style>
.golden-ink-surface {
  position: absolute;
  display: block;
  pointer-events: none;
  user-select: none;
  z-index: 1;
}
@media print {
  .golden-ink-surface {
    display: none;
  }
}
</style>
