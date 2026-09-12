<script setup lang="ts">
import { useId, computed } from 'vue'
import type { SyntaxLightBand } from '../effects/syntax-light-geometry'
const props = defineProps<{
  band: SyntaxLightBand
  active: boolean
  kind: string
  legacy?: boolean
  seed?: number
  family?: string
  governor?: boolean
  clause?: boolean
  tone?: number
}>()
const id = useId()
const width = computed(() => props.band.width)
const ribbon = computed(() =>
  props.family
    ? fluid((props.seed ?? 0) * 0.42)
    : `M-10,-4 C${width.value * 0.2},-13 ${width.value * 0.64},11 ${width.value + 12},-4 C${width.value * 0.68},15 ${width.value * 0.22},5 -10,-4Z`
)
const reflection = computed(() =>
  props.family
    ? fluid((props.seed ?? 0) * 0.42, true)
    : `M-9,4 C${width.value * 0.25},15 ${width.value * 0.65},-8 ${width.value + 10},3 C${width.value * 0.6},3 ${width.value * 0.2},19 -9,4Z`
)
function fluid(phase: number, reflected = false): string {
  const w = width.value
  const sign = reflected ? -1 : 1
  if (props.family) {
    const a = sign * (0.8 + Math.sin(phase) * 0.55),
      b = sign * (1.4 + Math.sin(phase + 1) * 0.65)
    return `M-5,0 C${w * 0.22},${a - 2} ${w * 0.72},${b - 2} ${w + 5},0 C${w * 0.72},${b + 1.5} ${w * 0.22},${a + 1.5} -5,0Z`
  }
  const y = (base: number, offset: number): number => sign * (base + Math.sin(phase + offset) * 3)
  return `M-10,${y(-4, 0)} C${w * 0.2},${y(-12, 0.5)} ${w * 0.64},${y(8, 1.4)} ${w + 12},${y(-3, 2)} C${w * 0.68},${y(15, 2.7)} ${w * 0.22},${y(5, 3.3)} -10,${y(-4, 0)}Z`
}
function fluidStyle(reflected = false): Record<string, string> {
  const phase = (props.seed ?? 0) * 0.42
  return {
    '--ribbon-start': `path('${fluid(phase, reflected)}')`,
    '--ribbon-end': `path('${fluid(phase + 2.8, reflected)}')`
  }
}
</script>
<template>
  <g
    class="syntax-relation-band"
    :class="{ 'is-active': active, 'is-legacy': legacy }"
    :data-unit-index="band.index"
    :data-relation-kind="kind"
    :data-family="family"
    :data-governor="governor"
    :data-clause="clause"
    :transform="`translate(${band.x} ${band.y})`"
    :style="{
      '--syntax-phase': `${-(seed ?? 0) * 2.7}s`,
      '--syntax-fill': `url(#${id}-ray)`,
      filter: tone ? `hue-rotate(${tone}deg)` : undefined
    }"
  >
    <defs>
      <linearGradient :id="id + '-ray'" x1="0" y1="0" x2="1" y2=".4">
        <stop stop-color="var(--syntax-ray-cool)" stop-opacity="0" />
        <stop offset=".26" stop-color="var(--syntax-ray-cool)" stop-opacity=".7" />
        <stop offset=".52" stop-color="var(--syntax-ray-core)" />
        <stop offset=".73" stop-color="var(--syntax-ray-warm)" stop-opacity=".75" />
        <stop offset="1" stop-color="var(--syntax-ray-warm)" stop-opacity="0" />
      </linearGradient>
    </defs>
    <g class="syntax-band-emergence"
      ><g class="syntax-veil-motion">
        <path
          class="syntax-veil-halo"
          :style="fluidStyle()"
          :fill="`url(#${id}-ray)`"
          :d="ribbon"
        />
        <path
          class="syntax-veil-refraction"
          :style="fluidStyle(true)"
          :fill="`url(#${id}-ray)`"
          :d="reflection"
        />
        <path
          v-if="kind === 'scope' || kind === 'perspective'"
          class="syntax-veil-boundary"
          :fill="`url(#${id}-ray)`"
          :d="`M-4,4 Q${width * 0.5},-8 ${width + 4},4 Q${width * 0.5},11 -4,4Z`"
        /> </g
    ></g>
  </g>
</template>
