<script setup lang="ts">
import { currentTheme } from '../composables/useStudio'
import ManuscriptLight from './ManuscriptLight.vue'
defineProps<{ compact?: boolean }>()
</script>
<template>
  <div
    class="theme-art"
    :class="{
      compact,
      'has-manuscript-light': currentTheme.id === 'lucent' || currentTheme.id === 'chaosheng'
    }"
    aria-hidden="true"
  >
    <ManuscriptLight v-if="currentTheme.id === 'lucent' || currentTheme.id === 'chaosheng'" />
    <template v-else>
      <div class="art-grid"></div>
      <div class="art-halo"></div>
      <svg class="art-lines" viewBox="0 0 440 340" fill="none">
        <g class="crystal-facets" stroke="currentColor" stroke-width=".65">
          <path
            d="M220 25 334 119 289 264 183 311 99 209 119 86Z"
            fill="currentColor"
            fill-opacity=".055"
          />
          <path
            d="m220 25 31 118 83-24-83 24 38 121-38-121-68 168 68-168-152 66 152-66L119 86l132 57Z"
          />
          <path
            d="m183 311 6-127L99 209m90-25L119 86m70 98 31-159m-31 159 100 80m-100-80 145-65"
            opacity=".35"
          />
          <circle cx="220" cy="171" r="144" stroke-dasharray="1 13" />
        </g>
        <g class="orbit-lines" stroke="currentColor" stroke-width=".7">
          <ellipse cx="220" cy="170" rx="173" ry="75" transform="rotate(-32 220 170)" />
          <ellipse cx="220" cy="170" rx="173" ry="75" transform="rotate(32 220 170)" />
          <ellipse cx="220" cy="170" rx="173" ry="75" transform="rotate(90 220 170)" />
          <circle cx="220" cy="170" r="111" />
          <circle cx="220" cy="170" r="42" />
          <path d="M20 170h400M220 20v300" stroke-dasharray="2 8" />
        </g>
        <g class="leaf-lines" stroke="currentColor" stroke-width="1.2">
          <path
            d="M215 315C220 225 245 132 204 35 M223 225C149 233 109 184 117 135c49 14 82 40 106 90Z M229 190c64-13 100-62 88-112-49 22-75 60-88 112Z M228 138c-49-13-67-59-54-96 32 23 52 53 54 96Z M218 275c60-3 117-35 133-81-70 6-111 34-133 81Z M213 301c-60-6-115-43-135-92 65 10 109 38 135 92Z"
          />
          <path d="m117 135 106 90 M317 78l-88 112 M351 194l-133 81 M78 209l135 92" opacity=".4" />
        </g>
        <g class="art-stars" fill="currentColor">
          <circle cx="81" cy="102" r="3" />
          <circle cx="359" cy="237" r="4" />
          <circle cx="277" cy="48" r="2" />
          <circle cx="111" cy="263" r="2" />
        </g>
      </svg>
      <div class="art-shape art-shape-a"></div>
      <div class="art-shape art-shape-b"></div>
      <span class="art-glyph">{{ currentTheme.mark }}</span>
      <span class="art-coordinate">Z / M — 02</span
      ><span class="art-caption">{{ currentTheme.english }}</span>
    </template>
  </div>
</template>
