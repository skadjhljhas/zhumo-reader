<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import StudioIcon from './StudioIcon.vue'
import { bookState, openBookViaDialog } from '../composables/useBook'
import { settings, uiState } from '../composables/useSettings'
import { documentSession, guardDocumentAction } from '../composables/documentSession'
import { captureReadingPosition, trackReadingPosition } from '../composables/documentPosition'
let stopPositionTracking: (() => void) | undefined
onMounted(() => {
  stopPositionTracking = trackReadingPosition(() => bookState.book)
})
onBeforeUnmount(() => stopPositionTracking?.())
function switchMode(): void {
  if (documentSession.mode === 'read') {
    if (bookState.payload?.format === 'epub') return
    captureReadingPosition(bookState.book)
    documentSession.mode = 'edit'
  } else
    guardDocumentAction(() => {
      window.dispatchEvent(new Event('zhumo:capture-editor-position'))
      documentSession.mode = 'read'
    })
}
</script>
<template>
  <section class="studio-toolbar rail-toolbar" aria-label="文稿操作">
    <button class="rail-button" aria-label="打开书籍" title="打开书籍" @click="openBookViaDialog">
      <StudioIcon name="open" />
    </button>
    <button
      v-if="bookState.payload?.format !== 'epub'"
      class="rail-button"
      :aria-label="documentSession.mode === 'edit' ? '阅读' : '开启编辑'"
      :title="documentSession.mode === 'edit' ? '返回阅读' : '开启编辑'"
      :aria-pressed="documentSession.mode === 'edit'"
      :disabled="bookState.status !== 'reading'"
      @click="switchMode"
    >
      <StudioIcon :name="documentSession.mode === 'edit' ? 'book' : 'edit'" />
    </button>
    <button
      class="rail-button"
      aria-label="切换目录"
      title="目录"
      :aria-pressed="uiState.tocOpen"
      @click="uiState.tocOpen = !uiState.tocOpen"
    >
      <StudioIcon name="toc" />
    </button>
    <button
      class="rail-button"
      aria-label="切换注释侧栏"
      title="页边注释"
      :aria-pressed="settings.sidebarVisible"
      @click="settings.sidebarVisible = !settings.sidebarVisible"
    >
      <StudioIcon name="notes" />
    </button>
  </section>
</template>
