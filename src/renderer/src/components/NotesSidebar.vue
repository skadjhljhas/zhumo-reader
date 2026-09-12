<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 注释侧栏（340–400px，独立滚动）。
 *
 * - 注释卡按 notes 文档序排列；孤儿注释收在尾部折叠分组「未引用注释」。
 * - 联动（T14 重构，从「一次性事件」升级为「持续不变式」）：
 *   · 不变式：跟随激活且正文静止时，focus 卡在侧栏可见；
 *   · 快路径：focusNoteId 变化（followFastMs debounce）→ glide 平滑定位
 *     （滚动进行中就开始跟随；单 rAF 临界阻尼弹簧插值，可被打断、不叠加）；
 *   · 慢路径：正文滚动停稳（ReaderView 经 followCorrectionSeq 通知）→
 *     收敛校验，任一环失效即自愈（结构性消除 T13 P1 录屏失效类问题）；
 *   · 挂起/恢复：用户与侧栏交互（滚轮/滚动条/键盘滚动/卡片点击）挂起，
 *     与正文交互恢复——取代原 1s 时间窗，消除「手动滚动被拽回」与
 *     「1s 后突然滚走」（T13 P2）。
 *   · 跟随滚动走 glide 平滑通道（T24）：收敛校验的 instant 瞬移改为可打断的
 *     弹簧插值，消除「悬停靠齐后一滚就跳」；停靠布局进出的视口位移同步补偿。
 * - 正文锚点点击（sidebarRequest）→ 挂起跟随 + 定位卡片并闪烁；孤儿组自动展开。
 * - 明确的引用处条目跳到正文锚点或父注中的引用段落；注内 sup 在侧栏内定位。
 *   注释阅读路径保存离开位置与筛选范围，支持返回和前进；侧栏交互挂起跟随。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NoteCard from './NoteCard.vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import AppIcon from './AppIcon.vue'
import StudioIcon from './StudioIcon.vue'
import { studio } from '../composables/useStudio'
import { noteHoverGuide, clearNoteHoverGuide } from '../composables/noteHoverGuide'
import {
  enterNote,
  retainJourneyLabels,
  noteChildren,
  reachableNotes,
  type NotePlace,
  type NoteVisit
} from '../composables/noteJourney'
import { searchBlocks } from '../composables/searchText'
import { paintSearchMatch, type SearchMatchLocation } from '../composables/searchLanding'
import type { SourcePlace } from '../composables/sourcePosition'
import { documentSession } from '../composables/documentSession'
import { bookState } from '../composables/useBook'
import {
  readerState,
  requestScroll,
  suspendFollow,
  resumeFollow,
  nextFrames,
  type FollowCorrectionPhase
} from '../composables/readerStore'
import {
  READER_TUNING,
  glideFrame,
  glideSpeedCap,
  isCardVisibleAt,
  nearestScrollDelta,
  type GlideTuning
} from './reader-math'
import type { NoteRecord } from '../../../shared/types'

let resizeStart = 0,
  resizeWidth = 0
function startResize(event: PointerEvent): void {
  suspendFollow()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  resizeStart = event.clientX
  resizeWidth = studio.noteWidth
  document.body.classList.add('resizing-notes')
}
function resize(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement
  if (!target.hasPointerCapture(event.pointerId)) return
  studio.noteWidth = Math.max(280, Math.min(640, resizeWidth + resizeStart - event.clientX))
}
function finishResize(): void {
  document.body.classList.remove('resizing-notes')
}
const listEl = ref<HTMLElement | null>(null)
const hoverSpace = ref(0)
const parkedHoverNoteId = ref('')
/** 停靠对齐的「算目标」rAF 句柄与代际令牌（位移本身由共享 glide 承担，T25） */
let hoverFrame = 0,
  hoverSequence = 0
let hoverSizeObserver: ResizeObserver | undefined
const journeyEl = ref<HTMLOListElement | null>(null)
const orphanOpen = ref(false)

const notes = computed<NoteRecord[]>(() => bookState.book?.notes ?? [])
const byId = computed(() => new Map(notes.value.map((note) => [note.id, note])))
const byLabel = computed(() => new Map(notes.value.map((note) => [note.label, note])))
const children = computed(() => noteChildren(notes.value))
const chapterNotes = computed(() => {
  const roots = new Set<string>()
  for (const note of notes.value)
    if (
      note.anchorSpots.some(
        (spot) =>
          spot.kind !== 'note' &&
          (readerState.currentHeadingId && spot.headingId
            ? spot.headingId === readerState.currentHeadingId
            : spot.sectionId === readerState.currentSectionId)
      )
    )
      roots.add(note.id)
  return reachableNotes(children.value, roots)
})
const journey = computed(() => studio.noteJourney)
const currentVisit = computed(() => journey.value.visits[journey.value.index])
const journeySteps = computed(() =>
  journey.value.visits.map((visit, index) => ({
    index,
    label: visit.label,
    mark: byLabel.value.get(visit.label)?.displayMark ?? visit.label,
    type: byLabel.value.get(visit.label)?.typeLabel ?? ''
  }))
)
let navigationToken = 0
watch(notes, () => retainJourneyLabels(journey.value, new Set(byLabel.value.keys())), {
  immediate: true
})
watch(
  () => journey.value.index,
  async () => {
    await nextTick()
    const root = journeyEl.value,
      current = root?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!root || !current) return
    const boundary = root.getBoundingClientRect(),
      rect = current.getBoundingClientRect()
    if (rect.right > boundary.right) root.scrollLeft += rect.right - boundary.right + 4
    else if (rect.left < boundary.left) root.scrollLeft += rect.left - boundary.left - 4
  }
)

