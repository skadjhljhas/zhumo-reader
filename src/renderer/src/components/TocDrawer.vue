<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 目录抽屉（左侧，可折叠）。
 * H1–H3 缩进树；当前章高亮（随滚动更新）；读过的章带小圆点；
 * 点击平滑滚动到对应章。窄窗（<1120px）时转为浮层 + 遮罩。
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { bookState } from '../composables/useBook'
import { pinTocItem, readerState, requestScroll } from '../composables/readerStore'
import { uiState } from '../composables/useSettings'
import type { TocItem } from '../../../shared/types'

const toc = computed<TocItem[]>(() => bookState.book?.toc ?? [])

/** 当前目录项：钉扎存活期恒为被点项（T19）；否则同章内按「40% 线上方
 *  最后一个标题」精配，失配回退章首项 */
const currentTocId = computed(() => {
  if (readerState.pinnedTocId) return readerState.pinnedTocId
  const id = readerState.currentSectionId
  if (!id) return ''
  const inSection = toc.value.filter((t) => t.sectionId === id)
  if (!inSection.length) return ''
  const byTitle = inSection.find((t) => t.title === readerState.currentHeadingTitle)
  return (byTitle ?? inSection[0]).id
})

function go(item: TocItem): void {
  // T19：目录跳转入口设钉扎——标红（章/小节）存活期恒为被点项，用户滚动
  // 净位移超 tocPinReleasePx 或 40% 线越过被点标题时解除（ReaderView 判定）
  pinTocItem(item.id, item.sectionId, item.title)
  requestScroll('section', item.sectionId, item.title)
  if (window.innerWidth < 1120) uiState.tocOpen = false
}

function close(): void {
  uiState.tocOpen = false
}
</script>

<template>
  <Transition name="toc-fade">
    <div v-if="uiState.tocOpen" class="toc-backdrop" aria-hidden="true" @click="close"></div>
  </Transition>

  <Transition name="toc-slide">
    <aside v-if="uiState.tocOpen" class="toc-drawer" aria-label="目录">
      <header class="toc-head">
        <h2 class="toc-title">目录</h2>
        <button class="zm-icon-btn toc-close" aria-label="收起目录" @click="close">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <nav class="toc-scroll">
        <button
          v-for="item in toc"
          :key="item.id"
          class="toc-item"
          :class="[`lv-${item.level}`, { 'is-current': item.id === currentTocId }]"
          :title="item.title"
          @click="go(item)"
        >
          <span
            class="toc-dot"
            :class="{ read: readerState.visitedSections.has(item.sectionId) }"
            aria-hidden="true"
          ></span>
          <span class="toc-text">{{ item.title }}</span>
        </button>
        <p v-if="!toc.length" class="toc-empty">本书没有章节标题。</p>
      </nav>
    </aside>
  </Transition>
</template>

<style scoped>
.toc-backdrop {
  display: none;
}

.toc-drawer {
  flex: none;
  width: var(--toc-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--drawer-bg);
  border-right: 1px solid var(--line);
  z-index: 20;
}

.toc-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 10px 10px 20px;
  border-bottom: 1px solid var(--line);
}

.toc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.2em;
}

.toc-close {
  width: 28px;
  height: 28px;
}

.toc-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 10px 30vh;
  overscroll-behavior: contain;
}

.toc-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.toc-item:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.toc-item.lv-1 {
  font-weight: 700;
  color: var(--text);
  margin-top: 6px;
}
.toc-item.lv-2 {
  padding-left: 22px;
}
.toc-item.lv-3 {
  padding-left: 36px;
  font-size: 12.5px;
}

.toc-item.is-current {
  color: var(--accent);
  background: var(--accent-soft);
}

.toc-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: transparent;
  transform: translateY(-2px);
}
.toc-dot.read {
  background: var(--text-3);
}
.toc-item.is-current .toc-dot {
  background: var(--accent);
}

.toc-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toc-empty {
  margin: 32px 10px;
  font-size: 13px;
  color: var(--text-3);
}

/* 窄窗：抽屉转浮层 */
@media (max-width: 1119px) {
  .toc-backdrop {
    display: block;
    position: fixed;
    inset: var(--toolbar-h) 0 0;
    background: rgba(20, 16, 12, 0.32);
    z-index: 19;
  }
  .toc-drawer {
    position: fixed;
    left: 0;
    top: var(--toolbar-h);
    bottom: 0;
    box-shadow: var(--shadow-soft);
  }
}

.toc-slide-enter-active,
.toc-slide-leave-active {
  transition:
    transform var(--dur-med) var(--ease-out),
    opacity var(--dur-med) var(--ease-out);
}
.toc-slide-enter-from,
.toc-slide-leave-to {
  transform: translateX(-16px);
  opacity: 0;
}

.toc-fade-enter-active,
.toc-fade-leave-active {
  transition: opacity var(--dur-med) var(--ease-out);
}
.toc-fade-enter-from,
.toc-fade-leave-to {
  opacity: 0;
}
</style>
