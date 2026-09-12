<script setup lang="ts">
import { useId } from 'vue'
import type { SyntaxOpticalPlan } from '../effects/syntax-optics'
import SyntaxLightRibbon from './SyntaxLightRibbon.vue'
import SyntaxScopeField from './SyntaxScopeField.vue'
defineProps<{
  plan: SyntaxOpticalPlan
  clip?: { x: number; y: number; width: number; height: number }
}>()
const uid = useId()
</script>
<template>
  <g
    class="syntax-meaning-field"
    data-optics-version="27"
    :clip-path="clip ? `url(#${uid}-clip)` : undefined"
  >
    <defs v-if="clip"
      ><clipPath :id="uid + '-clip'"
        ><rect :x="clip.x" :y="clip.y" :width="clip.width" :height="clip.height" /></clipPath
    ></defs>
    <SyntaxScopeField v-if="plan.scopeFields?.nodes.length" :fields="plan.scopeFields" />
    <g
      v-for="relation in plan.relations"
      :key="relation.id"
      class="syntax-semantic-relation"
      :data-relation-id="relation.id"
      :data-family="relation.family"
      :data-kind="relation.kind"
      :data-level="relation.level"
      :data-evidence="relation.status"
      :style="{
        '--syntax-phase': -relation.phase + 's',
        filter: relation.tone ? `hue-rotate(${relation.tone}deg)` : undefined
      }"
    >
      <g class="syntax-band-emergence"
        ><g class="syntax-semantic-breath">
          <g
            v-for="(beam, index) in relation.beams"
            :key="beam.key"
            :data-extent="beam.extent"
            :data-route="beam.route"
          >
            <g v-for="piece in beam.parts ?? [beam]" :key="piece.key" :data-part="piece.part">
              <defs
                ><linearGradient
                  :id="`${uid}-${relation.id}-${index}-${piece.key}`"
                  gradientUnits="userSpaceOnUse"
                  :x1="(piece.gradient?.start ?? piece.start).x"
                  :y1="(piece.gradient?.start ?? piece.start).y"
                  :x2="(piece.gradient?.end ?? piece.end).x"
                  :y2="(piece.gradient?.end ?? piece.end).y"
                >
                  <stop
                    stop-color="var(--grammar-color)"
                    :stop-opacity="beam.route === 'margin' ? 0 : 0.08"
                  /><stop
                    offset=".16"
                    stop-color="var(--grammar-color)"
                    :stop-opacity="piece.part === 'exit' ? 0.14 : 0.9"
                  /><stop
                    offset=".5"
                    stop-color="var(--grammar-glint)"
                    :stop-opacity="piece.part && piece.part !== 'corridor' ? 0.24 : 1"
                  /><stop
                    offset=".84"
                    stop-color="var(--grammar-color)"
                    :stop-opacity="piece.part === 'entry' ? 0.14 : 0.95"
                  /><stop
                    offset="1"
                    stop-color="var(--grammar-color)"
                    :stop-opacity="beam.route === 'margin' ? 0 : 0.08"
                  /> </linearGradient
              ></defs>
              <path
                class="syntax-semantic-halo"
                :d="piece.body"
                :style="{ fill: `url(#${uid}-${relation.id}-${index}-${piece.key})` }"
              />
              <path
                class="syntax-semantic-surface"
                :d="piece.body"
                :style="{ fill: `url(#${uid}-${relation.id}-${index}-${piece.key})` }"
              />
              <path
                class="syntax-semantic-caustic"
                :d="piece.core"
                :style="{
                  fill:
                    beam.route === 'margin'
                      ? `url(#${uid}-${relation.id}-${index}-${piece.key})`
                      : 'var(--grammar-glint)'
                }"
              />
            </g>
          </g> </g
      ></g>
    </g>
    <SyntaxLightRibbon
      v-for="mark in plan.marks"
      :key="mark.band.key"
      :band="mark.band"
      :active="mark.active"
      kind="dependency"
      :seed="mark.phase"
      :family="mark.family"
      :governor="mark.governor"
      :clause="mark.clause"
      :tone="mark.tone"
    />
  </g>
</template>