const filtered = computed(() =>
  notes.value.filter((n) => {
    if (noteHoverGuide.value?.noteId === n.id || parkedHoverNoteId.value === n.id) return true
    if (studio.notesTab === 'pinned') return studio.pinnedLabels.has(n.label)
    if (studio.notesTab === 'focus') return chapterNotes.value.has(n.id)
    return true
  })
)
const mainNotes = computed(() =>
  filtered.value.filter((n) => studio.notesTab !== 'all' || !n.orphan)
)
const followPaused = computed(
  () =>
    Boolean(noteHoverGuide.value) ||
    studio.explicitFollowPause ||
    readerState.followSuspended ||
    studio.notesTab === 'pinned'
)
function toggleFollow(): void {
  parkedHoverNoteId.value = ''
  studio.explicitFollowPause = !followPaused.value
  if (!studio.explicitFollowPause) {
    if (studio.notesTab === 'pinned') studio.notesTab = 'all'
    resumeFollow()
    void runFollowCorrection('fast')
  }
}
function travel(index: number): void {
  if (index < 0 || index >= journey.value.visits.length) return
  const note = byLabel.value.get(journey.value.visits[index].label)
  if (!note) return
  suspendFollow()
  void locateCard(note.id, true, { visitIndex: index })
}

const orphanNotes = computed(() => notes.value.filter((n) => n.orphan))
const visibleNotes = computed(() =>
  studio.notesTab === 'all' && orphanOpen.value
    ? [...mainNotes.value, ...orphanNotes.value]
    : mainNotes.value
)
const virtualized = computed(() => visibleNotes.value.length > 80)
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: visibleNotes.value.length,
    getScrollElement: () => listEl.value,
    estimateSize: () => 240,
    getItemKey: (index: number) => visibleNotes.value[index].id,
    overscan: 5,
    paddingStart: hoverSpace.value,
    paddingEnd: hoverSpace.value,
    enabled: virtualized.value
  }))
)
const visibleRows = computed(() =>
  virtualized.value
    ? virtualizer.value
        .getVirtualItems()
        .map((row) => ({ index: row.index, start: row.start, note: visibleNotes.value[row.index] }))
    : visibleNotes.value.map((note, index) => ({ index, start: 0, note }))
)
function measureRow(node: unknown): void {
  if (virtualized.value && node instanceof HTMLElement) virtualizer.value.measureElement(node)
}
async function ensureRendered(
  noteId: string,
  valid: () => boolean = () => true,
  smooth = false
): Promise<void> {
  if (!virtualized.value || cardEl(noteId)) return
  const index = visibleNotes.value.findIndex((note) => note.id === noteId)
  if (index < 0) return
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!listEl.value || !valid() || cardEl(noteId)) return
    // Keep one cancellable locator; the seek also starts its own asynchronous search.
    const offset = virtualizer.value.getOffsetForIndex(index, 'start')?.[0]
    if (offset === undefined) return
    // 跟随路径（smooth）走 glide：虚拟化列表不再瞬移到估算位，途中即渲染目标卡
    if (smooth) await glideTo(offset)
    else writeSidebarScroll(listEl.value, offset, 'seek')
    await nextTick()
    await nextFrames(2)
  }
}
watch(
  () => [studio.noteWidth, studio.noteFontSize],
  () => {
    if (virtualized.value) virtualizer.value.measure()
  }
)

function cardEl(noteId: string): HTMLElement | null {
  const root = listEl.value
  if (!root) return null
  return root.querySelector(`.note-card[data-note-id="${CSS.escape(noteId)}"]`)
}

/** 侧栏 scrollTop 的唯一写出口（T25）：停靠对齐、跟随 glide、padding/视口
 *  补偿三套逻辑交接处的跳变，只能靠「谁在哪一帧把列表挪了多少」定位。
 *  console.debug 默认不显示；foreign 为上次写入之后被本模块之外改动的量
 *  （浏览器滚动锚定、用户滚轮、虚拟化重量测），非零即说明有第二个写入者。 */
let lastScrollWrite = Number.NaN
function writeSidebarScroll(
  root: HTMLElement,
  to: number,
  where: string,
  extra?: Record<string, number>
): void {
  const from = root.scrollTop
  // foreign：上次写入之后被本模块之外改动的量（滚动锚定 / 用户滚轮 / 虚拟化重量测）
  const foreign = Number.isFinite(lastScrollWrite) ? from - lastScrollWrite : 0
  root.scrollTop = to
  const applied = root.scrollTop
  lastScrollWrite = applied
  if (Math.abs(applied - from) < 0.5 && !extra) return
  console.debug(
    '[zhumo-scroll] ' +
      JSON.stringify({
        where,
      t: Math.round(performance.now() * 10) / 10,
      from: Math.round(from * 10) / 10,
      to: Math.round(to * 10) / 10,
      applied: Math.round(applied * 10) / 10,
      step: Math.round((applied - from) * 10) / 10,
        foreign: Math.round(foreign * 10) / 10,
        ...extra
      })
  )
}

