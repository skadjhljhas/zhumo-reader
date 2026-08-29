<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 底部状态栏（28px）。
 * 左：解析提示/警告汇总（可点击展开明细）；右：全书统计。
 */
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { bookState } from '../composables/useBook'
import type { ParseWarning } from '../../../shared/types'

const expanded = ref(false)

const warnings = computed<ParseWarning[]>(() => bookState.book?.warnings ?? [])
const stats = computed(() => bookState.book?.stats ?? null)

const KIND_LABEL: Record<ParseWarning['kind'], string> = {
  missing: '缺失定义',
  orphan: '未引用',
  duplicate: '重复定义',
  cycle: '循环引用',
  'level-cap': '层级截断',
  'parse-fallback': '降级渲染'
}

function kindLabel(w: ParseWarning): string {
  return KIND_LABEL[w.kind] ?? w.kind
}

function formatChars(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`
}
</script>

<template>
  <footer class="statusbar">
    <div class="sb-left">
      <button
        v-if="warnings.length"
        class="sb-warnings"
        :aria-expanded="expanded"
        aria-label="查看解析提示"
        @click="expanded = !expanded"
      >
        <AppIcon name="warning" :size="13" />
        <span>{{ warnings.length }} 条解析提示</span>
      </button>
      <span v-else-if="bookState.statusMessage" class="sb-message">{{
        bookState.statusMessage
      }}</span>
      <span v-else class="sb-ok">解析正常</span>
    </div>

    <div v-if="stats" class="sb-right">
      <span>{{ formatChars(stats.chars) }}</span>
      <span class="sb-sep" aria-hidden="true"></span>
      <span>注释 {{ stats.noteCount }}</span>
      <span class="sb-sep" aria-hidden="true"></span>
      <span>最深 {{ stats.maxLevel }} 层</span>
    </div>

    <Transition name="sb-pop">
      <div v-if="expanded && warnings.length" class="sb-popover" role="status">
        <ul class="sb-warning-list">
          <li v-for="(w, i) in warnings" :key="i" class="sb-warning-item">
            <span class="sb-warning-kind">{{ kindLabel(w) }}</span>
            <span class="sb-warning-text">{{ w.message }}</span>
          </li>
        </ul>
      </div>
    </Transition>
  </footer>
</template>

<style scoped>
.statusbar {
  position: relative;
  flex: none;
  height: var(--statusbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-top: 1px solid var(--line);
  background: var(--bg);
  font-size: 11.5px;
  color: var(--text-3);
  z-index: 30;
  user-select: none;
}

.sb-left {
  display: flex;
  align-items: center;
  min-width: 0;
}

.sb-warnings {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  margin-left: -8px;
  border-radius: 5px;
  color: var(--accent);
  font-size: 11.5px;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.sb-warnings:hover {
  background: var(--accent-soft);
}

.sb-message,
.sb-ok {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-right {
  display: flex;
  align-items: center;
  gap: 10px;
  font-variant-numeric: tabular-nums;
}

.sb-sep {
  width: 1px;
  height: 10px;
  background: var(--line-strong);
}

.sb-popover {
  position: absolute;
  left: 10px;
  bottom: calc(var(--statusbar-h) + 6px);
  width: min(520px, calc(100vw - 40px));
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-soft);
  padding: 8px;
}

.sb-warning-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.sb-warning-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.sb-warning-item:hover {
  background: var(--hover-bg);
}

.sb-warning-kind {
  flex: none;
  color: var(--accent);
  font-size: 11px;
}

.sb-warning-text {
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.sb-pop-enter-active,
.sb-pop-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.sb-pop-enter-from,
.sb-pop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
