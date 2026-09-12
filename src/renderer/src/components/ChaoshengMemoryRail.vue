<script setup lang="ts">
import { tidalMemory, openTidalMemory } from '../composables/tidalMemory'
import { tidalPlaceKey } from '../composables/tidalPlaces'
import TidalMemoryChart from './TidalMemoryChart.vue'
import { echoState } from '../composables/readingEcho'
import { ECHO_START_SECONDS } from '../effects/echo-metrics'
</script>
<template>
  <section class="tidal-memory-rail" aria-label="页边停留">
    <button class="tidal-memory-heading" :disabled="!tidalMemory.ready" @click="openTidalMemory()">
      <span>回声</span><small>{{ tidalMemory.places.length }} 处停留</small
      ><b aria-hidden="true">↗</b>
    </button>
    <button
      class="tidal-memory-map-button"
      aria-label="展开回声"
      :disabled="!tidalMemory.ready"
      @click="openTidalMemory()"
    >
      <TidalMemoryChart :places="tidalMemory.places" compact />
    </button>
    <div v-if="tidalMemory.places.length" class="tidal-memory-words">
      <button
        v-for="place in tidalMemory.places.slice(-3).reverse()"
        :key="tidalPlaceKey(place)"
        :title="place.title"
        @click="openTidalMemory(place)"
      >
        {{ place.address.match.text }}
      </button>
    </div>
    <p
      v-if="echoState.seconds >= ECHO_START_SECONDS && tidalMemory.enabled"
      class="echo-current-word"
    >
      {{ echoState.text }}
    </p>
    <p v-else>{{ tidalMemory.enabled ? '字句退去，余韵仍在。' : '记录暂停，来处仍在。' }}</p>
  </section>
</template>