/** Keep room to align even the first/last note. Compensate the added space so
 * enabling the mode does not itself move visible note text.
 *  留白取「整栏」高度而不是 .notes-scroll 的 clientHeight（T25）：停靠布局
 *  开关会让 .notes-scroll 在 737↔866 之间变高，留白若跟着变，paddingStart/End
 *  就要在开关那一帧各改 129px，与虚拟列表的重量测互相打架。整栏高度两态一致，
 *  留白因此对停靠开关免疫，只在窗口/字号/栏目宽度真变化时才动。 */
async function resizeHoverSpace(): Promise<void> {
  const root = listEl.value
  if (!root) return
  const column = root.parentElement ?? root
  const next = studio.hoverNotes || !visibleNotes.value.length ? 0 : column.clientHeight
  const delta = next - hoverSpace.value
  if (!delta) return
  const before = root.scrollTop
  hoverSpace.value = next
  await nextTick()
  if (root !== listEl.value) return
  // await 期间在途 glide / 浏览器都可能已经挪过 scrollTop：按「还差多少」补偿，
  // 不用 await 之前的旧值做绝对定位（那会吃掉这期间 glide 的进度，造成回跳）。
  const drift = root.scrollTop - before
  const need = delta - drift
  if (Math.abs(need) >= 0.5)
    writeSidebarScroll(root, Math.max(0, root.scrollTop + need), 'hoverSpace', {
      delta,
      drift: Math.round(drift * 10) / 10,
      need: Math.round(need * 10) / 10
    })
  shiftGlide(delta)
}
/** 停掉停靠的「算目标」循环；不打断在途 glide（T25：glide 是共享通道，
 *  停靠让位由下一次 retargetGlide 的 owner 切换完成，而不是 stopGlide 抢权） */
function stopHoverAlignment(): void {
  hoverSequence++
  cancelAnimationFrame(hoverFrame)
  hoverFrame = 0
}
async function startHoverAlignment(): Promise<void> {
  stopHoverAlignment()
  // T25：不再 stopGlide() 抢权。停靠对齐与跟随共用同一条弹簧，交接只是换目标。
  const guide = noteHoverGuide.value,
    root = listEl.value
  if (!root) return
  if (guide) {
    parkedHoverNoteId.value = guide.noteId
    suspendFollow()
  }
  const own = hoverSequence
  // 停靠布局（is-hover-guiding）进出的视口位移由 hoverGuiding 监听统一补偿
  await nextTick()
  if (own !== hoverSequence || root !== listEl.value) return
  await resizeHoverSpace()
  if (!guide || studio.hoverNotes) return
  // Supersede a pending click/keyboard seek, without creating a reading-history visit.
  navigationToken++
  await resizeHoverSpace()
  await nextTick()
  if (own !== hoverSequence || guide !== noteHoverGuide.value) return
  function tick(): void {
    if (
      own !== hoverSequence ||
      guide !== noteHoverGuide.value ||
      !root ||
      !guide ||
      root !== listEl.value ||
      !guide.origin.isConnected ||
      studio.hoverNotes
    ) {
      hoverFrame = 0
      return
    }
    const anchor = guide.origin.querySelector('.zmu-ref-mark') ?? guide.origin
    const mark = anchor.getBoundingClientRect(),
      bounds = root.getBoundingClientRect()
    const card = cardEl(guide.noteId),
      badge = card?.querySelector('.note-mark')?.getBoundingClientRect()
    const desired = Math.max(
      bounds.top + 1,
      Math.min(bounds.bottom - 1, mark.top + mark.height / 2)
    )
    let target: number | undefined
    if (badge) target = root.scrollTop + badge.top + badge.height / 2 - desired
    else if (virtualized.value) {
      const index = visibleNotes.value.findIndex((note) => note.id === guide.noteId)
      const offset =
        index >= 0 ? virtualizer.value.getOffsetForIndex(index, 'start')?.[0] : undefined
      if (offset !== undefined) target = offset + 28 - (desired - bounds.top)
    }
    // T25：这里只回答「这一帧该对齐到哪」，位移一律交给共享 glide。
    // 目标每帧替换、位置与速度连续，因此「指针停在注号上滚轮 → 导引被清空 →
    // 重新命中 → 再次停靠」的反复重新停靠也走同一条平滑通道，不再重启动画。
    if (target !== undefined) retargetGlide(target, 'hover', hoverGlideTuning)
    hoverFrame = requestAnimationFrame(tick)
  }
  hoverFrame = requestAnimationFrame(tick)
}
watch(noteHoverGuide, startHoverAlignment)
watch(
  () => visibleNotes.value.length,
  () => {
    void resizeHoverSpace()
  }
)
watch(
  () => studio.hoverNotes,
  () => {
    parkedHoverNoteId.value = ''
    stopHoverAlignment()
    stopGlide() // 用户主动切换注释呈现方式：在途停靠/跟随动画立即让位
    void resizeHoverSpace()
  }
)
watch(
  () => readerState.followSuspended,
  (suspended) => {
    if (!suspended) parkedHoverNoteId.value = ''
  }
)
watch(
  () => studio.notesTab,
  () => {
    parkedHoverNoteId.value = ''
  }
)

