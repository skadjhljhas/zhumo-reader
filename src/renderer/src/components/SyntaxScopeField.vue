<script setup lang="ts">
import { defineComponent, h, useId, type PropType, type VNode } from 'vue'
import type { ScopeFieldNode, SyntaxScopeFields } from '../effects/syntax-scope-fields'

defineProps<{ fields: SyntaxScopeFields }>()
const uid = useId()
const nodeId = (node: ScopeFieldNode): string =>
  uid + '-scope-' + [...node.id].map((letter) => letter.codePointAt(0)!.toString(16)).join('-')
const colour = (hue: number, lightness: number): string => `hsl(${hue} 80% ${lightness}%)`
const spectrumInk = (hue: number): string =>
  `color-mix(in srgb, var(--text, #25374a) 78%, ${colour(hue, 57)} 22%)`

// A local recursive SVG component keeps the actual semantic ancestry in the DOM and masks.
// It owns no independent data or layout; the public component still accepts only fields.
const ScopeBranch = defineComponent({
  name: 'SyntaxScopeFieldBranch',
  props: { node: { type: Object as PropType<ScopeFieldNode>, required: true } },
  setup(branch) {
    return (): VNode => {
      const node = branch.node
      return h(
        'g',
        {
          class: 'syntax-scope-field-branch',
          'data-scope-id': node.id,
          'data-scope-parent': node.parentId,
          'data-scope-depth': node.depth,
          'data-family': node.family,
          'data-evidence': node.status,
          mask: `url(#${nodeId(node)}-mask)`
        },
        [
          // Arrival animates this stable outer group; depth opacity remains on its inner
          // paint group. Existing relationship IDs keep the same keyed branch across patches.
          h('g', { class: 'syntax-band-emergence', key: node.id }, [
            h('g', { class: 'syntax-scope-field-own', opacity: 0.9 / (1 + node.depth * 0.15) }, [
              ...node.coverage.map((fragment) =>
                h('rect', {
                  key: fragment.key,
                  'data-scope-fragment': fragment.key,
                  x: fragment.x,
                  y: fragment.y,
                  width: fragment.width,
                  height: fragment.height,
                  fill: `url(#${nodeId(node)}-field)`
                })
              ),
              ...node.operator.fragments.map((fragment) =>
                h('rect', {
                  key: fragment.key,
                  'data-operator-fragment': fragment.key,
                  x: fragment.x,
                  y: fragment.y,
                  width: fragment.width,
                  height: fragment.height,
                  opacity: 0.7,
                  fill: `url(#${nodeId(node)}-cue)`
                })
              )
            ])
          ]),
          ...node.children.map((child) => h(ScopeBranch, { node: child, key: child.id }))
        ]
      )
    }
  }
})
</script>

