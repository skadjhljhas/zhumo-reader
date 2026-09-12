<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import StudioIcon from './StudioIcon.vue'
import { studio, currentTheme, cycleEffects, openNoteAtlas } from '../composables/useStudio'
import { documentSession, isDirty } from '../composables/documentSession'
import { uiState } from '../composables/useSettings'
import { bookState, openBookViaDialog, backToWelcome, newMarkdown } from '../composables/useBook'
import { openAiPanel } from '../composables/aiReading'
import { pdfExport } from '../composables/pdfExport'
import AppToolbar from './AppToolbar.vue'
const more = ref(false),
  menu = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>()
const title = computed(() => bookState.book?.title || bookState.payload?.title || '阅读室')
function close(restore = false): void {
  more.value = false
  if (restore) trigger.value?.focus()
}
async function toggle(): Promise<void> {
  more.value = !more.value
  if (more.value) {
    await nextTick()
    menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
}
function outside(event: PointerEvent): void {
  if (
    event.target instanceof Node &&
    !menu.value?.contains(event.target) &&
    !trigger.value?.contains(event.target)
  )
    close()
}
function keys(event: KeyboardEvent): void {
  if (!more.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', keys)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', keys)
})
</script>
<template>
  <nav class="studio-rail" aria-label="工作区导航">
    <button
      class="rail-brand"
      aria-label="回到阅读室"
      :title="title + (isDirty ? ' · 有未保存的修改' : '')"
      @click="backToWelcome"
    >
      朱<span>墨</span><i v-if="isDirty" class="rail-unsaved" />
    </button>
    <div class="rail-actions">
      <AppToolbar v-if="bookState.status !== 'welcome'" />
      <button
        v-else
        class="rail-button"
        aria-label="打开文稿"
        title="打开文稿"
        @click="openBookViaDialog"
      >
        <StudioIcon name="open" />
      </button>
      <button
        class="rail-button"
        aria-label="全文检索"
        title="全文检索 · Ctrl+F"
        :disabled="!bookState.book"
        @click="studio.searchOpen = true"
      >
        <StudioIcon name="search" />
      </button>
    </div>
    <div class="rail-bottom">
      <button
        class="rail-button"
        aria-label="选择阅读主题"
        :title="currentTheme.name + ' · 阅读主题'"
        @click="studio.galleryOpen = true"
      >
        <StudioIcon name="palette" />
      </button>
      <button
        ref="trigger"
        class="rail-button"
        aria-label="更多阅读工具"
        title="更多阅读工具"
        aria-haspopup="menu"
        :aria-expanded="more"
        @click="toggle"
      >
        <StudioIcon name="more" />
      </button>
      <button
        class="rail-button"
        aria-label="阅读设置"
        title="阅读设置"
        @click="uiState.settingsOpen = !uiState.settingsOpen"
      >
        <StudioIcon name="settings" />
      </button>
    </div>
    <Teleport to="body">
      <aside
        v-if="more"
        ref="menu"
        class="rail-menu"
        role="menu"
        aria-label="更多阅读工具"
        @click="close()"
      >
        <div class="rail-menu-title" :title="title">
          {{ title }}<span v-if="bookState.payload?.format === 'epub'">EPUB</span>
        </div>
        <button role="menuitem" aria-label="新建 Markdown" @click="newMarkdown()">
          <StudioIcon name="new" :size="17" />新建 Markdown<small>Ctrl+N</small>
        </button>
        <button
          role="menuitem"
          aria-label="导出 PDF"
          :disabled="bookState.status !== 'reading'"
          @click="pdfExport.open = true"
        >
          <StudioIcon name="export" :size="17" />导出 PDF
        </button>
        <div class="rail-menu-divider" />
        <button
          role="menuitem"
          aria-label="全书长卷"
          :disabled="!bookState.book || documentSession.mode !== 'read'"
          @click="studio.panoramaOpen = true"
        >
          <StudioIcon name="panorama" :size="17" />全书长卷
        </button>
        <button
          role="menuitem"
          aria-label="注释脉络"
          :disabled="!bookState.book?.notes.length"
          @click="openNoteAtlas()"
        >
          <StudioIcon name="branches" :size="17" />注释脉络
        </button>
        <button role="menuitem" aria-label="AI 细读与句法之光" @click="openAiPanel()">
          <StudioIcon name="branches" :size="17" />AI 细读与模型
        </button>
        <button role="menuitem" aria-label="AI 注释写作协议" @click="studio.promptOpen = true">
          <StudioIcon name="layers" :size="17" />AI 注释写作协议
        </button>
        <template v-if="['lucent', 'astral', 'chaosheng'].includes(studio.themeId)">
          <div class="rail-menu-divider" />
          <button
            role="menuitem"
            :aria-label="'光影：' + (studio.effectsMode === 'off' ? '关' : '开')"
            @click="cycleEffects"
          >
            <StudioIcon name="sun" :size="17" />光影<small>{{
              studio.effectsMode === 'off' ? '关' : '开'
            }}</small>
          </button>
        </template>
      </aside>
    </Teleport>
  </nav>
</template>
