<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SyntaxAnalysis } from '../../../shared/ai-types'
import { aiState } from '../composables/aiReading'
import { focusedSyntax } from '../composables/syntaxFocus'
import { studio } from '../composables/useStudio'
import { syntaxTextSlices } from '../effects/syntax-ranges'
import { syntaxLightBands, type SyntaxLightBand } from '../effects/syntax-light-geometry'
import SyntaxMeaningField from './SyntaxMeaningField.vue'
import { syntaxOpticalPlan } from '../effects/syntax-optics'
import { SyntaxRouteLanes } from '../effects/syntax-route-lanes'
import { readingColorSegments, type ReadingColorMark } from '../../../shared/reading-colors'
import { readingAppearanceKey, watchReadingAppearance } from '../effects/reading-appearance'
const appearance = ref(readingAppearanceKey())
let unwatchAppearance: (() => void) | undefined
const routeLanes = new SyntaxRouteLanes()
const props = defineProps<{ analysis: SyntaxAnalysis }>()
const surface = ref<HTMLElement>(),
  sentence = ref<HTMLElement>(),
  bands = ref<SyntaxLightBand[]>([])
const focus = computed(() => focusedSyntax(props.analysis))
const colorPieces = computed(() => {
  const result: Array<{ text: string; start: number; mark?: ReadingColorMark }> = []
  let cursor = 0
  for (const segment of readingColorSegments(props.analysis.marks ?? [])) {
    if (segment.start > cursor)
      result.push({ start: cursor, text: props.analysis.text.slice(cursor, segment.start) })
    result.push({
      start: segment.start,
      text: props.analysis.text.slice(segment.start, segment.end),
      mark: segment.mark
    })
    cursor = segment.end
  }
  if (cursor < props.analysis.text.length)
    result.push({ start: cursor, text: props.analysis.text.slice(cursor) })
  return result
})
const plan = computed(() =>
  syntaxOpticalPlan(
    props.analysis,
    bands.value,
    aiState.syntaxReading,
    focus.value.relation?.id,
    undefined,
    routeLanes
  )
)
const pieces = computed(() => {
  const ranges = focus.value.units.flatMap((unit) =>
    (unit.span.anchors ?? [unit.span])
      .filter((a) => a.start >= 0)
      .map((anchor) => ({ ...unit, anchor }))
  )
  const bounds = [
    ...new Set([
      0,
      props.analysis.text.length,
      ...ranges.flatMap((r) => [r.anchor.start, r.anchor.end])
    ])
  ].sort((a, b) => a - b)
  return bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1]
    const found = ranges
      .filter((r) => r.anchor.start <= start && r.anchor.end >= end)
      .sort(
        (a, b) =>
          Number(focus.value.members.has(b.id)) - Number(focus.value.members.has(a.id)) ||
          a.anchor.end - a.anchor.start - (b.anchor.end - b.anchor.start)
      )[0]
    return {
      text: props.analysis.text.slice(start, end),
      start,
      span: found?.span,
      index: found?.index ?? -1
    }
  })
})
let observer: ResizeObserver | undefined,
  frame = 0
function measure(): void {
  frame = 0
  if (!surface.value || !sentence.value) return
  const range = document.createRange()
  range.selectNodeContents(sentence.value)
  bands.value = syntaxLightBands(
    syntaxTextSlices(range, props.analysis.text),
    focus.value.units,
    surface.value
  )
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure)
}
function active(index: number): boolean {
  return focus.value.units.some(
    (unit) =>
      unit.index === index && (focus.value.members.has(unit.id) || aiState.activeSpan === index)
  )
}
watch(
  () => [props.analysis, aiState.syntaxReading],
  () => void nextTick(schedule)
)
onMounted(() => {
  unwatchAppearance = watchReadingAppearance((key) => {
    appearance.value = key
  })
  observer = new ResizeObserver(schedule)
  if (surface.value) observer.observe(surface.value)
  document.fonts.addEventListener('loadingdone', schedule)
  schedule()
})
onBeforeUnmount(() => {
  unwatchAppearance?.()
  observer?.disconnect()
  cancelAnimationFrame(frame)
  document.fonts.removeEventListener('loadingdone', schedule)
})
</script>
<template>
  <div ref="surface" class="syntax-stage" :data-motion="studio.effectsMode">
    <svg
      v-if="analysis.version !== 4 && aiState.lightsOn && studio.effectsMode !== 'off'"
      class="syntax-preview-veil syntax-veil"
      aria-hidden="true"
      :data-light-style="aiState.lightStyle"
      :data-motion="studio.effectsMode"
      :style="{ '--syntax-strength': aiState.intensity }"
    >
      <SyntaxMeaningField :plan="plan" />
    </svg>
    <p v-if="analysis.version === 4" class="syntax-sentence reading-color-preview">
      <span
        v-for="piece in colorPieces"
        :key="piece.start"
        :style="
          piece.mark &&
          aiState.lightsOn &&
          studio.effectsMode !== 'off' &&
          (!aiState.runs.syntax.appearanceKey || aiState.runs.syntax.appearanceKey === appearance)
            ? {
                color: piece.mark.textColor,
                textShadow: `0 0 5px ${piece.mark.glowColor}60`,
                background: `radial-gradient(ellipse, ${piece.mark.glowColor}38, ${piece.mark.glowColor}16 55%, transparent 85%)`
              }
            : undefined
        "
        >{{ piece.text }}</span
      >
    </p>
    <p v-else ref="sentence" class="syntax-sentence" :class="{ 'lights-off': !aiState.lightsOn }">
      <template v-for="piece in pieces" :key="piece.start"
        ><button
          v-if="piece.span"
          class="syntax-word"
          :class="{ 'is-active': active(piece.index) }"
          :aria-label="piece.text + '，' + piece.span.label"
          @mouseenter="aiState.activeSpan = piece.index"
          @mouseleave="aiState.activeSpan = -1"
          @focus="aiState.activeSpan = piece.index"
          @blur="aiState.activeSpan = -1"
          @click="aiState.activeSpan = piece.index"
        >
          {{ piece.text }}</button
        ><span v-else>{{ piece.text }}</span></template
      >
    </p>
  </div>
</template>