<template>
  <g
    class="syntax-scope-fields"
    data-scope-fields-version="1"
    :data-reading-id="fields.readingId"
    :data-has-alternatives="fields.hasAlternatives"
    aria-hidden="true"
  >
    <defs>
      <template v-for="fieldNode in fields.nodes" :key="fieldNode.id">
        <radialGradient
          :id="nodeId(fieldNode) + '-field'"
          cx=".5"
          cy=".5"
          r=".5"
          :fx="fieldNode.focus"
          :fy="0.4 + (fieldNode.depth % 5) * 0.03"
        >
          <stop :stop-color="colour(fieldNode.hue + 15, 88)" stop-opacity=".6" />
          <stop offset=".28" :stop-color="colour(fieldNode.hue, 63)" stop-opacity=".78" />
          <stop offset=".65" :stop-color="colour(fieldNode.hue + 9, 74)" stop-opacity=".4" />
          <stop offset="1" :stop-color="colour(fieldNode.hue, 74)" stop-opacity="0" />
        </radialGradient>
        <radialGradient
          :id="nodeId(fieldNode) + '-cue'"
          cx=".5"
          cy=".5"
          r=".5"
          :fx="1 - fieldNode.focus"
          fy=".45"
        >
          <stop :stop-color="colour(fieldNode.hue, 91)" stop-opacity=".84" />
          <stop offset=".35" :stop-color="colour(fieldNode.hue, 59)" stop-opacity=".72" />
          <stop offset="1" :stop-color="colour(fieldNode.hue, 78)" stop-opacity="0" />
        </radialGradient>
        <mask
          :id="nodeId(fieldNode) + '-mask'"
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
          :x="fields.bounds?.x"
          :y="fields.bounds?.y"
          :width="fields.bounds?.width"
          :height="fields.bounds?.height"
          style="mask-type: luminance"
        >
          <rect
            v-for="(rect, i) in fieldNode.mask"
            :key="i"
            :x="rect.x"
            :y="rect.y"
            :width="rect.width"
            :height="rect.height"
            fill="white"
          />
        </mask>
      </template>
      <mask
        v-if="fields.bounds"
        :id="uid + '-ink'"
        maskUnits="userSpaceOnUse"
        maskContentUnits="userSpaceOnUse"
        :x="fields.bounds.x"
        :y="fields.bounds.y"
        :width="fields.bounds.width"
        :height="fields.bounds.height"
        style="mask-type: luminance"
      >
        <rect
          :x="fields.bounds.x"
          :y="fields.bounds.y"
          :width="fields.bounds.width"
          :height="fields.bounds.height"
          fill="white"
        />
        <!-- We only have range/ink rectangles, not a glyph alpha mask. Protect their interiors
             conservatively; this never changes the source text's style or opacity. -->
        <rect
          v-for="(rect, i) in fields.ink"
          :key="i"
          :x="rect.x"
          :y="rect.y"
          :width="rect.width"
          :height="rect.height"
          fill="#292929"
        />
      </mask>
      <clipPath
        v-for="(spectrum, i) in fields.spectra"
        :id="uid + '-spectrum-' + i"
        :key="spectrum.rootId"
      >
        <rect
          v-if="spectrum.box"
          :x="spectrum.box.x"
          :y="spectrum.box.y"
          :width="spectrum.box.width"
          :height="spectrum.box.height"
        />
      </clipPath>
    </defs>
    <g v-if="fields.bounds" class="syntax-scope-field-surfaces" :mask="`url(#${uid}-ink)`">
      <ScopeBranch v-for="root in fields.roots" :key="root.id" :node="root" />
    </g>
    <g class="syntax-scope-spectra">
      <g
        v-for="(spectrum, i) in fields.spectra"
        :key="spectrum.rootId"
        :data-scope-spectrum="spectrum.rootId"
        :data-placement="spectrum.placement"
        :clip-path="`url(#${uid}-spectrum-${i})`"
      >
        <template v-for="(token, j) in spectrum.tokens" :key="token.id">
          <text
            v-if="token.position && ['below', 'above'].includes(spectrum.placement) && j > 0"
            class="syntax-scope-spectrum-separator"
            :x="token.position.x - 11"
            :y="token.position.y"
            >›</text
          >
          <text
            v-if="token.position"
            :data-spectrum-operator="token.id"
            :data-scope-depth="token.depth"
            :x="token.position.x"
            :y="token.position.y"
            :fill="spectrumInk(token.hue)"
            >{{ token.text }}</text
          >
        </template>
      </g>
    </g>
  </g>
</template>

<style>
.syntax-scope-fields {
  pointer-events: none;
  user-select: none;
}
.syntax-scope-field-surfaces {
  /* Cap the whole composited tree, rather than making twenty nested lights wash out ink. */
  opacity: clamp(0, calc(var(--syntax-strength, 1) * 0.3), 0.3);
}
.syntax-scope-spectra {
  opacity: clamp(0, var(--syntax-strength, 1), 1);
}
.syntax-scope-spectra text {
  font-family: var(--ui-font, system-ui, sans-serif);
  font-size: 11px;
  font-weight: 450;
  letter-spacing: 0;
  opacity: 0.84;
}
.syntax-scope-spectra .syntax-scope-spectrum-separator {
  fill: var(--text, #25374a);
  opacity: 0.38;
}
</style>