/** 停靠布局开关：is-hover-guiding 让头部/工具/路径整块让位，.notes-scroll 由
 *  「头部之下的 flex:1」长满整栏，视口顶瞬移约一个头部高度（实测 129px）。
 *  统一在布局切换前后补偿 scrollTop，并同步平移在途 glide，使屏幕上内容不动。 */
const hoverGuiding = computed(
  () => Boolean(noteHoverGuide.value) || Boolean(parkedHoverNoteId.value)
)
watch(hoverGuiding, async () => {
  const root = listEl.value
  if (!root) return
  const previousTop = root.getBoundingClientRect().top
  await nextTick()
  if (root !== listEl.value) return
  const delta = root.getBoundingClientRect().top - previousTop
  if (!delta) return
  writeSidebarScroll(root, root.scrollTop + delta, 'hoverGuiding', { delta })
  shiftGlide(delta)
})

function flashCard(el: HTMLElement): void {
  el.classList.remove('is-flash')
  // 强制回流以重启动画
  void el.offsetWidth
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), 2200)
}

function capturePlace(noteId: string, origin?: Element): NotePlace | null {
  const card = cardEl(noteId),
    root = listEl.value
  if (!card || !root) return null
  const boundary = root.getBoundingClientRect(),
    rect = card.getBoundingClientRect()
  if (rect.bottom <= boundary.top || rect.top >= boundary.bottom) return null
  const blocks = searchBlocks(card.querySelector('.zmu-note-body') ?? card)
  let blockIndex = origin ? blocks.findIndex((block) => block.contains(origin)) : -1
  if (blockIndex < 0)
    blockIndex = blocks.findIndex(
      (block) => block.getBoundingClientRect().bottom > boundary.top + 24
    )
  const block = blocks[blockIndex]?.getBoundingClientRect()
  return {
    blockIndex,
    offset: block ? block.top - boundary.top : 0,
    height: block?.height ?? 0,
    cardOffset: rect.top - boundary.top
  }
}
function saveCurrentPlace(): void {
  const visit = currentVisit.value
  const note = visit && byLabel.value.get(visit.label)
  if (!visit || !note) return
  const place = capturePlace(note.id)
  if (place) {
    visit.place = place
    visit.scope = studio.notesTab
  }
}
function rememberDeparture(fromNoteId?: string, origin?: Element): void {
  const root = listEl.value
  const boundary = root?.getBoundingClientRect()
  const visible =
    root && boundary
      ? [...root.querySelectorAll<HTMLElement>('.note-card')].find(
          (card) =>
            card.getBoundingClientRect().bottom > boundary.top + 24 &&
            card.getBoundingClientRect().top < boundary.bottom
        )
      : null
  const note = byId.value.get(fromNoteId ?? visible?.dataset.noteId ?? '')
  if (note)
    enterNote(journey.value, {
      label: note.label,
      scope: studio.notesTab,
      place: capturePlace(note.id, origin)
    })
  else saveCurrentPlace()
}
async function locateCard(
  noteId: string,
  flash: boolean,
  options: {
    visitIndex?: number
    fromNoteId?: string
    origin?: Element
    referenceTo?: string
    blockIndex?: number
    match?: SearchMatchLocation
    source?: SourcePlace
  } = {}
): Promise<void> {
  const note = byId.value.get(noteId)
  if (!note) return
  const token = ++navigationToken
  stopGlide() // 用户主动定位直接接管滚动，在途 glide 让位
  const moveFocus = document.activeElement?.closest('.notes-scroll') !== null
  let visit: NoteVisit
  if (options.visitIndex !== undefined) {
    saveCurrentPlace()
    journey.value.index = options.visitIndex
    visit = journey.value.visits[options.visitIndex]
    studio.notesTab = visit.scope
  } else {
    rememberDeparture(options.fromNoteId, options.origin)
    visit = { label: note.label, scope: studio.notesTab, place: null }
    enterNote(journey.value, visit)
  }
  if (!filtered.value.some((n) => n.id === noteId)) studio.notesTab = 'all'
  visit.scope = studio.notesTab
  await nextTick()
  if (token !== navigationToken) return
  // 孤儿卡可能在折叠组里，先展开
  if (note?.orphan && !orphanOpen.value) {
    orphanOpen.value = true
    await nextTick()
  }
  await ensureRendered(noteId, () => token === navigationToken)
  await document.fonts.ready
  if (token !== navigationToken) return
  const el = cardEl(noteId)
  if (!el) return
  let matchedRect: (() => DOMRect | undefined) | undefined
  for (let round = 0; round < 5; round++) {
    const root = listEl.value
    if (!root || !el.isConnected || token !== navigationToken) return
    const rootTop = root.getBoundingClientRect().top
    let target: Element = el,
      offset = 12
    if (options.source) {
      const source = options.source
      target =
        source.block.key === 'row'
          ? el
          : (el.querySelector('[data-source-block="' + CSS.escape(source.block.key) + '"]') ?? el)
      offset =
        root.clientHeight * source.viewport - target.getBoundingClientRect().height * source.ratio
    } else if (visit.place) {
      const place = visit.place
      const block = searchBlocks(el.querySelector('.zmu-note-body') ?? el)[place.blockIndex]
      target = block ?? el
      offset = block ? place.offset : place.cardOffset
      if (block && offset < 0 && place.height > 0)
        offset *= block.getBoundingClientRect().height / place.height
    } else if (options.blockIndex !== undefined) {
      target =
        searchBlocks(el.querySelector('.zmu-note-body') ?? el, Boolean(options.match))[
          options.blockIndex
        ] ?? el
      offset = 32
      if (round === 0) matchedRect = paintSearchMatch(target, options.match)
    } else if (options.referenceTo) {
      target =
        el
          .querySelector(`.zmu-ref[data-note-id="${CSS.escape(options.referenceTo)}"]`)
          ?.closest('p,li') ?? el
      offset = 80
    }
    const delta = (matchedRect?.()?.top ?? target.getBoundingClientRect().top) - rootTop - offset
    if (round > 0 && Math.abs(delta) < 1) break
    writeSidebarScroll(root, root.scrollTop + delta, 'locate', { round })
    await nextFrames(2)
  }
  if (token !== navigationToken) return
  if (moveFocus) el.focus({ preventScroll: true })
  visit.place = capturePlace(noteId)
  if (flash) flashCard(el)
}

