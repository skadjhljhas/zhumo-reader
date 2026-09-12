<script setup lang="ts">
/**
 * 静默回声：采集停留，并在正文后面绘制它的光。
 * 采集与记录（finish、Range 定位、3 秒阈值、生命周期）保持原契约；
 * 视觉部分只做两件事：字色的极小偏移（CSS Highlights），以及一层位于背景之上、正文之下的
 * 固定画布，光画在纸面或水面里，字形永不虚化，也没有字形副本。
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { studio } from '../composables/useStudio'
import HdrCanvas from './HdrCanvas.vue'
import { markHdrSourceDirty } from '../effects/hdr'
import { unionHdrDamage, type HdrDamage } from '../effects/hdr-damage'
let paintedBounds: HdrDamage | undefined
function dirtyLight(x: number, y: number, width: number, height: number): void {
  const area = {
    x: x * scale - 2,
    y: y * scale - 2,
    width: width * scale + 4,
    height: height * scale + 4
  }
  paintedBounds = unionHdrDamage(paintedBounds, area)
  markHdrSourceDirty(light.value, area)
}
import { bookState } from '../composables/useBook'
import { documentSession } from '../composables/documentSession'
import { echoEnvelope, ECHO_START_SECONDS } from '../effects/echo-metrics'
import { echoHabits, echoState, echoWordAt, resetEchoHabits } from '../composables/readingEcho'
import {
  activateTidalMemory,
  releaseTidalMemory,
  rememberTidalWord,
  tidalMemory
} from '../composables/tidalMemory'
import { ECHO_INK, echoInk, echoRgb, type EchoTheme } from '../effects/echo/echo-palette'
import { EchoRevisits } from '../effects/echo/echo-dynamics'
import type { ParsedBook } from '../../../shared/types'

interface Contact {
  range: Range
  started: number
  seconds: number
  book: ParsedBook
  source: string
  base: number[]
  key: string
  revisits: number
}
interface Remnant {
  range: Range
  strength: number
  tint: number
  started: number
  base: number[]
  revisits: number
}
const light = ref<HTMLCanvasElement>()
let context: CanvasRenderingContext2D | null = null
const revisits = new EchoRevisits()
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
let active: Contact | undefined,
  remnant: Remnant | undefined,
  frame = 0,
  last = 0,
  x = 0,
  y = 0,
  inside = false,
  pressing = false,
  painted = false,
  scale = 1
const scrollPositions = new WeakMap<Element, number>()
const colorCanvas = document.createElement('canvas')
colorCanvas.width = colorCanvas.height = 1
const colorContext = colorCanvas.getContext('2d')!
function baseColor(range: Range): number[] {
  colorContext.clearRect(0, 0, 1, 1)
  colorContext.fillStyle = getComputedStyle(range.startContainer.parentElement!).color
  colorContext.fillRect(0, 0, 1, 1)
  return [...colorContext.getImageData(0, 0, 1, 1).data].slice(0, 3)
}
function equal(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endOffset === b.endOffset
  )
}
/** A session-local identity for "the same word here"; never stored, never an address. */
function wordKey(range: Range): string {
  const parent = range.startContainer.parentElement
  const block = parent?.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption')
  const owner = parent?.closest<HTMLElement>('[data-section-id],.note-card')
  return [
    range.toString(),
    owner?.dataset.sectionId ?? owner?.dataset.noteId ?? '',
    (block?.textContent ?? '').slice(0, 48)
  ].join('||')
}
function finish(): void {
  if (active) {
    if (active.seconds >= ECHO_START_SECONDS) {
      rememberTidalWord(active.range, active.book, active.source, {
        dwellMs: active.seconds * 1000,
        peakMs: active.seconds * 1000,
        textShare: echoState.textShare,
        switches: echoState.switches,
        reversals: echoState.reversals
      })
      remnant = {
        range: active.range.cloneRange(),
        strength: echoEnvelope(active.seconds),
        tint: echoEnvelope(active.seconds),
        started: performance.now(),
        base: active.base,
        revisits: revisits.mark(active.key)
      }
    }
    active = undefined
  }
  echoState.text = ''
  echoState.seconds = 0
  echoState.strength = 0
  echoState.revisits = 0
  CSS.highlights?.delete('reading-echo-current')
}
function clearCanvas(): void {
  if (context && painted) {
    context.clearRect(0, 0, innerWidth, innerHeight)
    painted = false
    markHdrSourceDirty(light.value, paintedBounds)
    paintedBounds = undefined
  }
}
function clearLight(): void {
  remnant = undefined
  clearCanvas()
  CSS.highlights?.delete('reading-echo-current')
  CSS.highlights?.delete('reading-echo-after')
}
function move(event: PointerEvent): void {
  x = event.clientX
  y = event.clientY
  inside = event.pointerType === 'mouse'
}
function down(): void {
  pressing = true
  finish()
  clearLight()
}
function up(): void {
  pressing = false
}
function leave(): void {
  inside = false
  finish()
  echoHabits.suspend()
}
function scroll(event: Event): void {
  const root = event.target
  if (!(root instanceof HTMLElement) || !root.matches('.reader-scroll')) return
  const previous = scrollPositions.get(root)
  scrollPositions.set(root, root.scrollTop)
  if (previous !== undefined) echoHabits.scroll(root.scrollTop - previous, root.clientHeight)
  finish()
  clearLight()
}
function resize(): void {
  const target = light.value
  if (!target) return
  scale = Math.min(devicePixelRatio || 1, 2)
  target.width = Math.max(1, Math.round(innerWidth * scale))
  target.height = Math.max(1, Math.round(innerHeight * scale))
  context = target.getContext('2d')
  context?.setTransform(scale, 0, 0, scale, 0, 0)
  painted = false
  paintedBounds = undefined
  markHdrSourceDirty(target)
}

