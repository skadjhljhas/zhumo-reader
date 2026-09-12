<script setup lang="ts">
/**
 * 回声星图：阅读停留形成的光场。
 * 没有 DOM 星点、连线或轨道；所有光由片元着色器逐像素求和。展开模式下每处停留上方
 * 叠一个透明的按钮，保留可聚焦、可点选的记录访问。绘制数量是视觉摘要，不裁剪档案。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tidalPlaceKey, type TidalPlace } from '../composables/tidalPlaces'
import { echoState } from '../composables/readingEcho'
import { studio } from '../composables/useStudio'
import { readerState } from '../composables/readerStore'
import { useManuscriptLight } from '../composables/manuscriptLight'
import {
  echoConstellation,
  echoLivePoint,
  packEchoStars,
  type EchoStar
} from '../effects/echo-constellation'
import {
  createEchoField,
  drawEchoFallback,
  type EchoField,
  type EchoFieldFrame
} from '../effects/echo/echo-field'
import { EchoFieldDynamics } from '../effects/echo/echo-dynamics'
import type { EchoTheme } from '../effects/echo/echo-palette'
import { seasonLight } from '../effects/manuscript/season'
import { MotionClock } from '../effects/manuscript/motion-clock'

const props = defineProps<{ places: TidalPlace[]; selected?: string; compact?: boolean }>()
const emit = defineEmits<{ choose: [place: TidalPlace] }>()
// The chart is a bounded visual projection; the archive and its count are never cropped.
const plotted = computed(() => {
  const limit = props.compact ? 64 : 160
  if (props.places.length <= limit) return props.places
  const recent = props.places.slice(-Math.floor(limit / 2))
  const selected = props.places.find((p) => tidalPlaceKey(p) === props.selected)
  const chosen = new Set([...recent, ...(selected ? [selected] : [])])
  const older = props.places.filter((p) => !chosen.has(p))
  const room = limit - chosen.size
  for (let i = 0; i < room; i++) chosen.add(older[Math.floor((i * older.length) / room)])
  return props.places.filter((p) => chosen.has(p))
})
const manuscript = useManuscriptLight()
const theme = computed<EchoTheme>(() => (studio.themeId === 'chaosheng' ? 'chaosheng' : 'lucent'))
const tide = computed(() => theme.value === 'chaosheng')
const volume = computed(() => manuscript.value.profile?.volume ?? 0.4)
const stars = computed<EchoStar[]>(() =>
  echoConstellation(plotted.value, {
    textShare: echoState.textShare,
    reversals: echoState.reversals,
    switches: echoState.switches,
    readingSeconds: echoState.textSeconds + echoState.airSeconds,
    phase: (new Date().getHours() / 24) * Math.PI * 2,
    tide: tide.value,
    volume: volume.value
  })
)
const packed = computed(() => packEchoStars(stars.value))
const selectedIndex = computed(() => stars.value.findIndex((star) => star.key === props.selected))
const hovered = ref(-1)
const host = ref<HTMLElement>()
const canvas = ref<HTMLCanvasElement>()
const still = ref<HTMLCanvasElement>()
const ready = ref('still')
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
const clock = new MotionClock()
const dynamics = new EchoFieldDynamics()
let engine: EchoField | undefined
let engineTheme: EchoTheme | undefined
let failed = false
let frame = 0,
  elapsed = 0,
  width = 0,
  height = 0,
  draws = 0,
  mounted = false

const moving = (): boolean => studio.effectsMode === 'full' && !reduced.matches
function targets(): number[] {
  const s = echoState
  const live = echoLivePoint(readerState.progress, tide.value, volume.value)
  const log = Math.log1p((s.textSeconds + s.airSeconds) / 90)
  return [
    s.textShare,
    Math.tanh(s.switches / 80),
    Math.tanh(s.reversals / 16),
    log / (log + 2.4),
    s.direction,
    s.activity,
    s.returnImpulse,
    s.textShare,
    ...seasonLight(new Date()),
    live.x,
    live.y,
    s.strength,
    Math.min(1, s.revisits / 3)
  ]
}
function frameData(): EchoFieldFrame {
  return {
    width,
    height,
    time: elapsed,
    count: stars.value.length,
    rows: Math.max(1, stars.value.length),
    data: packed.value,
    dynamics: dynamics.values,
    seed: manuscript.value.seed,
    focus: [selectedIndex.value, hovered.value, props.compact ? 1 : 0, volume.value],
    annotation: manuscript.value.profile?.annotation ?? 0,
    scale: Math.min(devicePixelRatio || 1, 2)
  }
}
function drawStill(): void {
  const target = still.value
  const context = target?.getContext('2d')
  if (!target || !context) return
  const scale = Math.min(devicePixelRatio || 1, 2)
  target.width = Math.max(1, Math.round(width * scale))
  target.height = Math.max(1, Math.round(height * scale))
  context.setTransform(scale, 0, 0, scale, 0, 0)
  drawEchoFallback(context, frameData(), theme.value)
}
function draw(now: number): void {
  frame = 0
  if (!mounted || document.hidden || width < 1 || height < 1) return
  const animate = moving()
  elapsed = clock.sample(now, animate)
  dynamics.sample(now, targets(), animate)
  if (engine) engine.draw(frameData())
  else drawStill()
  if (host.value) host.value.dataset.frames = String(++draws)
  if (animate && engine) frame = requestAnimationFrame(draw)
}
function stop(): void {
  cancelAnimationFrame(frame)
  frame = 0
  clock.suspend()
  dynamics.suspend()
}
function schedule(): void {
  if (!frame && mounted) frame = requestAnimationFrame(draw)
}
function releaseEngine(): void {
  engine?.dispose()
  engine = undefined
  engineTheme = undefined
}
function restart(): void {
  stop()
  if (!mounted || document.hidden) return
  if (studio.effectsMode === 'off') {
    // Records stay visible as still light; nothing moves and no GPU loop runs.
    releaseEngine()
    failed = false
    ready.value = 'still'
    schedule()
    return
  }
  if (width < 1 || height < 1) return
  if (engine && engineTheme !== theme.value) releaseEngine()
  if (!engine && !failed && canvas.value) {
    engine = createEchoField(canvas.value, theme.value)
    engineTheme = engine ? theme.value : undefined
    failed = !engine
  }
  ready.value = engine ? 'webgl' : 'still'
  schedule()
}
const observer = new ResizeObserver(() => {
  width = host.value?.clientWidth ?? 0
  height = host.value?.clientHeight ?? 0
  restart()
})
function lose(event: Event): void {
  event.preventDefault()
  stop()
  releaseEngine()
  ready.value = 'still'
  schedule()
}
function restore(): void {
  failed = false
  restart()
}
watch(() => [studio.effectsMode, studio.themeId], restart)
// Outside continuous motion the field is still redrawn whenever its inputs change.
watch(
  () => [
    packed.value,
    selectedIndex.value,
    hovered.value,
    Math.round(echoState.strength * 20),
    Math.round(readerState.progress * 40)
  ],
  () => {
    if (!moving() || !engine) schedule()
  }
)
onMounted(() => {
  mounted = true
  if (host.value) observer.observe(host.value)
  canvas.value?.addEventListener('webglcontextlost', lose)
  canvas.value?.addEventListener('webglcontextrestored', restore)
  reduced.addEventListener('change', restart)
  document.addEventListener('visibilitychange', restart)
  width = host.value?.clientWidth ?? 0
  height = host.value?.clientHeight ?? 0
  restart()
})
onBeforeUnmount(() => {
  mounted = false
  stop()
  observer.disconnect()
  canvas.value?.removeEventListener('webglcontextlost', lose)
  canvas.value?.removeEventListener('webglcontextrestored', restore)
  reduced.removeEventListener('change', restart)
  document.removeEventListener('visibilitychange', restart)
  releaseEngine()
})
</script>
<template>
  <div
    ref="host"
    class="tidal-memory-chart echo-field"
    :class="{ compact }"
    :data-ready="ready"
    :data-count="places.length"
    :data-text-share="echoState.textShare.toFixed(3)"
    :aria-hidden="compact || undefined"
    :role="compact ? undefined : 'group'"
    :aria-label="compact ? undefined : '回声星图'"
  >
    <canvas ref="canvas" class="echo-field-canvas" aria-hidden="true" />
    <canvas ref="still" class="echo-field-still" aria-hidden="true" />
    <template v-if="!compact">
      <button
        v-for="(star, index) in stars"
        :key="star.key"
        class="echo-star"
        :class="{ selected: star.key === selected }"
        :style="{ left: star.x * 100 + '%', top: star.y * 100 + '%' }"
        :aria-label="'预览停留 ' + star.place.address.match.text + ' · ' + star.place.title"
        :aria-pressed="star.key === selected"
        @click="emit('choose', star.place)"
        @pointerenter="hovered = index"
        @pointerleave="hovered = -1"
        @focus="hovered = index"
        @blur="hovered = -1"
      />
    </template>
  </div>
</template>
<style>
.echo-field {
  position: relative;
  overflow: hidden;
  isolation: isolate;
}
.echo-field-canvas,
.echo-field-still {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
.echo-field[data-ready='webgl'] .echo-field-still,
.echo-field:not([data-ready='webgl']) .echo-field-canvas {
  visibility: hidden;
}
/* Hit targets carry no paint of their own; the field brightens the stop they cover. */
.echo-star {
  position: absolute;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.echo-star:focus-visible {
  outline: 0;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent),
    0 0 18px 5px color-mix(in srgb, var(--accent) 28%, transparent);
}
</style>
