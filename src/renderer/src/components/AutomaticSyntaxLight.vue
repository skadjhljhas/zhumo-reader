<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  automaticSyntax,
  mountAutomaticSyntax,
  syntaxEntryContains,
  type AutomaticSyntaxEntry
} from '../composables/automaticSyntax'
import { aiSelection, aiState } from '../composables/aiReading'
import { documentSession } from '../composables/documentSession'
import { settings, uiState } from '../composables/useSettings'
import { studio } from '../composables/useStudio'
import { bookState } from '../composables/useBook'
import { syntaxProjection } from '../../../shared/syntax-view'
import { resolveSyntaxAnchors } from '../effects/syntax-ranges'
import { syntaxLightBands } from '../effects/syntax-light-geometry'
import { syntaxOpticalPlan, type SyntaxOpticalPlan } from '../effects/syntax-optics'
import SyntaxMeaningField from './SyntaxMeaningField.vue'
import { SyntaxRouteLanes } from '../effects/syntax-route-lanes'
import ReadingColorLight from './ReadingColorLight.vue'
import DocumentAnnotationLight from './DocumentAnnotationLight.vue'
interface Scene {
  entry: AutomaticSyntaxEntry
  plan: SyntaxOpticalPlan
  clip?: { x: number; y: number; width: number; height: number }
}
const scenes = ref<Scene[]>([]),
  dragging = ref(false)
const routeLanes = new Map<string, SyntaxRouteLanes>()
const colorSources = shallowRef<
  Array<{
    key: string
    analysis: NonNullable<AutomaticSyntaxEntry['analysis']>
    anchors: AutomaticSyntaxEntry['anchors']
  }>
>([])
let legacyCount = 0,
  colorCount = 0
function colorsRendered(count: number): void {
  colorCount = count
  automaticSyntax.renderedCount = legacyCount + colorCount
}
let frame = 0,
  off: (() => void) | undefined,
  observer: MutationObserver | undefined,
  resize: ResizeObserver | undefined
