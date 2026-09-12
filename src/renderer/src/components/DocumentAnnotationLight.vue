<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import ReadingColorLight from './ReadingColorLight.vue'
import {
  documentAnnotationSources,
  mountDocumentAnnotations
} from '../composables/documentAnnotations'
import { settings } from '../composables/useSettings'
import { documentSession } from '../composables/documentSession'
import { studio } from '../composables/useStudio'
import { aiState } from '../composables/aiReading'
let off: (() => void) | undefined
onMounted(() => {
  off = mountDocumentAnnotations()
})
onBeforeUnmount(() => off?.())
</script>
<template>
  <ReadingColorLight
    :sources="documentAnnotationSources"
    :enabled="
      settings.annotationMode === 'document' &&
      documentSession.mode === 'read' &&
      aiState.lightsOn &&
      studio.effectsMode !== 'off'
    "
  />
</template>
