<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import type { ColorLayer } from '../effects/color-band'
import { studio } from '../composables/useStudio'
import { aiState } from '../composables/aiReading'
import { hdrEnabled, nativeInkEnabled, prepareHdr } from '../effects/hdr'
import { HdrBandMotion } from '../effects/hdr-bands'
import { activeColorSurfaces } from '../effects/reading-palette'
import { colorTiles } from '../effects/color-tiles'
import HdrColorTile from './HdrColorTile.vue'
const props = defineProps<{ layer: ColorLayer }>()
const wrapper = ref<HTMLElement>()
const motion = new HdrBandMotion()
const tiles = computed(() =>
  nativeInkEnabled.value ? colorTiles(props.layer.bands, props.layer.width, props.layer.height) : []
)
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let scroll: Element | null = null,
  lastTop = 0,
  displacement = 0,
  lastTime = 0,
  frame = 0
let visible = false,
  lastWake = ''
const intersection = new IntersectionObserver((entries) => {
  visible = entries.some((entry) => entry.isIntersecting)
  if (visible) start()
  else {
    cancelAnimationFrame(frame)
    frame = 0
    displacement = 0
  }
})
function moved(): void {
  const next = (scroll as HTMLElement)?.scrollTop ?? 0
  if (visible && studio.effectsMode === 'full' && !reduced.matches)
    displacement = Math.max(-7, Math.min(7, displacement + (next - lastTop) * 0.055))
  lastTop = next
  start()
}
function start(): void {
  if (!frame && visible && !document.hidden) frame = requestAnimationFrame(draw)
}
function draw(now: number): void {
  frame = 0
  const dt = Math.min(80, now - (lastTime || now))
  lastTime = now
  displacement *= Math.exp(-dt / 420)
  const wake = displacement.toFixed(3) + 'px'
  if (!nativeInkEnabled.value && wake !== lastWake) {
    wrapper.value?.style.setProperty('--color-wake', wake)
    lastWake = wake
  }
  if (nativeInkEnabled.value && !document.hidden)
    motion.update(displacement, aiState.intensity, now)
  const revealing = props.layer.bands.some((band) => now - band.ink.born < 2600)
  if (Math.abs(displacement) > 0.02 || (nativeInkEnabled.value && !document.hidden && revealing))
    start()
}
watch(() => [props.layer, nativeInkEnabled.value, aiState.intensity, studio.effectsMode], start)
onMounted(() => {
  if (navigator.gpu) void prepareHdr().catch(() => undefined)
  if (wrapper.value) {
    activeColorSurfaces.add(wrapper.value)
    intersection.observe(wrapper.value)
  }
  scroll = props.layer.host.closest('.reader-scroll,.notes-scroll')
  lastTop = (scroll as HTMLElement)?.scrollTop ?? 0
  scroll?.addEventListener('scroll', moved, { passive: true })
  document.addEventListener('visibilitychange', start)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  intersection.disconnect()
  document.removeEventListener('visibilitychange', start)
  scroll?.removeEventListener('scroll', moved)
})
</script>
<template>
  <div
    ref="wrapper"
    class="reading-color-light"
    :data-motion="studio.effectsMode"
    :data-renderer="nativeInkEnabled ? 'gpu' : 'svg'"
    aria-hidden="true"
    :style="{ width: layer.width + 'px', height: layer.height + 'px' }"
  >
    <svg class="color-band-svg" :width="layer.width" :height="layer.height">
      <defs>
        <radialGradient :id="layer.id + '-feather'">
          <stop stop-color="white" stop-opacity=".8" />
          <stop offset=".52" stop-color="white" stop-opacity=".42" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </radialGradient>
        <mask :id="layer.id + '-mask'" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" :fill="`url(#${layer.id}-feather)`" />
        </mask>
      </defs>
      <g
        v-for="band in layer.bands"
        :key="band.key"
        class="reading-color-mark"
        :data-quote="band.ink.mark.quote"
        :data-text-color="band.ink.mark.textColor"
        :data-glow-color="band.ink.mark.glowColor"
        :data-radiance="band.ink.mark.radiance ?? 0"
        :style="{
          opacity: nativeInkEnabled
            ? aiState.intensity
            : `calc(var(--${band.ink.name}-reveal,0) * ${aiState.intensity})`
        }"
      >
        <defs>
          <linearGradient
            :id="band.key + '-spectrum'"
            x1="0"
            y1="0"
            x2="1"
            y2=".65"
            gradientUnits="objectBoundingBox"
          >
            <stop :stop-color="band.ink.palette.cool" />
            <stop offset=".24" :stop-color="band.ink.palette.main" />
            <stop offset=".72" :stop-color="band.ink.palette.main" />
            <stop offset="1" :stop-color="band.ink.palette.warm" />
          </linearGradient>
        </defs>
        <rect
          class="reading-color-mist color-secondary-wake"
          :x="band.x - 8"
          :y="band.y - 3"
          :width="band.width + 16"
          :height="band.height + 10"
          :fill="`url(#${band.key}-spectrum)`"
          :mask="`url(#${layer.id}-mask)`"
        />
        <rect
          class="reading-color-bloom color-primary"
          :x="band.x - 3"
          :y="band.y + band.height * 0.32"
          :width="band.width + 6"
          :height="band.height * 0.8"
          :fill="band.ink.mark.glowColor"
          :mask="`url(#${layer.id}-mask)`"
        />
        <rect
          class="color-opal"
          :x="band.x"
          :y="band.y + band.height * 0.65"
          :width="band.width"
          :height="band.height * 0.2"
          :fill="`url(#${band.key}-spectrum)`"
          :mask="`url(#${layer.id}-mask)`"
        />
      </g>
    </svg>
    <div
      v-for="tile in tiles"
      :key="tile.key"
      class="hdr-band-tile"
      :style="{
        left: tile.x + 'px',
        top: tile.y + 'px',
        width: tile.width + 'px',
        height: tile.height + 'px'
      }"
    >
      <HdrColorTile
        :key="hdrEnabled ? 'hdr' : 'sdr'"
        :tile="tile"
        :motion="motion"
        :hdr="hdrEnabled"
      />
    </div>
  </div>
</template>
<style>
/* The HDR shader is the optical surface. Keep source geometry for native anchoring,
   without also rasterizing the same blurred SVG light under it. */
.reading-color-light[data-renderer='gpu'] .color-band-svg {
  display: none;
}
.reading-color-light[data-renderer='gpu'] .color-band-svg,
.reading-color-light[data-renderer='gpu'] .color-band-svg * {
  animation: none !important;
  transition: none !important;
}
.hdr-band-tile {
  position: absolute;
  pointer-events: none;
}
.reading-color-light {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  z-index: -1;
  user-select: none;
}
.color-band-svg {
  overflow: visible;
  pointer-events: none;
}
.reading-color-mist {
  opacity: 0.38;
  filter: blur(3.8px);
}
.reading-color-bloom {
  opacity: 0.5;
  filter: blur(1.5px);
}
.color-opal {
  opacity: 0.3;
  filter: blur(1.9px);
}
.color-secondary-wake {
  transform: translateY(var(--color-wake, 0px));
}
.reading-color-light[data-motion='full'] .color-opal {
  animation: color-opal-breath 11s ease-in-out infinite alternate;
}
@keyframes color-opal-breath {
  to {
    opacity: 0.13;
    filter: blur(3px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .color-opal {
    animation: none !important;
  }
  .color-secondary-wake {
    transform: none;
  }
}
</style>
