<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, watch, useId } from 'vue'
import type { SyntaxAnalysis } from '../../../shared/ai-types'
import { readingColorSegments, type ReadingColorMark } from '../../../shared/reading-colors'
import {
  resolveSyntaxAnchors,
  syntaxSpanRanges,
  syntaxAtomicElement,
  type SyntaxAnchor
} from '../effects/syntax-ranges'
import { readingAppearance } from '../effects/reading-appearance'
import { readingPalette, retainColorHost, releaseColorHost } from '../effects/reading-palette'
import type { ColorInk, ColorLayer } from '../effects/color-band'
import { removeDetachedColorCopies } from '../effects/reading-palette'
import ColorBandSurface from './ColorBandSurface.vue'
import GoldenInkSurface from './GoldenInkSurface.vue'
import { bookState } from '../composables/useBook'
import { studio } from '../composables/useStudio'
import { aiState } from '../composables/aiReading'
import { nativeInkEnabled } from '../effects/hdr'
import { setRadianceSources } from '../effects/radiance-sources'
const props = defineProps<{
  sources: Array<{ key: string; analysis: SyntaxAnalysis; anchors: SyntaxAnchor[] }>
  enabled: boolean
}>()
const emit = defineEmits<{ rendered: [count: number] }>()
const layers = shallowRef<ColorLayer[]>([])
const prefix = 'zhumo-reading-color-' + useId().replace(/[^\w-]/g, '')
const inks = new Map<string, ColorInk>(),
  hosts = new Map<HTMLElement, string>()
const activeFades = new Set<ColorInk>()
const inkScopes = new Map<ColorInk, Set<HTMLElement>>()
const inkValues = new WeakMap<ColorInk, { color: string; reveal: string }>()
const highlights = new Map<ColorInk, Range[]>()
const rules = new Map<ColorInk, { rule: CSSStyleRule; selector: string; body: string }>()
const radianceOwner = {}
let serial = 0,
  frame = 0,
  fading = 0,
  selecting = false
let stylesheet: HTMLStyleElement | undefined,
  observer: MutationObserver | undefined,
  resize: ResizeObserver | undefined
const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const identity = (source: string, mark: ReadingColorMark): string =>
  source +
  '\0' +
  mark.id +
  '\0' +
  mark.start +
  ':' +
  mark.end +
  '\0' +
  mark.textColor +
  mark.glowColor +
  '\0' +
  (mark.radiance ?? 0)
