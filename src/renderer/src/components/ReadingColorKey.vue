<script setup lang="ts">
import type { ReadingColorMark } from '../../../shared/reading-colors'
defineProps<{ marks: ReadingColorMark[] }>()
</script>
<template>
  <details v-if="marks.length" class="syntax-units-disclosure reading-color-key">
    <summary>查看本段的着色依据</summary>
    <p v-for="mark in marks" :key="mark.id">
      <span
        class="reading-color-swatch"
        :style="{
          color: mark.textColor,
          background: `radial-gradient(ellipse, ${mark.glowColor}80, transparent)`
        }"
        >{{ mark.quote }}</span
      >
      <span v-if="mark.note">{{ mark.note }}</span>
      <small>字色 {{ mark.textColor }} · 荧光 {{ mark.glowColor }}</small>
    </p>
  </details>
</template>
<style>
.reading-color-key p {
  display: grid;
  gap: 6px;
  padding: 9px 0;
}
.reading-color-swatch {
  width: fit-content;
  padding: 2px 8px;
}
.reading-color-key small {
  font-size: 10px;
  color: var(--text-2);
}
</style>