/* ---------------- 侧栏跟随（T14：快/慢路径 + 挂起状态机） ---------------- */

let followTimer: number | null = null
/** 收敛校验令牌（T24）：新一次校验使在途校验循环作废，避免 glide 期间循环堆积 */
let followCorrectionToken = 0

/* ---------------- 平滑跟随（glide，T24）：单 rAF 循环、可打断、不叠加 ---------------- */

const glideTuning: GlideTuning = {
  omega: READER_TUNING.followGlideOmega,
  maxSpeed: READER_TUNING.followGlideMaxSpeed,
  maxMs: READER_TUNING.followGlideMaxMs,
  snapPx: READER_TUNING.followGlideSnapPx
}
/** 停靠对齐用同一套弹簧、更柔的调参（T25）：慢而连续，落位手感由用户认可 */
const hoverGlideTuning: GlideTuning = {
  omega: READER_TUNING.hoverGlideOmega,
  maxSpeed: READER_TUNING.hoverGlideMaxSpeed,
  maxMs: READER_TUNING.hoverGlideMaxMs,
  snapPx: READER_TUNING.followGlideSnapPx
}
/** 当前占用平滑通道的一方；换人只换目标与调参，运动本身不中断 */
let glideOwner: 'follow' | 'hover' = 'follow'
let glideTuningActive: GlideTuning = glideTuning
let glideFrameId = 0
/** 动画亚像素位置/速度（px/ms）；循环未运行时位置以 scrollTop 为准 */
let glidePos = 0
let glideVel = 0
let glideTarget = 0
let glideLast = 0
let glideWaiters: (() => void)[] = []

