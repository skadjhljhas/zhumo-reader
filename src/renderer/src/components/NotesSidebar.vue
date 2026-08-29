<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 注释侧栏（340–400px，独立滚动）。
 *
 * - 注释卡按 notes 文档序排列；孤儿注释收在尾部折叠分组「未引用注释」。
 * - 联动（T14 重构，从「一次性事件」升级为「持续不变式」）：
 *   · 不变式：跟随激活且正文静止时，focus 卡在侧栏可见；
 *   · 快路径：focusNoteId 变化（followFastMs debounce）→ instant 定位
 *     （滚动进行中就开始跟随）；
 *   · 慢路径：正文滚动停稳（ReaderView 经 followCorrectionSeq 通知）→
 *     收敛校验，任一环失效即自愈（结构性消除 T13 P1 录屏失效类问题）；
 *   · 挂起/恢复：用户与侧栏交互（滚轮/滚动条/键盘滚动/卡片点击）挂起，
 *     与正文交互恢复——取代原 1s 时间窗，消除「手动滚动被拽回」与
 *     「1s 后突然滚走」（T13 P2）。
 *   · 跟随滚动一律 behavior:'instant'（T13 P3 迟滞消除）。
 * - 正文锚点点击（sidebarRequest）→ 挂起跟随 + 定位卡片并闪烁；孤儿组自动展开。
 * - 卡片点击 → 正文滚动到最近锚点；引用处条目点击 → 跳到指定锚点
 *   （T23）或定位父注卡（注内引用）；注内 sup 点击 → 侧栏内定位。
 *   三者均挂起跟随。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NoteCard from './NoteCard.vue'
import AppIcon from './AppIcon.vue'
import { bookState } from '../composables/useBook'
import {
  readerState,
  requestScroll,
  suspendFollow,
  nextFrames,
  type FollowCorrectionPhase
} from '../composables/readerStore'
import { READER_TUNING, isCardVisibleAt } from './reader-math'
import type { NoteRecord } from '../../../shared/types'

const listEl = ref<HTMLElement | null>(null)
const orphanOpen = ref(false)

const notes = computed<NoteRecord[]>(() => bookState.book?.notes ?? [])
const mainNotes = computed(() => notes.value.filter((n) => !n.orphan))
const orphanNotes = computed(() => notes.value.filter((n) => n.orphan))
const maxLevel = computed(() => bookState.book?.stats.maxLevel ?? 0)