function measure(): void {
  frame = 0
  if (
    settings.annotationMode === 'document' ||
    !settings.automaticSyntax ||
    !aiState.lightsOn ||
    studio.effectsMode === 'off' ||
    documentSession.mode !== 'read'
  ) {
    scenes.value = []
    colorSources.value = []
    legacyCount = 0
    automaticSyntax.renderedCount = 0
    return
  }
  const result: Scene[] = []
  const colors: typeof colorSources.value = []
  const live = new Set(automaticSyntax.entries.map((entry) => entry.key))
  for (const key of routeLanes.keys()) if (!live.has(key)) routeLanes.delete(key)
  for (const entry of automaticSyntax.entries) {
    if (
      !entry.analysis ||
      automaticSyntax.entries.some(
        (other) =>
          (other.analysis?.spans.length || other.analysis?.marks?.length) &&
          syntaxEntryContains(other, entry)
      ) ||
      (aiState.runs.syntax.analysis && !aiState.stale && aiSelection.value?.quote === entry.quote)
    )
      continue
    if (entry.analysis.version === 4) {
      colors.push({ key: entry.key, analysis: entry.analysis, anchors: entry.anchors })
      continue
    }
    const projection = syntaxProjection(entry.analysis, entry.reading)
    const slices = resolveSyntaxAnchors(entry.anchors, bookState.book?.notes ?? [])
    if (!slices.length) continue
    const bands = syntaxLightBands(slices, projection.units)
    if (!bands.length) continue
    const bounds = slices[0].node.parentElement
      ?.closest('.reader-scroll,.notes-scroll')
      ?.getBoundingClientRect()
    const all = syntaxLightBands(slices, [
      { id: 'extent', index: -1, span: { start: 0, end: entry.quote.length } as never }
    ])
    const right = Math.min(
      (bounds?.right ?? innerWidth) - 26,
      Math.max(...all.map((b) => b.x + b.width))
    )
    let lanes = routeLanes.get(entry.key)
    if (!lanes) routeLanes.set(entry.key, (lanes = new SyntaxRouteLanes()))
    result.push({
      entry,
      plan: syntaxOpticalPlan(entry.analysis, bands, entry.reading, '', right, lanes),
      clip: bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : undefined
    })
  }
  scenes.value = result
  if (
    colors.length !== colorSources.value.length ||
    colors.some((color, i) => {
      const previous = colorSources.value[i]
      return (
        color.key !== previous.key ||
        color.analysis !== previous.analysis ||
        color.anchors !== previous.anchors
      )
    })
  )
    colorSources.value = colors
  legacyCount = result.reduce(
    (n, s) => n + s.plan.marks.length + (s.plan.scopeFields?.representedRelationIds.length ?? 0),
    0
  )
  automaticSyntax.renderedCount = legacyCount + colorCount
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure)
}
function scrolled(): void {
  // Colour layers live inside their paragraphs and already follow native scrolling.
  if (automaticSyntax.entries.some((entry) => entry.analysis && entry.analysis.version !== 4))
    schedule()
}
function layoutFinished(event: Event): void {
  if (event.target instanceof Element && event.target.closest('.syntax-light-layer')) return
  schedule()
}
function down(event: PointerEvent): void {
  if (event.button === 0) {
    dragging.value = true
  }
}
function up(): void {
  dragging.value = false
  schedule()
}
watch(
  () => [
    automaticSyntax.version,
    settings.annotationMode,
    settings.automaticSyntax,
    settings.fontSize,
    settings.lineHeight,
    settings.contentWidth,
    settings.paragraphStyle,
    aiState.lightsOn,
    aiState.runs.syntax.analysis,
    documentSession.mode,
    uiState.tocOpen,
    uiState.settingsOpen,
    studio.themeId,
    studio.noteWidth,
    studio.noteFontSize,
    studio.effectsMode
  ],
  schedule
)
onMounted(() => {
  off = mountAutomaticSyntax()
  observer = new MutationObserver((records) => {
    // Overlay removal happens outside app-main after its leave animation. Observing only
    // the reader can leave cached light empty forever; ignore our own SVG updates.
    if (
      records.some(
        (record) =>
          !(
            record.target instanceof Element &&
            record.target.closest('.syntax-light-layer,.reading-color-light')
          )
      )
    )
      schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  resize = new ResizeObserver(schedule)
  resize.observe(document.documentElement)
  document.addEventListener('scroll', scrolled, true)
  document.addEventListener('transitionend', layoutFinished, true)
  document.addEventListener('animationend', layoutFinished, true)
  document.fonts.addEventListener('loadingdone', schedule)
  window.addEventListener('resize', schedule)
  document.addEventListener('pointerdown', down)
  document.addEventListener('pointerup', up)
  window.addEventListener('blur', up)
})
onBeforeUnmount(() => {
  off?.()
  observer?.disconnect()
  resize?.disconnect()
  cancelAnimationFrame(frame)
  document.removeEventListener('scroll', scrolled, true)
  document.removeEventListener('transitionend', layoutFinished, true)
  document.removeEventListener('animationend', layoutFinished, true)
  document.fonts.removeEventListener('loadingdone', schedule)
  window.removeEventListener('resize', schedule)
  document.removeEventListener('pointerdown', down)
  document.removeEventListener('pointerup', up)
  window.removeEventListener('blur', up)
})
</script>
<template>
  <DocumentAnnotationLight />
  <ReadingColorLight
    :sources="colorSources"
    :enabled="
      settings.annotationMode === 'follow' &&
      settings.automaticSyntax &&
      aiState.lightsOn &&
      studio.effectsMode !== 'off' &&
      documentSession.mode === 'read'
    "
    @rendered="colorsRendered"
  />
  <svg
    v-if="scenes.length"
    class="syntax-light-layer syntax-veil automatic-syntax-light"
    aria-hidden="true"
    :data-motion="studio.effectsMode"
    :data-light-style="aiState.lightStyle"
    :style="{ '--syntax-strength': aiState.intensity, visibility: dragging ? 'hidden' : 'visible' }"
  >
    <SyntaxMeaningField
      v-for="scene in scenes"
      :key="scene.entry.key"
      :plan="scene.plan"
      :clip="scene.clip"
    />
  </svg>
</template>