function motionReduced(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

function releaseGlideWaiters(): void {
  const waiters = glideWaiters
  glideWaiters = []
  for (const resolve of waiters) resolve()
}

/** 结束 glide 循环：用户交互打断、直接定位、卸载时调用（等待者一并放行） */
function stopGlide(): void {
  if (glideFrameId) cancelAnimationFrame(glideFrameId)
  glideFrameId = 0
  glideVel = 0
  glideLast = 0
  releaseGlideWaiters()
}

/** 内容坐标整体平移（padding/视口补偿）时同步平移在途 glide，保持同一视觉目标 */
function shiftGlide(delta: number): void {
  if (!glideFrameId || !delta) return
  glidePos += delta
  glideTarget += delta
}

function glideTick(now: number): void {
  const root = listEl.value
  if (!root) {
    stopGlide()
    return
  }
  // 时间步双重夹取（T25，见 READER_TUNING）：① glideMaxFrameMs——长帧不让弹簧
  // 按真实 dt 一步跨过去；② glideMaxStepPx / cap——单帧屏幕位移有与目标距离
  // 无关的硬上界。只夹 dt，不改 glideFrame：纯函数的帧率无关单测原样保留。
  const cap = glideSpeedCap(glidePos - glideTarget, glideTuningActive)
  const dt = glideLast
    ? Math.min(READER_TUNING.glideMaxFrameMs, READER_TUNING.glideMaxStepPx / cap, now - glideLast)
    : 16
  glideLast = now
  const frame = glideFrame(glidePos, glideVel, glideTarget, dt, glideTuningActive)
  glidePos = frame.position
  glideVel = frame.velocity
  writeSidebarScroll(root, frame.position, 'glide', {
    target: Math.round(glideTarget * 10) / 10,
    vel: Math.round(glideVel * 100) / 100,
    dt
  })
  if (frame.settled) {
    stopGlide()
    return
  }
  glideFrameId = requestAnimationFrame(glideTick)
}

/** 把目标提交给共享平滑通道（T25）：在途则只替换目标（位置与速度连续，
 *  不回摆、不叠加、不重启），空闲则从当前 scrollTop 重新起振。owner 变更时
 *  放行上一占用者的 await（它已不再拥有这次落位），但动画不中断——停靠与
 *  跟随的交接因此是「同一条弹簧换目标」，而不是「停掉再抢写 scrollTop」。 */
function retargetGlide(target: number, owner: 'follow' | 'hover', tuning: GlideTuning): void {
  const root = listEl.value
  if (!root) return
  const max = Math.max(0, root.scrollHeight - root.clientHeight)
  const to = Math.min(max, Math.max(0, target))
  if (!glideFrameId) {
    glidePos = root.scrollTop
    glideVel = 0
  }
  if (glideOwner !== owner) {
    glideOwner = owner
    releaseGlideWaiters()
  }
  glideTuningActive = tuning
  if (motionReduced()) {
    stopGlide()
    writeSidebarScroll(root, to, 'glideReduced')
    return
  }
  glideTarget = to
  if (Math.abs(to - glidePos) <= tuning.snapPx) {
    // scrollTop 按像素量化：已在吸附阈内就不再起振、也不重复写（精确落位由
    // glideFrame 的 settled 分支负责），否则停靠对齐完成后会每帧空转一次
    return
  }
  if (!glideFrameId) {
    glideLast = 0
    glideFrameId = requestAnimationFrame(glideTick)
  }
}

/** 平滑滚到目标 scrollTop（跟随/虚拟化 seek 路径）：新目标打断旧动画并从当前
 *  位置重新插值；返回的 Promise 在本次 glide 落位或被取代/打断时 resolve */
function glideTo(target: number): Promise<void> {
  return new Promise<void>((resolve) => {
    retargetGlide(target, 'follow', glideTuning)
    if (glideFrameId) glideWaiters.push(resolve)
    else resolve()
  })
}

/** 可见性判定：卡顶部 cardVisibleRatio 高度段进入侧栏视口即可见（数学见 reader-math） */
function isCardVisibleDom(el: HTMLElement): boolean {
  const root = listEl.value
  if (!root) return true
  const r = el.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  return isCardVisibleAt(r.top, r.bottom, rr.top, rr.bottom, READER_TUNING.cardVisibleRatio)
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
  for (
    let i = 0;
    i < READER_TUNING.followSettleFrames && same < READER_TUNING.followSettleStableFrames;
    i++
  ) {
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
  const token = ++followCorrectionToken
  for (let round = 1; round <= READER_TUNING.followSettleRounds; round++) {
    if (token !== followCorrectionToken) return // 被更新的校验取代（glide 期间不堆积）
    if (
      readerState.followSuspended ||
      noteHoverGuide.value ||
      studio.explicitFollowPause ||
      studio.notesTab === 'pinned' ||
      documentSession.mode === 'edit'
    )
      return
    const id = readerState.focusNoteId
    if (!id) return
    await ensureRendered(
      id,
      () =>
        token === followCorrectionToken && !followPaused.value && readerState.focusNoteId === id,
      true
    )
    if (token !== followCorrectionToken || followPaused.value || readerState.focusNoteId !== id)
      return
    const el = cardEl(id)
    if (!el) return
    const root = listEl.value
    if (!root) return
    const before = Math.round(root.scrollTop)
    const visible = isCardVisibleDom(el)
    if (!visible) {
      // T24：instant 瞬移 → glide 平滑插值（目标与 scrollIntoView nearest 同语义）
      const bounds = root.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      const delta = nearestScrollDelta(
        rect.top - bounds.top,
        rect.bottom - bounds.top,
        root.clientHeight
      )
      await glideTo(root.scrollTop + delta)
    }
    console.debug('[zhumo-follow]', {
      phase,
      round,
      focusId: id,
      visible,
      before,
      after: Math.round(root.scrollTop)
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
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

function onSidebarWheel(): void {
  parkedHoverNoteId.value = ''
  clearNoteHoverGuide()
  navigationToken++
  stopGlide() // 用户滚动打断在途自动定位（文档承诺：鼠标/键盘滚动可中断）
  suspendFollow()
}

/** Selecting text and dragging the scrollbar both keep the sidebar at the reader's chosen place. */
function onSidebarPointerDown(ev: PointerEvent): void {
  const el = listEl.value
  if (el && ev.target instanceof Node && el.contains(ev.target)) {
    parkedHoverNoteId.value = ''
    clearNoteHoverGuide()
    navigationToken++
    stopGlide()
    suspendFollow()
  }
}

/** 侧栏聚焦时的键盘滚动（箭头/PageUp/PageDown/Home/End/空格） */
async function settleKeyboardEdge(end: boolean, token: number): Promise<void> {
  const root = listEl.value,
    snapshot = visibleNotes.value
  if (!root || !snapshot.length) return
  const id = snapshot[end ? snapshot.length - 1 : 0].id
  const valid = (): boolean =>
    token === navigationToken && root === listEl.value && snapshot === visibleNotes.value
  const destination = (): number => {
    if (!end) return hoverSpace.value
    const padding = parseFloat(getComputedStyle(root).paddingBottom) || 0
    return Math.max(
      hoverSpace.value,
      root.scrollHeight - root.clientHeight - hoverSpace.value - Math.max(0, padding - 24)
    )
  }
  let stable = 0,
    previousHeight = -1
  // Keep the last content above the viewport edge instead of ending in the
  // alignment spacer. Estimated row heights settle under the same cancellable request.
  for (let attempt = 0; attempt < 40 && valid(); attempt++) {
    writeSidebarScroll(root, destination(), 'keyboardEdge')
    await nextTick()
    await nextFrames(2)
    if (!valid()) return
    const height = root.scrollHeight
    const atEdge = Math.abs(root.scrollTop - destination()) < 2
    stable =
      atEdge && cardEl(id) && height === previousHeight && document.fonts.status !== 'loading'
        ? stable + 1
        : 0
    if (stable >= 3) return
    previousHeight = height
  }
}

function onSidebarKeydown(ev: KeyboardEvent): void {
  if (ev.defaultPrevented) return
  const el = listEl.value
  if (el && el.contains(document.activeElement) && SCROLL_KEYS.has(ev.key)) {
    parkedHoverNoteId.value = ''
    clearNoteHoverGuide()
    navigationToken++
    stopGlide()
    suspendFollow()
    if (
      virtualized.value &&
      (ev.ctrlKey || ev.metaKey) &&
      !ev.shiftKey &&
      !ev.altKey &&
      (ev.key === 'Home' || ev.key === 'End')
    ) {
      ev.preventDefault()
      void settleKeyboardEdge(ev.key === 'End', navigationToken)
    }
  }
}

onMounted(() => {
  const el = listEl.value
  if (!el) return
  hoverSizeObserver = new ResizeObserver(() => {
    void resizeHoverSpace()
  })
  hoverSizeObserver.observe(el)
  void resizeHoverSpace()
  if (noteHoverGuide.value) void startHoverAlignment()
  el.addEventListener('wheel', onSidebarWheel, { passive: true })
  el.addEventListener('pointerdown', onSidebarPointerDown)
  el.addEventListener('keydown', onSidebarKeydown)
  const note = currentVisit.value && byLabel.value.get(currentVisit.value.label)
  if (note && currentVisit.value.place)
    void locateCard(note.id, false, { visitIndex: journey.value.index })
})

onBeforeUnmount(() => {
  stopHoverAlignment()
  stopGlide()
  hoverSizeObserver?.disconnect()
  saveCurrentPlace()
  navigationToken++
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
    const { noteId, blockIndex, match, source } = readerState.sidebarRequest
    if (noteId) {
      suspendFollow()
      void locateCard(noteId, !source, { blockIndex, match, source })
    }
  }
)

/** 引用处条目点击 → 挂起跟随 + 正文跳转（T11 确定性语义不变；
 *  T23：spot 指定时跳到该锚点，缺省跳最近锚点） */
function onLocate(noteId: string, spot?: { sectionId: string; order: number }): void {
  suspendFollow()
  requestScroll('note', noteId, undefined, spot)
}

/** 注内嵌套引用 → 侧栏内定位：同样视作用户定位，挂起跟随 */
function onNavigate(
  noteId: string,
  fromNoteId?: string,
  origin?: Element,
  referenceTo?: string
): void {
  suspendFollow()
  void locateCard(noteId, true, { fromNoteId, origin, referenceTo })
}

/** 孤儿组展开/收起也是侧栏交互：挂起跟随（用户在看的位置不滚走） */
function onOrphanToggle(): void {
  suspendFollow()
  orphanOpen.value = !orphanOpen.value
}
</script>

<template>
  <aside
    class="notes-sidebar"
    :class="{ 'is-hover-guiding': Boolean(noteHoverGuide) || Boolean(parkedHoverNoteId) }"
    aria-label="注释侧栏"
    :style="{ width: `min(${studio.noteWidth}px, 37vw)` }"
  >
    <div
      class="notes-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整注释栏宽度"
      :aria-valuenow="studio.noteWidth"
      :aria-valuemin="280"
      :aria-valuemax="640"
      tabindex="0"
      @pointerdown.prevent="startResize"
      @pointermove="resize"
      @pointerup="finishResize"
      @pointercancel="finishResize"
      @lostpointercapture="finishResize"
      @dblclick="studio.noteWidth = 370"
      @keydown.left.prevent="studio.noteWidth = Math.min(640, studio.noteWidth + 20)"
      @keydown.right.prevent="studio.noteWidth = Math.max(280, studio.noteWidth - 20)"
    />

    <header class="notes-head">
      <h2 class="notes-title">页边的对话</h2>
      <span class="notes-meta">{{ notes.length }} 则注释</span>
    </header>

    <div class="notes-tools">
      <div class="notes-tabs" role="group" aria-label="注释范围">
        <button
          :class="{ selected: studio.notesTab === 'all' }"
          :aria-pressed="studio.notesTab === 'all'"
          @click="studio.notesTab = 'all'"
        >
          全部
        </button>
        <button
          :class="{ selected: studio.notesTab === 'focus' }"
          :aria-pressed="studio.notesTab === 'focus'"
          @click="studio.notesTab = 'focus'"
        >
          本章
        </button>
        <button
          :class="{ selected: studio.notesTab === 'pinned' }"
          :aria-pressed="studio.notesTab === 'pinned'"
          @click="studio.notesTab = 'pinned'"
        >
          固定 {{ studio.pinnedLabels.size || '' }}
        </button>
      </div>
      <button
        class="notes-follow"
        :class="{ paused: followPaused }"
        :aria-pressed="!followPaused"
        :title="followPaused ? '恢复跟随正文' : '暂停跟随，停留在当前注释'"
        @click="toggleFollow"
      >
        {{ followPaused ? '已暂停' : '随文' }}
      </button>
    </div>
    <p v-if="!journey.visits.length" class="notes-reading-hint">
      <span>{{
        studio.notesTab === 'pinned' ? '留在这里，随时回看' : '正文与旁注，各有自己的节奏'
      }}</span>
    </p>
    <nav v-else class="note-journey" aria-label="注释阅读路径">
      <div class="journey-controls">
        <span>沿着这条思路</span>
        <div>
          <button
            aria-label="返回上一注"
            title="返回上一注，并回到离开时的段落"
            :disabled="journey.index <= 0"
            @click="travel(journey.index - 1)"
          >
            <StudioIcon name="back" :size="14" />
          </button>
          <span class="journey-position"
            >{{ journey.index + 1 }} / {{ journey.visits.length }}</span
          >
          <button
            aria-label="前进到下一注"
            title="前进到下一注"
            :disabled="journey.index >= journey.visits.length - 1"
            @click="travel(journey.index + 1)"
          >
            <StudioIcon name="arrow" :size="14" />
          </button>
        </div>
      </div>
      <ol ref="journeyEl" class="journey-steps">
        <li v-for="step in journeySteps" :key="step.index">
          <StudioIcon v-if="step.index" name="chevron" :size="11" />
          <button
            :class="{
              'is-current': step.index === journey.index,
              'is-ahead': step.index > journey.index
            }"
            :aria-current="step.index === journey.index ? 'step' : undefined"
            :aria-label="`回看注释 ${step.type} ${step.mark}`.trim()"
            :title="step.type ? `${step.type} · ${step.mark}` : step.mark"
            @click="travel(step.index)"
          >
            <span v-if="step.type">{{ step.type }}</span
            ><b>{{ step.mark }}</b>
          </button>
        </li>
      </ol>
    </nav>
    <div ref="listEl" class="notes-scroll" tabindex="0" aria-label="滚动阅读注释">
      <div
        class="notes-virtual-space"
        :style="
          virtualized
            ? { height: `${virtualizer.getTotalSize()}px`, position: 'relative' }
            : { paddingTop: `${hoverSpace}px`, paddingBottom: `${hoverSpace}px` }
        "
      >
        <div
          v-for="row in visibleRows"
          :key="row.note.id"
          :ref="measureRow"
          :data-index="row.index"
          class="notes-window-row"
          :style="
            virtualized
              ? {
                  position: 'absolute',
                  top: '0',
                  left: '0',
                  width: '100%',
                  transform: `translateY(${row.start}px)`
                }
              : undefined
          "
        >
          <NoteCard
            :class="{ 'is-hover-guided': noteHoverGuide?.noteId === row.note.id }"
            :note="row.note"
            :active="readerState.activeNoteIds.has(row.note.id)"
            :focused="readerState.focusNoteId === row.note.id"
            :reading="currentVisit?.label === row.note.label"
            :cycle="row.note.cycle === true"
            :active-anchor="
              readerState.activeAnchor?.noteId === row.note.id ? readerState.activeAnchor : null
            "
            @locate="onLocate"
            @navigate="onNavigate"
          />
        </div>
      </div>
      <section v-if="orphanNotes.length && studio.notesTab === 'all'" class="orphan-group">
        <button class="orphan-toggle" :aria-expanded="orphanOpen" @click="onOrphanToggle">
          <AppIcon
            name="chevron"
            :size="13"
            class="orphan-chevron"
            :class="{ open: orphanOpen }"
          />{{ orphanOpen ? '收起未引用注释' : '未引用注释'
          }}<span class="orphan-count">{{ orphanNotes.length }}</span>
        </button>
      </section>

      <p v-if="!filtered.length" class="notes-empty">
        {{
          !notes.length
            ? '本书没有注释。'
            : studio.notesTab === 'pinned'
              ? '点击注释上的图钉，将它留在这里。'
              : '本章暂时没有注释。'
        }}
      </p>
    </div>
  </aside>
</template>

<style scoped>
.notes-sidebar {
  flex: none;
  width: var(--sidebar-w);
  min-width: 0;
  max-width: 640px;
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--sidebar-bg);
  border-left: 1px solid var(--line);
}
/* 停靠时把头部/工具/阅读路径整块移出布局，让 .notes-scroll 以 flex:1 长满整栏。
   T25 之前是 visibility:hidden + 把 .notes-scroll 绝对定位到 inset:0：绝对定位的
   包含块是 aside 的 padding box，比文档流里宽出左右各 18px，于是每次进出停靠
   所有卡片都要重新换行 → 虚拟列表重量测并自行调整 scrollTop（实测 +221/−125px
   的第二个写入者）→ 与我们的补偿打架，整屏跳一下。留在文档流里，宽度两态一致，
   卡片不再重排，几何差异只剩「视口顶移动一个头部高度」，由 hoverGuiding 补偿。 */
.notes-sidebar.is-hover-guiding
  > :is(.notes-head, .notes-tools, .notes-reading-hint, .note-journey) {
  display: none;
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
  /* The virtual spacer represents the whole book and must keep its full height. */
  display: block;
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
