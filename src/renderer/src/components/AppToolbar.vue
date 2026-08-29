<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 顶部工具栏（固定高度 52px）。
 * 左：目录开关 + 书名；右：进度百分比 + 打开 + 侧栏开关 + 设置开关。
 * 底缘 2px 阅读进度条。
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { bookState, openBookViaDialog } from '../composables/useBook'
import { settings, uiState } from '../composables/useSettings'
import { readerState } from '../composables/readerStore'

const title = computed(() => bookState.book?.title || bookState.payload?.title || '朱墨')
const percent = computed(() => `${Math.round(readerState.progress * 100)}%`)
const isReading = computed(() => bookState.status === 'reading')
</script>

<template>
  <header class="toolbar">
    <div class="tb-left">
      <button
        v-if="isReading"
        class="zm-icon-btn"
        :class="{ 'is-on': uiState.tocOpen }"
        aria-label="切换目录"
        :aria-pressed="uiState.tocOpen"
        @click="uiState.tocOpen = !uiState.tocOpen"
      >
        <AppIcon name="toc" />
      </button>
      <span class="tb-seal" aria-hidden="true">朱</span>
      <h1 class="tb-title" :title="title">{{ title }}</h1>
    </div>

    <div class="tb-right">
      <span v-if="isReading" class="tb-progress-text" aria-label="阅读进度">{{ percent }}</span>
      <button class="zm-icon-btn" aria-label="打开书籍" @click="openBookViaDialog">
        <AppIcon name="open" />
      </button>
      <button
        v-if="isReading"
        class="zm-icon-btn"
        :class="{ 'is-on': settings.sidebarVisible }"
        aria-label="切换注释侧栏"
        :aria-pressed="settings.sidebarVisible"
        @click="settings.sidebarVisible = !settings.sidebarVisible"
      >
        <AppIcon name="sidebar" />
      </button>
      <button
        class="zm-icon-btn"
        :class="{ 'is-on': uiState.settingsOpen }"
        aria-label="阅读设置"
        :aria-pressed="uiState.settingsOpen"
        @click="uiState.settingsOpen = !uiState.settingsOpen"
      >
        <AppIcon name="settings" />
      </button>
    </div>

    <div
      class="tb-progress-bar"
      role="progressbar"
      :aria-valuenow="Math.round(readerState.progress * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="tb-progress-fill" :style="{ transform: `scaleX(${readerState.progress})` }"></div>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  position: relative;
  flex: none;
  height: var(--toolbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px 0 10px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
  z-index: 30;
}

.tb-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tb-seal {
  flex: none;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 14px;
  font-weight: 700;
  border-radius: 5px;
  user-select: none;
}

.tb-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.tb-right {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.tb-progress-text {
  min-width: 44px;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
  margin-right: 6px;
  user-select: none;
}

/* 底缘 2px 进度条：scaleX 变换，避免布局抖动 */
.tb-progress-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}
.tb-progress-fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 120ms linear;
}
</style>