// ---- light ---------------------------------------------------------------------------------
const TIDE = { moon: [214, 232, 255], sun: [255, 226, 176] }
const hash = (k: number): number => {
  const s = Math.sin(k * 12.9898) * 43758.5453
  return s - Math.floor(s)
}
const mix = (a: number[], b: number[], t: number): number[] =>
  a.map((n, i) => Math.round(n + (b[i] - n) * t))
/** A soft radial light; every visible shape here is a gradient, never an outline. */
function glow(cx: number, cy: number, rx: number, ry: number, rgb: number[], alpha: number): void {
  if (!context || alpha <= 0.002 || rx <= 0 || ry <= 0) return
  context.save()
  context.translate(cx, cy)
  context.scale(rx, ry)
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1)
  gradient.addColorStop(0, echoRgb(rgb, alpha))
  gradient.addColorStop(0.55, echoRgb(rgb, alpha * 0.42))
  gradient.addColorStop(1, echoRgb(rgb, 0))
  context.fillStyle = gradient
  context.beginPath()
  context.arc(0, 0, 1, 0, Math.PI * 2)
  context.fill()
  context.restore()
  painted = true
  dirtyLight(cx - rx, cy - ry, rx * 2, ry * 2)
}
/** 潮光：词的基线以下是水。倒影主体、随浪漂移的碎光、和一层很宽的光晕。 */
function drawTide(
  rect: DOMRect,
  s: number,
  tint: number,
  age: number,
  times: number,
  t: number
): void {
  const cx = rect.left + rect.width / 2
  const spread = 1 + age * 0.25
  const base = rect.bottom + 5 + age * 3
  const rgb = mix(TIDE.moon, TIDE.sun, tint)
  glow(
    cx,
    rect.top + rect.height * 0.6,
    rect.width * 0.8 * spread + 40,
    rect.height * 1.5 + 12,
    rgb,
    0.07 * s
  )
  glow(cx, base + 7, rect.width * 0.55 * spread + 14, 9 + 5 * s, rgb, 0.22 * s)
  const streaks = 5 + Math.round(3 * s) + Math.min(3, times)
  for (let k = 0; k < streaks; k++) {
    const u = hash(k + 1)
    const sx = cx + (u - 0.5) * rect.width * 1.1 * spread + 6 * Math.sin(t * 0.35 + k * 1.3)
    const sy = base + 3 + hash(k + 7) * 14 * s
    const h = (6 + 10 * s) * (0.55 + 0.45 * Math.sin(t * 0.9 + k * 1.7))
    const a = 0.35 * s * (0.5 + 0.5 * Math.sin(t * 0.7 + k * 2.3))
    glow(sx, sy + h * 0.5, 1.6, h, rgb, a)
  }
}
/** 琉璃：词的后面是一片被画外光聚焦的纸面。中心向白，边缘紫青色散，一道折射前沿缓缓横过。 */
function drawLucent(
  rect: DOMRect,
  s: number,
  tint: number,
  age: number,
  times: number,
  t: number
): void {
  if (!context) return
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height * 0.55 + age * 3
  const spread = 1 + age * 0.25
  const rx = rect.width * 0.6 * spread + 36,
    ry = rect.height * 1.1 + 14
  const disp = 1 + 0.35 * Math.min(3, times)
  glow(cx - 5, cy - 4, rx * 1.05, ry * 1.05, [150, 130, 210], 0.1 * s * disp)
  glow(cx + 5, cy + 4, rx * 1.05, ry * 1.05, [120, 200, 205], 0.09 * s * disp)
  glow(cx, cy, rx, ry, mix([255, 255, 255], [255, 244, 224], tint), 0.38 * s)
  // A refraction front: light through glass, walking across the paper every few seconds.
  const phase = (t * 0.16 + hash(Math.round(rect.top))) % 1
  const fx = cx - rx + phase * 2 * rx
  context.save()
  context.beginPath()
  context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  context.clip()
  context.translate(fx, cy)
  context.rotate(-0.21)
  const gradient = context.createLinearGradient(-16, 0, 16, 0)
  gradient.addColorStop(0, echoRgb([255, 255, 255], 0))
  gradient.addColorStop(0.5, echoRgb([255, 255, 255], 0.2 * s))
  gradient.addColorStop(1, echoRgb([255, 255, 255], 0))
  context.fillStyle = gradient
  context.fillRect(-16, -ry * 1.6, 32, ry * 3.2)
  context.restore()
  painted = true
  dirtyLight(cx - rx, cy - ry, rx * 2, ry * 2)
}
function paint(
  range: Range,
  strength: number,
  tint: number,
  base: number[],
  slot: 'current' | 'after',
  t: number,
  times: number,
  age = 0
): void {
  if (
    !range.startContainer.isConnected ||
    strength < 0.001 ||
    studio.effectsMode === 'off' ||
    typeof Highlight === 'undefined'
  ) {
    CSS.highlights?.delete('reading-echo-' + slot)
    return
  }
  const theme: EchoTheme = studio.themeId === 'chaosheng' ? 'chaosheng' : 'lucent'
  const root = document.documentElement.style
  root.setProperty(
    '--echo-' + slot + '-ink',
    `rgb(${echoInk(theme, base, strength, tint).join(',')})`
  )
  root.setProperty(
    '--echo-' + slot + '-shadow',
    theme === 'chaosheng'
      ? `0 0 5px ${echoRgb(ECHO_INK.chaosheng.sun, 0.3 * strength)}`
      : `-0.3px 0 rgba(196,150,230,${(0.32 * strength).toFixed(3)}), 0.3px 0 rgba(96,190,180,${(0.3 * strength).toFixed(3)})`
  )
  CSS.highlights.set('reading-echo-' + slot, new Highlight(range))
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0 || rect.top < 60 || rect.bottom > innerHeight - 30)
      continue
    if (theme === 'chaosheng') drawTide(rect, strength, tint, age, times, t)
    else drawLucent(rect, strength, tint, age, times, t)
  }
}
function tick(now: number): void {
  frame = 0
  if (document.hidden || bookState.status !== 'reading' || documentSession.mode !== 'read') {
    finish()
    clearLight()
    echoHabits.suspend()
    return
  }
  frame = requestAnimationFrame(tick)
  if (now - last >= 70) {
    last = now
    const reader = document.querySelector('.reader-scroll')
    if (reader && !scrollPositions.has(reader)) scrollPositions.set(reader, reader.scrollTop)
    const blocked =
      pressing ||
      Boolean(window.getSelection()?.toString()) ||
      Boolean(document.querySelector('dialog[open],.settings-panel'))
    const point = inside && !blocked ? document.elementFromPoint(x, y) : null
    const candidate = point ? echoWordAt(x, y) : undefined
    const region = candidate
      ? 'text'
      : point?.closest('.reader-scroll,.notes-scroll') &&
          !point.closest(
            'button,a,input,textarea,select,code,pre,.zmu-ref,.zmu-math,img,svg,[contenteditable="true"]'
          )
        ? 'air'
        : 'outside'
    Object.assign(echoState, echoHabits.sample(now, region), { onText: region === 'text' })
    if (blocked || !tidalMemory.enabled) {
      finish()
      clearLight()
      return
    }
    if (!candidate) finish()
    else if (!active || !equal(active.range, candidate)) {
      finish()
      if (bookState.book) {
        const key = wordKey(candidate)
        active = {
          range: candidate,
          started: now,
          seconds: 0,
          book: bookState.book,
          source: documentSession.source,
          base: baseColor(candidate),
          key,
          revisits: revisits.count(key)
        }
        echoState.revisits = active.revisits
      }
    }
  }
  const animate = studio.effectsMode === 'full' && !reduced.matches
  const t = animate ? now / 1000 : 0
  clearCanvas()
  if (active) {
    active.seconds = (now - active.started) / 1000
    const strength = echoEnvelope(active.seconds)
    Object.assign(echoState, { text: active.range.toString(), seconds: active.seconds, strength })
    paint(active.range, strength, strength, active.base, 'current', t, active.revisits)
  }
  if (remnant) {
    // Reverberation: the longer a word has been returned to, the longer its light stays.
    const times = Math.min(3, remnant.revisits)
    const age = (now - remnant.started) / 1000,
      tau = 2.6 + 0.8 * times,
      decay = Math.exp(-age / tau)
    if (age > 9 + 2 * times) {
      remnant = undefined
      CSS.highlights?.delete('reading-echo-after')
    } else
      paint(
        remnant.range,
        remnant.strength * decay,
        remnant.tint,
        remnant.base,
        'after',
        t,
        remnant.revisits,
        Math.min(1, age / 6)
      )
  }
  if (light.value) {
    light.value.dataset.seconds = echoState.seconds.toFixed(2)
    light.value.dataset.strength = echoState.strength.toFixed(4)
  }
}
function restart(): void {
  cancelAnimationFrame(frame)
  last = 0
  finish()
  clearLight()
  echoHabits.suspend()
  if (!document.hidden && bookState.status === 'reading' && documentSession.mode === 'read')
    frame = requestAnimationFrame(tick)
}
let priorPath = '',
  priorSource = ''
