<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { aiSelection, aiState } from '../composables/aiReading'
import { resolveSyntaxAnchors } from '../effects/syntax-ranges'
import { syntaxLightBands, type SyntaxLightBand } from '../effects/syntax-light-geometry'
import { focusedSyntax } from '../composables/syntaxFocus'
import { studio } from '../composables/useStudio'
import { uiState } from '../composables/useSettings'
import { bookState } from '../composables/useBook'
import SyntaxMeaningField from './SyntaxMeaningField.vue'
import { syntaxOpticalPlan, emptyOpticalPlan } from '../effects/syntax-optics'
import { SyntaxRouteLanes } from '../effects/syntax-route-lanes'
import ReadingColorLight from './ReadingColorLight.vue'
import { documentSession } from '../composables/documentSession'
import { readingAppearanceKey, watchReadingAppearance } from '../effects/reading-appearance'
const appearance = ref(readingAppearanceKey())
let unwatchAppearance: (() => void) | undefined
const routeLanes = new SyntaxRouteLanes()
const bands = ref<SyntaxLightBand[]>([]),
  selecting = ref(false)
const analysis = computed(() => aiState.runs.syntax.analysis)
const colorSources = computed(() =>
  analysis.value?.version === 4 && aiSelection.value
    ? [{ key: 'manual', analysis: analysis.value, anchors: aiSelection.value.anchors }]
    : []
)
const focus = computed(() => (analysis.value ? focusedSyntax(analysis.value) : undefined))
const plan = computed(() =>
  analysis.value
    ? syntaxOpticalPlan(
        analysis.value,
        bands.value,
        aiState.syntaxReading,
        focus.value?.relation?.id,
        undefined,
        routeLanes
      )
    : emptyOpticalPlan()
)
const clip = ref<{ x: number; y: number; width: number; height: number }>()
const visible = computed(
  () =>
    aiState.lightsOn &&
    studio.effectsMode !== 'off' &&
    !aiState.stale &&
    !aiState.demonstration &&
    Boolean(analysis.value) &&
    (analysis.value?.version !== 4 || aiState.runs.syntax.appearanceKey === appearance.value) &&
    !selecting.value
)
let frame = 0,
  observer: ResizeObserver | undefined,
  mutations: MutationObserver | undefined
function measure(): void {
  frame = 0
  const selection = aiSelection.value
  if (!visible.value || !selection || !focus.value) {
    bands.value = []
    return
  }
  bands.value = syntaxLightBands(
    resolveSyntaxAnchors(selection.anchors, bookState.book?.notes ?? []),
    focus.value.units
  )
  const root = selection.range?.startContainer.parentElement
    ?.closest('.reader-scroll,.notes-scroll')
    ?.getBoundingClientRect()
  clip.value = root ? { x: root.x, y: root.y, width: root.width, height: root.height } : undefined
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure)
}
function selectionChanged(): void {
  schedule()
}
function down(event: PointerEvent): void {
  if (event.button === 0) selecting.value = true
}
function up(): void {
  selecting.value = false
  schedule()
}
function reconnect(): void {
  observer?.disconnect()
  mutations?.disconnect()
  for (const root of document.querySelectorAll('.reader-scroll,.notes-scroll')) {
    observer?.observe(root)
    mutations?.observe(root, { childList: true, subtree: true, characterData: true })
  }
  void nextTick(schedule)
}
watch(
  () => [
    visible.value,
    aiSelection.value,
    analysis.value,
    aiState.syntaxReading,
    aiState.open,
    aiState.settingsOpen,
    studio.themeId,
    studio.galleryOpen,
    studio.searchOpen,
    studio.promptOpen,
    studio.atlasOpen,
    studio.panoramaOpen,
    uiState.settingsOpen,
    uiState.tocOpen
  ],
  reconnect
)
onMounted(() => {
  unwatchAppearance = watchReadingAppearance((key) => {
    appearance.value = key
  })
  observer = new ResizeObserver(schedule)
  mutations = new MutationObserver(schedule)
  reconnect()
  selectionChanged()
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  document.fonts.addEventListener('loadingdone', schedule)
  document.addEventListener('toggle', schedule, true)
  document.addEventListener('close', schedule, true)
  document.addEventListener('transitionend', schedule, true)
  document.addEventListener('selectionchange', selectionChanged)
  document.addEventListener('pointerdown', down)
  document.addEventListener('pointerup', up)
  window.addEventListener('blur', up)
})
onBeforeUnmount(() => {
  unwatchAppearance?.()
  cancelAnimationFrame(frame)
  observer?.disconnect()
  mutations?.disconnect()
  window.removeEventListener('scroll', schedule, true)
  window.removeEventListener('resize', schedule)
  document.fonts.removeEventListener('loadingdone', schedule)
  document.removeEventListener('toggle', schedule, true)
  document.removeEventListener('close', schedule, true)
  document.removeEventListener('transitionend', schedule, true)
  document.removeEventListener('selectionchange', selectionChanged)
  document.removeEventListener('pointerdown', down)
  document.removeEventListener('pointerup', up)
  window.removeEventListener('blur', up)
})
</script>
<template>
  <ReadingColorLight
    :sources="colorSources"
    :enabled="visible && documentSession.mode === 'read'"
  />
  <svg
    v-if="visible && analysis?.version !== 4"
    class="syntax-light-layer syntax-veil"
    aria-hidden="true"
    :data-light-style="aiState.lightStyle"
    :data-motion="studio.effectsMode"
    :data-relation="focus?.relation?.id"
    :style="{ '--syntax-strength': aiState.intensity }"
  >
    <SyntaxMeaningField :plan="plan" :clip="clip" />
  </svg>
</template>