function cardEl(noteId: string): HTMLElement | null {
  const root = listEl.value
  if (!root) return null
  return root.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`)
}

function flashCard(el: HTMLElement): void {
  el.classList.remove('is-flash')
  // 强制回流以重启动画
  void el.offsetWidth
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), 2200)
}

async function locateCard(noteId: string, flash: boolean): Promise<void> {
  // 孤儿卡可能在折叠组里，先展开
  const note = notes.value.find((n) => n.id === noteId)
  if (note?.orphan && !orphanOpen.value) {
    orphanOpen.value = true
    await nextTick()
  }
  const el = cardEl(noteId)
  if (!el) return
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  if (flash) flashCard(el)
}

/* ---------------- 侧栏跟随（T14：快/慢路径 + 挂起状态机） ---------------- */

let followTimer: number | null = null

/** 可见性判定：卡顶部 cardVisibleRatio 高度段进入侧栏视口即可见（数学见 reader-math） */
function isCardVisibleDom(el: HTMLElement): boolean {
  const root = listEl.value
  if (!root) return true
  const r = el.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  return isCardVisibleAt(
    r.top,
    r.bottom,
    rr.top,
    rr.bottom,
    READER_TUNING.cardVisibleRatio
  )
}

/** 布局静止探测（T14）：占位卡滚入视口后渲染异步，scrollHeight 会在多帧
 *  内持续变化；连续 followSettleStableFrames 帧不变（或达帧数上限）才静止。
 *  依 settle 复检才能避开「检查时恰好可见、布局稳定后又滑出」的假收敛。 */
async function awaitLayoutSettle(): Promise<void> {
  const root = listEl.value
  if (!root) {
    await nextFrames(2)
    return
  }
  let last = -1
  let same = 0
  for (let i = 0; i < READER_TUNING.followSettleFrames && same < READER_TUNING.followSettleStableFrames; i++) {
    await nextFrames(1)
    const h = root.scrollHeight
    if (h === last) {
      same++
    } else {
      same = 0
      last = h
    }
  }
}

/** 收敛校验（快/慢路径共用，滚动→静止→复检迭代）：跟随激活且 focus 卡
 *  不可见 → instant 滚入；v-html/字体/公式等异步布局可能使一次定位失效，
 *  等布局静止后复检直至可见。
 *  任一环失灵，下一次正文滚动停稳的校验即自愈；console.debug 默认
 *  不显示，为下次复现提供「未调用 vs 调用未生效」证据。 */
async function runFollowCorrection(phase: FollowCorrectionPhase | 'fast'): Promise<void> {
  for (let round = 1; round <= READER_TUNING.followSettleRounds; round++) {
    if (readerState.followSuspended) return
    const id = readerState.focusNoteId
    if (!id) return
    const el = cardEl(id)
    if (!el) return
    const root = listEl.value
    const before = root ? Math.round(root.scrollTop) : -1
    const visible = isCardVisibleDom(el)
    if (!visible) {
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
    console.debug('[zhumo-follow]', {
      phase,
      round,
      focusId: id,
      visible,
      before,
      after: root ? Math.round(root.scrollTop) : -1
    })
    if (visible) return // 上一轮滚动已历经布局静止复检，稳定可见
    await awaitLayoutSettle()
  }
}

/* 快路径：focusNoteId 变化 → followFastMs debounce → instant 定位（滚动中提前跟随） */
watch(
  () => readerState.focusNoteId,
  (id) => {
    if (!id) return
    if (followTimer !== null) window.clearTimeout(followTimer)
    followTimer = window.setTimeout(() => {
      followTimer = null
      void runFollowCorrection('fast')
    }, READER_TUNING.followFastMs)
  }
)

/* 慢路径：正文滚动停稳 / 用户与正文交互恢复跟随（ReaderView 经 seq 通知）→ 收敛兜底 */
watch(
  () => readerState.followCorrectionSeq,
  () => void runFollowCorrection(readerState.followCorrectionPhase)
)

/* ---------------- 挂起：侧栏用户交互事件（T14） ---------------- */

/** 滚动键：侧栏聚焦时按这些键会滚动侧栏列表（键盘滚动冒泡到滚动容器） */
const SCROLL_KEYS = new Set([
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  ' '
])

function onSidebarWheel(): void {
  suspendFollow()
}

/** 滚动条拖动：pointerdown 命中滚动条带（target 为容器自身且 X 越过 clientWidth） */
function onSidebarPointerDown(ev: PointerEvent): void {
  const el = listEl.value
  if (el && ev.target === el && ev.offsetX >= el.clientWidth) suspendFollow()
}

/** 侧栏聚焦时的键盘滚动（箭头/PageUp/PageDown/Home/End/空格） */
function onSidebarKeydown(ev: KeyboardEvent): void {
  const el = listEl.value
  if (el && el.contains(document.activeElement) && SCROLL_KEYS.has(ev.key)) {
    suspendFollow()
  }
}

onMounted(() => {
  const el = listEl.value
  if (!el) return
  el.addEventListener('wheel', onSidebarWheel, { passive: true })
  el.addEventListener('pointerdown', onSidebarPointerDown)
  el.addEventListener('keydown', onSidebarKeydown)
})

onBeforeUnmount(() => {
  const el = listEl.value
  if (el) {
    el.removeEventListener('wheel', onSidebarWheel)
    el.removeEventListener('pointerdown', onSidebarPointerDown)
    el.removeEventListener('keydown', onSidebarKeydown)
  }
  if (followTimer !== null) {
    window.clearTimeout(followTimer)
    followTimer = null
  }
})

/* 正文锚点点击 → 挂起跟随 + 侧栏定位 + 闪烁（用户主动定位：停留到正文交互为止） */
watch(
  () => readerState.sidebarRequest.seq,
  () => {
    const { noteId } = readerState.sidebarRequest
    if (noteId) {
      suspendFollow()
      void locateCard(noteId, true)
    }
  }
)

/** 卡片点击 / 引用处条目点击 → 挂起跟随 + 正文跳转（T11 确定性语义不变；
 *  T23：spot 指定时跳到该锚点，缺省跳最近锚点） */
function onLocate(noteId: string, spot?: { sectionId: string; order: number }): void {
  suspendFollow()
  requestScroll('note', noteId, undefined, spot)
}

/** 注内嵌套引用 → 侧栏内定位：同样视作用户定位，挂起跟随 */
function onNavigate(noteId: string): void {
  suspendFollow()
  void locateCard(noteId, true)
}

/** 孤儿组展开/收起也是侧栏交互：挂起跟随（用户在看的位置不滚走） */
function onOrphanToggle(): void {
  suspendFollow()
  orphanOpen.value = !orphanOpen.value
}
</script>

<template>
  <aside class="notes-sidebar" aria-label="注释侧栏">
    <header class="notes-head">
      <h2 class="notes-title">注释</h2>
      <span class="notes-meta">{{ notes.length }} 条 · 最深 {{ maxLevel }} 层</span>
    </header>

    <div ref="listEl" class="notes-scroll">
      <template v-if="mainNotes.length">
        <NoteCard
          v-for="n in mainNotes"
          :key="n.id"
          :note="n"
          :active="readerState.activeNoteIds.has(n.id)"
          :focused="readerState.focusNoteId === n.id"
          :cycle="n.cycle === true"
          :active-anchor="readerState.activeAnchor"
          @locate="onLocate"
          @navigate="onNavigate"
        />
      </template>

      <section v-if="orphanNotes.length" class="orphan-group">
        <button
          class="orphan-toggle"
          :aria-expanded="orphanOpen"
          @click="onOrphanToggle"
        >
          <AppIcon name="chevron" :size="13" class="orphan-chevron" :class="{ open: orphanOpen }" />
          未引用注释
          <span class="orphan-count">{{ orphanNotes.length }}</span>
        </button>
        <div v-show="orphanOpen" class="orphan-list">
          <NoteCard
            v-for="n in orphanNotes"
            :key="n.id"
            :note="n"
            :active="readerState.activeNoteIds.has(n.id)"
            :focused="readerState.focusNoteId === n.id"
            :cycle="n.cycle === true"
            :active-anchor="readerState.activeAnchor"
            @locate="onLocate"
            @navigate="onNavigate"
          />
        </div>
      </section>

      <p v-if="!notes.length" class="notes-empty">本书没有注释。</p>
    </div>
  </aside>
</template>

<style scoped>
.notes-sidebar {
  flex: none;
  width: var(--sidebar-w);
  min-width: 340px;
  max-width: 400px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  border-left: 1px solid var(--line);
}

.notes-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line);
}

.notes-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.2em;
}

.notes-meta {
  font-size: 11.5px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.notes-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 14px 40vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overscroll-behavior: contain;
}

.orphan-group {
  margin-top: 14px;
  border-top: 1px dashed var(--line-strong);
  padding-top: 10px;
}

.orphan-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 8px 6px;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--text-3);
  border-radius: 6px;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.orphan-toggle:hover {
  background: var(--hover-bg);
  color: var(--text-2);
}

.orphan-chevron {
  transition: transform var(--dur-fast) var(--ease-out);
}
.orphan-chevron.open {
  transform: rotate(180deg);
}

.orphan-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.orphan-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
}

.notes-empty {
  margin: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
}
</style>