function fade(): void {
  fading = 0
  let more = false
  for (const ink of activeFades) {
    const t = Math.min(1, (performance.now() - ink.born) / 2600),
      eased = t * t * (3 - 2 * t)
    const from = rgb(ink.base),
      to = rgb(ink.mark.textColor)
    const value = {
      color: 'rgb(' + from.map((v, i) => Math.round(v + (to[i] - v) * eased)).join(',') + ')',
      reveal: String(eased)
    }
    const previous = inkValues.get(ink)
    for (const host of inkScopes.get(ink) ?? []) {
      if (previous?.color !== value.color)
        host.style.setProperty('--' + ink.name + '-ink', value.color)
      if (!nativeInkEnabled.value && previous?.reveal !== value.reveal)
        host.style.setProperty('--' + ink.name + '-reveal', value.reveal)
    }
    inkValues.set(ink, value)
    more ||= t < 1
    if (t >= 1) activeFades.delete(ink)
  }
  if (more && !document.hidden) fading = requestAnimationFrame(fade)
}
function clean(ink: ColorInk): void {
  activeFades.delete(ink)
  CSS.highlights?.delete(ink.name)
  highlights.delete(ink)
  document.documentElement.style.removeProperty('--' + ink.name + '-ink')
  document.documentElement.style.removeProperty('--' + ink.name + '-reveal')
  for (const host of inkScopes.get(ink) ?? []) {
    host.style.removeProperty('--' + ink.name + '-ink')
    host.style.removeProperty('--' + ink.name + '-reveal')
  }
  inkScopes.delete(ink)
}
function measure(): void {
  frame = 0
  const grouped = new Map<HTMLElement, ColorLayer>(),
    live = new Set<string>(),
    scopes = new Map<ColorInk, Set<HTMLElement>>()
  const geometry = new Map<HTMLElement, { origin: DOMRect; sx: number; sy: number }>()
  const addedHosts: HTMLElement[] = []
  for (const ink of inks.values()) ink.ranges = []
  if (props.enabled && !selecting && typeof Highlight !== 'undefined')
    for (const source of props.sources) {
      const slices = resolveSyntaxAnchors(source.anchors, bookState.book?.notes ?? [])
      for (const part of readingColorSegments(source.analysis.marks ?? [])) {
        const key = identity(source.key, part.mark)
        for (const range of syntaxSpanRanges(slices, {
          start: part.start,
          end: part.end
        } as never)) {
          const atom = syntaxAtomicElement(range),
            element = atom ?? range.startContainer.parentElement
          if (!element?.closest('.reader-scroll,.notes-scroll')) continue
          const host =
            element.closest<HTMLElement>('p,li,td,th,h1,h2,h3,h4,h5,h6,pre,.zmu-math-block') ??
            element.closest<HTMLElement>('.section-body,.zmu-note-body')
          if (!host) continue
          if (!hosts.has(host)) {
            hosts.set(host, prefix + '-host-' + serial++)
            addedHosts.push(host)
          }
          // Local coordinates inherit compositor scrolling and note-card movement.
          let measured = geometry.get(host)
          if (!measured) {
            const origin = host.getBoundingClientRect()
            measured = {
              origin,
              sx: origin.width / (host.offsetWidth || origin.width),
              sy: origin.height / (host.offsetHeight || origin.height)
            }
            geometry.set(host, measured)
          }
          const { origin, sx, sy } = measured
          if (!origin.width || !origin.height) continue
          const rects = (
            atom ? [atom.getBoundingClientRect()] : [...range.getClientRects()]
          ).filter((r) => r.width > 0 && r.height > 0)
          if (!rects.length) continue
          let ink = inks.get(key)
          if (!ink) {
            ink = {
              name: prefix + '-' + serial++,
              mark: part.mark,
              born: performance.now(),
              ranges: [],
              base: readingAppearance().textColor,
              palette: readingPalette(part.mark.glowColor)
            }
            inks.set(key, ink)
            activeFades.add(ink)
          }
          if (!atom) ink.ranges.push(range)
          if (!scopes.has(ink)) scopes.set(ink, new Set())
          scopes.get(ink)!.add(host)
          live.add(key)
          let layer = grouped.get(host)
          if (!layer) {
            layer = {
              id: hosts.get(host)!,
              host,
              width: host.clientWidth,
              height: host.clientHeight,
              bands: []
            }
            grouped.set(host, layer)
          }
          for (const r of rects)
            layer.bands.push({
              key: ink.name + '-' + layer.bands.length,
              ink,
              x: (r.x - origin.x) / sx - host.clientLeft + host.scrollLeft,
              y: (r.y - origin.y) / sy - host.clientTop + host.scrollTop,
              width: r.width / sx,
              height: r.height / sy
            })
        }
      }
    }
  const retained = new Set(
    props.sources.flatMap((s) => (s.analysis.marks ?? []).map((m) => identity(s.key, m)))
  )
  // Finish geometry reads before changing styles, avoiding forced style/layout work per mark.
  for (const host of addedHosts) {
    removeDetachedColorCopies(host)
    retainColorHost(host)
    host.classList.add(hosts.get(host)!)
    resize?.observe(host)
  }
  for (const [ink, old] of inkScopes) {
    for (const host of old)
      if (!scopes.get(ink)?.has(host)) {
        host.style.removeProperty('--' + ink.name + '-ink')
        host.style.removeProperty('--' + ink.name + '-reveal')
      }
    if (!scopes.has(ink)) inkScopes.delete(ink)
  }
  for (const [ink, next] of scopes) {
    const value = inkValues.get(ink)
    for (const host of next)
      if (!inkScopes.get(ink)?.has(host) && value) {
        host.style.setProperty('--' + ink.name + '-ink', value.color)
        host.style.setProperty('--' + ink.name + '-reveal', value.reveal)
      }
    inkScopes.set(ink, next)
  }
  for (const [key, ink] of inks) {
    if (!retained.has(key)) {
      clean(ink)
      inks.delete(key)
    } else if (live.has(key) && ink.ranges.length) {
      const previous = highlights.get(ink)
      if (
        !previous ||
        previous.length !== ink.ranges.length ||
        previous.some((range, i) => {
          const next = ink.ranges[i]
          return (
            range.startContainer !== next.startContainer ||
            range.startOffset !== next.startOffset ||
            range.endContainer !== next.endContainer ||
            range.endOffset !== next.endOffset
          )
        })
      ) {
        const highlight = new Highlight(...ink.ranges)
        highlight.priority = 2
        CSS.highlights.set(ink.name, highlight)
        highlights.set(ink, ink.ranges)
      }
    } else if (highlights.has(ink)) {
      CSS.highlights.delete(ink.name)
      highlights.delete(ink)
    }
  }
  const sheet = stylesheet?.sheet
  if (sheet) {
    // Streaming one new colour must not tear down and reparse every existing rule.
    for (const [ink, previous] of rules) {
      if (scopes.has(ink) && ink.ranges.length) continue
      const index = [...sheet.cssRules].indexOf(previous.rule)
      if (index >= 0) sheet.deleteRule(index)
      rules.delete(ink)
    }
    for (const [ink, scope] of scopes) {
      if (!ink.ranges.length) continue
      const selector = [...scope]
        .map((host) => '.' + hosts.get(host) + '::highlight(' + ink.name + ')')
        .join(',')
      const glow = rgb(ink.mark.glowColor).join(',')
      const body =
        `color: var(--${ink.name}-ink); -webkit-text-fill-color: var(--${ink.name}-ink);` +
        (nativeInkEnabled.value
          ? ''
          : `background-color: rgba(${glow},calc(var(--${ink.name}-reveal,0) * ${0.11 * aiState.intensity}));` +
            `text-shadow: 0 0 3px rgba(${glow},calc(var(--${ink.name}-reveal,0) * .23));`)
      const previous = rules.get(ink)
      if (previous) {
        if (previous.selector !== selector) previous.rule.selectorText = selector
        if (previous.body !== body) previous.rule.style.cssText = body
        previous.selector = selector
        previous.body = body
      } else {
        const index = sheet.insertRule(`${selector} { ${body} }`, sheet.cssRules.length)
        rules.set(ink, { rule: sheet.cssRules[index] as CSSStyleRule, selector, body })
      }
    }
  }
  for (const host of hosts.keys())
    if (!grouped.has(host)) {
      resize?.unobserve(host)
      host.classList.remove(hosts.get(host)!)
      releaseColorHost(host)
      hosts.delete(host)
    }
  const previous = new Map(layers.value.map((layer) => [layer.host, layer]))
  layers.value = [...grouped.values()].map((next) => {
    const old = previous.get(next.host)
    return old &&
      old.width === next.width &&
      old.height === next.height &&
      old.bands.length === next.bands.length &&
      old.bands.every((band, index) => {
        const other = next.bands[index]
        return (
          band.key === other.key &&
          band.ink === other.ink &&
          Math.abs(band.x - other.x) < 0.01 &&
          Math.abs(band.y - other.y) < 0.01 &&
          Math.abs(band.width - other.width) < 0.01 &&
          Math.abs(band.height - other.height) < 0.01
        )
      })
      ? old
      : next
  })
  emit('rendered', live.size)
  setRadianceSources(radianceOwner, layers.value)
  cancelAnimationFrame(fading)
  fade()
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure)
}
function down(event: PointerEvent): void {
  if (
    event.button === 0 &&
    event.target instanceof Element &&
    event.target.closest('.reader-scroll,.notes-scroll')
  ) {
    selecting = true
    schedule()
  }
}
function up(): void {
  selecting = false
  schedule()
}
watch(
  () => [props.sources, props.enabled, studio.themeId, studio.effectsMode, aiState.intensity],
  schedule,
  { deep: true }
)
watch(nativeInkEnabled, () => {
  // The GPU owns optical opacity in HDR. Restore the CSS values on an SDR switch.
  for (const ink of inks.values()) {
    activeFades.add(ink)
    inkValues.delete(ink)
  }
  schedule()
})
onMounted(() => {
  stylesheet = document.createElement('style')
  stylesheet.dataset.readingColors = prefix
  document.head.append(stylesheet)
  observer = new MutationObserver((records) => {
    if (
      records.some((r) => {
        const element = r.target instanceof Element ? r.target : r.target.parentElement
        if (element?.closest('.reading-color-light,.syntax-light-layer,.golden-ink-surface'))
          return false
        if (element?.closest('.reader-scroll,.notes-scroll')) return true
        return [...r.addedNodes, ...r.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches('.reader-scroll,.notes-scroll') ||
              node.querySelector('.reader-scroll,.notes-scroll'))
        )
      })
    )
      schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  resize = new ResizeObserver(schedule)
  resize.observe(document.documentElement)
  // These layers already inherit compositor scrolling and card transforms. Virtualized
  // content changes are observed above; scrolling itself does not change local geometry.
  document.fonts.addEventListener('loadingdone', schedule)
  window.addEventListener('zhumo-fonts-changed', schedule)
  window.addEventListener('resize', schedule)
  document.addEventListener('pointerdown', down)
  document.addEventListener('pointerup', up)
  window.addEventListener('blur', up)
  document.addEventListener('visibilitychange', schedule)
  schedule()
})
onBeforeUnmount(() => {
  setRadianceSources(radianceOwner, [])
  cancelAnimationFrame(frame)
  cancelAnimationFrame(fading)
  observer?.disconnect()
  resize?.disconnect()
  stylesheet?.remove()
  rules.clear()
  for (const ink of inks.values()) clean(ink)
  for (const [host, name] of hosts) {
    host.classList.remove(name)
    releaseColorHost(host)
  }
  document.fonts.removeEventListener('loadingdone', schedule)
  window.removeEventListener('zhumo-fonts-changed', schedule)
  window.removeEventListener('resize', schedule)
  document.removeEventListener('pointerdown', down)
  document.removeEventListener('pointerup', up)
  window.removeEventListener('blur', up)
  document.removeEventListener('visibilitychange', schedule)
})
</script>
<template>
  <Teleport v-for="layer in layers" :key="layer.id" :to="layer.host">
    <ColorBandSurface :layer="layer" />
    <template v-for="band in layer.bands" :key="band.key">
      <GoldenInkSurface
        v-if="(band.ink.mark.radiance ?? 0) > 0 && studio.effectsMode !== 'off'"
        :layer="layer"
        :band="band"
      />
    </template>
  </Teleport>
</template>
<style>
.reading-color-anchor {
  position: relative;
  isolation: isolate;
}
</style>
