<script setup lang="ts">
import { settings } from '../composables/useSettings'
import { hdrDescription, hdrEnabled, hdrTelemetry } from '../effects/hdr'
import { studio } from '../composables/useStudio'
</script>
<template>
  <fieldset class="selection-preferences light-range-settings">
    <legend>琉璃光效</legend>
    <div class="sp-segment">
      <button :aria-pressed="studio.effectsMode === 'full'" @click="studio.effectsMode = 'full'">
        流动
      </button>
      <button :aria-pressed="studio.effectsMode === 'quiet'" @click="studio.effectsMode = 'quiet'">
        静谧
      </button>
      <button :aria-pressed="studio.effectsMode === 'off'" @click="studio.effectsMode = 'off'">
        关闭
      </button>
    </div>
    <div class="sp-segment light-range-options">
      <button :aria-pressed="settings.lightRange === 'sdr'" @click="settings.lightRange = 'sdr'">
        SDR · 阅读
      </button>
      <button :aria-pressed="settings.lightRange === 'hdr'" @click="settings.lightRange = 'hdr'">
        HDR · 展示
      </button>
    </div>
    <p class="sp-hint" role="status">{{ hdrDescription }}</p>
    <p
      v-if="hdrEnabled && studio.effectsMode === 'full' && hdrTelemetry.fps"
      class="sp-hint hdr-performance"
    >
      {{ hdrTelemetry.fps.toFixed(0) }} fps<span v-if="hdrTelemetry.displayHz">
        / {{ hdrTelemetry.displayHz }} Hz</span
      >
      · {{ hdrTelemetry.frameMs.toFixed(1) }} ms
      <span :title="hdrTelemetry.gpu"> · GPU 光场</span>
    </p>
  </fieldset>
</template>
<style>
.light-range-settings .sp-segment button {
  flex: 1;
  padding: 7px 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
}
.light-range-settings .sp-segment button[aria-pressed='true'] {
  color: var(--text);
  background: var(--bg-elevated);
  box-shadow: 0 1px 4px #102e4612;
}
.light-range-options {
  margin-top: 10px;
}
</style>
