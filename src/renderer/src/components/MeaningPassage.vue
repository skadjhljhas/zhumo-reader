<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SyntaxAnalysis } from '../../../shared/ai-types'
import { syntaxProjection } from '../../../shared/syntax-view'
import { syntaxTextSlices } from '../effects/syntax-ranges'
import { syntaxLightBands, type SyntaxLightBand } from '../effects/syntax-light-geometry'
import { syntaxOpticalPlan } from '../effects/syntax-optics'
import SyntaxMeaningField from './SyntaxMeaningField.vue'
const props = defineProps<{
  analysis: SyntaxAnalysis
  reading?: string
  light: boolean
  still: boolean
}>()
const surface = ref<HTMLElement>(),
  sentence = ref<HTMLElement>(),
  bands = ref<SyntaxLightBand[]>([])
const plan = computed(() => syntaxOpticalPlan(props.analysis, bands.value, props.reading))
let observer: ResizeObserver | undefined,
  frame = 0
function measure(): void {
  frame = 0
  if (!sentence.value || !surface.value) return
  const r = document.createRange()
  r.selectNodeContents(sentence.value)
  bands.value = syntaxLightBands(
    syntaxTextSlices(r, props.analysis.text),
    syntaxProjection(props.analysis, props.reading).units,
    surface.value
  )
}
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure)
}
watch(
  () => [props.analysis, props.reading],
  () => void nextTick(schedule)
)
onMounted(() => {
  observer = new ResizeObserver(schedule)
  if (surface.value) observer.observe(surface.value)
  document.fonts.addEventListener('loadingdone', schedule)
  schedule()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  document.fonts.removeEventListener('loadingdone', schedule)
})
</script>
<template>
  <div ref="surface" class="meaning-passage" :data-motion="still ? 'quiet' : 'full'">
    <svg
      v-if="light"
      class="syntax-preview-veil syntax-veil"
      :data-motion="still ? 'quiet' : 'full'"
      data-light-style="spectrum"
      aria-hidden="true"
      style="--syntax-strength: 1"
    >
      <SyntaxMeaningField :plan="plan" />
    </svg>
    <p ref="sentence" class="meaning-passage-text">{{ analysis.text }}</p>
  </div>
</template>