function activate(): void {
  finish()
  clearLight()
  if (documentSession.path !== priorPath || documentSession.source !== priorSource) {
    resetEchoHabits()
    revisits.reset()
    priorPath = documentSession.path
    priorSource = documentSession.source
  }
  if (bookState.status === 'reading' && documentSession.mode === 'read')
    void activateTidalMemory(bookState.book, documentSession.path, documentSession.source)
  else releaseTidalMemory()
  restart()
}
watch(
  () => [
    bookState.book,
    bookState.status,
    documentSession.mode,
    documentSession.path,
    documentSession.source
  ],
  activate
)
watch(() => [studio.themeId, studio.effectsMode], restart)
watch(
  () => tidalMemory.enabled,
  () => {
    if (!tidalMemory.enabled) {
      finish()
      clearLight()
    }
  }
)
onMounted(() => {
  resize()
  activate()
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', move, { passive: true })
  window.addEventListener('pointerdown', down, { passive: true })
  window.addEventListener('pointerup', up, { passive: true })
  window.addEventListener('blur', leave)
  document.addEventListener('mouseleave', leave)
  document.addEventListener('scroll', scroll, true)
  document.addEventListener('visibilitychange', restart)
})
onBeforeUnmount(() => {
  finish()
  clearLight()
  cancelAnimationFrame(frame)
  releaseTidalMemory()
  window.removeEventListener('resize', resize)
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerdown', down)
  window.removeEventListener('pointerup', up)
  window.removeEventListener('blur', leave)
  document.removeEventListener('mouseleave', leave)
  document.removeEventListener('scroll', scroll, true)
  document.removeEventListener('visibilitychange', restart)
})
</script>
<template>
  <div class="reading-echo-hdr" aria-hidden="true"><HdrCanvas :source="light" /></div>
  <canvas
    ref="light"
    class="reading-echo-light"
    aria-hidden="true"
    :data-seconds="echoState.seconds.toFixed(2)"
    :data-strength="echoState.strength.toFixed(4)"
  />
</template>
<style>
::highlight(reading-echo-current) {
  color: var(--echo-current-ink);
  text-shadow: var(--echo-current-shadow, none);
}
::highlight(reading-echo-after) {
  color: var(--echo-after-ink);
  text-shadow: var(--echo-after-shadow, none);
}
/* Behind the text, above the theme background: the paper or the water carries the light. */
.reading-echo-light {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
.reading-echo-hdr {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
</style>
