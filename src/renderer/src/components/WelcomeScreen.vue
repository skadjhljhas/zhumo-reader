<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 欢迎页（空状态）。
 * 品牌印记 + 定位文案 + 打开按钮 + 拖放提示 + 最近书籍列表。
 * 整窗拖放由 App.vue 统一处理，此处给出视觉提示。
 */
import { onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import type { RecentBook } from '../../../shared/ipc-types'
import { openBookByPath, openBookViaDialog, bookState } from '../composables/useBook'
import { isMockApi } from '../dev/api-mock'

const recents = ref<RecentBook[]>([])
const openingPath = ref('')

async function refreshRecents(): Promise<void> {
  try {
    recents.value = await window.api.getRecentBooks()
  } catch {
    recents.value = []
  }
}

onMounted(refreshRecents)
watch(() => bookState.recentsVersion, refreshRecents)

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

async function openRecent(item: RecentBook): Promise<void> {
  if (openingPath.value) return
  openingPath.value = item.path
  await openBookByPath(item.path)
  openingPath.value = ''
}

async function removeRecent(item: RecentBook): Promise<void> {
  await window.api.removeRecent(item.path)
  await refreshRecents()
}
</script>

<template>
  <div class="welcome-screen">
    <div class="ws-inner">
      <header class="ws-brand">
        <span class="ws-seal" aria-hidden="true">朱</span>
        <div class="ws-names">
          <h1 class="ws-title">朱墨</h1>
          <p class="ws-latin">ZhuMo Reader</p>
        </div>
      </header>

      <p class="ws-tagline">为满是批注的中文学术长文而做的阅读器。</p>
      <p class="ws-sub">正文与注释侧栏对照，层级随读联动，如纸书般安静。</p>

      <div class="ws-actions">
        <button class="ws-open-btn" @click="openBookViaDialog">
          <AppIcon name="open" :size="17" />
          打开书籍
        </button>
        <p class="ws-drop-hint">或将 Markdown 文件拖入窗口</p>
      </div>

      <p v-if="bookState.statusMessage" class="ws-error" role="alert">
        {{ bookState.statusMessage }}
      </p>

      <section v-if="recents.length" class="ws-recents" aria-label="最近阅读">
        <h2 class="ws-recents-title">最近阅读</h2>
        <ul class="ws-recent-list">
          <li v-for="item in recents" :key="item.path" class="ws-recent-item">
            <button
              class="ws-recent-main"
              :disabled="openingPath === item.path"
              @click="openRecent(item)"
            >
              <AppIcon name="book" :size="16" class="ws-recent-icon" />
              <span class="ws-recent-name">{{ item.name }}</span>
              <span class="ws-recent-time">{{ formatTime(item.lastOpenedAt) }}</span>
            </button>
            <button
              class="ws-recent-remove"
              :aria-label="`从最近列表移除《${item.name}》`"
              @click="removeRecent(item)"
            >
              <AppIcon name="close" :size="13" />
            </button>
          </li>
        </ul>
      </section>

      <p v-if="isMockApi" class="ws-mock-note">浏览器预览模式 · 数据保存在本机 localStorage</p>
    </div>
  </div>
</template>

<style scoped>
.welcome-screen {
  height: 100%;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
}

.ws-inner {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
}

.ws-brand {
  display: flex;
  align-items: center;
  gap: 16px;
}

.ws-seal {
  flex: none;
  width: 54px;
  height: 54px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 30px;
  font-weight: 700;
  border-radius: 8px;
  box-shadow: 0 3px 14px var(--accent-soft);
  user-select: none;
}

.ws-title {
  margin: 0;
  font-size: 40px;
  font-weight: 700;
  letter-spacing: 0.3em;
}

.ws-latin {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 0.24em;
  color: var(--text-3);
}

.ws-tagline {
  margin: 30px 0 0;
  font-size: 17px;
  letter-spacing: 0.05em;
}

.ws-sub {
  margin: 8px 0 0;
  font-size: 13.5px;
  color: var(--text-2);
  letter-spacing: 0.03em;
}

.ws-actions {
  margin-top: 34px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.ws-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 26px;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 15px;
  letter-spacing: 0.12em;
  border-radius: 8px;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
  box-shadow: 0 4px 16px var(--accent-soft);
}
.ws-open-btn:hover {
  background: var(--accent-strong);
  box-shadow: 0 6px 22px var(--accent-soft);
  transform: translateY(-1px);
}
.ws-open-btn:active {
  transform: translateY(0) scale(0.98);
}

.ws-drop-hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.ws-error {
  margin: 18px 0 0;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 7px;
}

.ws-recents {
  margin-top: 42px;
}

.ws-recents-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.18em;
  color: var(--text-3);
}

.ws-recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.ws-recent-item {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line);
}

.ws-recent-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 6px;
  text-align: left;
  border-radius: 6px;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.ws-recent-main:hover {
  background: var(--hover-bg);
}
.ws-recent-main:disabled {
  opacity: 0.55;
  cursor: wait;
}

.ws-recent-icon {
  flex: none;
  color: var(--text-3);
}

.ws-recent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14.5px;
}

.ws-recent-time {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.ws-recent-remove {
  flex: none;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-3);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.ws-recent-item:hover .ws-recent-remove,
.ws-recent-remove:focus-visible {
  opacity: 1;
}
.ws-recent-remove:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.ws-mock-note {
  margin: 40px 0 0;
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
</style>
