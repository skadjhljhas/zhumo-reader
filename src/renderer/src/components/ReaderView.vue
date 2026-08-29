<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 正文阅读列（滚动容器 + 分块懒挂载 + 联动枢纽）。
 *
 * - 懒挂载：mountIO（预挂载带 ±200% 视口）控制 SectionFrame 挂载/占位；
 *   高度缓存（实测回填）+ 字符数估算保证占位高度准确、滚动不跳；
 *   DOM 预算 12 万节点，超出时把离视口最远的挂载块降回占位（demotedSet），
 *   滚入「视口 ±100%」保护带即解除降级，保证滚到必然可见（M3）。
 * - 当前章：bandIO 在视口上 40% 处开一条 0.5% 高的检测带，带内文档序
 *   最后一章为当前章；带空（极速跳跃）时用高度缓存前缀和回退判定。
 * - 活跃注释：anchorIO 把视口收成顶部 55% 的带，带内锚点即活跃集，
 *   文档序最后者为跟随焦点（focusNoteId）。
 * - 侧栏跟随协同（T14/T17）：正文用户输入（wheel/键盘滚动/滚动条拖动）→
 *   resumeFollow 恢复跟随并立即收敛校验；键盘滚动经 window capture keydown
 *   判定（正文点击后 activeElement 常在 BODY，root 监听收不到，T17-A）。
 *   正文滚动停稳（scrollend，另有 followIdleMs 兜底 debounce）→ 递增
 *   followCorrectionSeq 通知 NotesSidebar 校验不变式。程序化滚动不产生
 *   用户输入，不恢复跟随；目录跳转是用户输入，显式恢复（T17-B）。
 * - 落位重算（T17-C）：程序化跳转类滚动停稳后，对 anchorRegistry 中
 *   isConnected 锚点按 anchorIO 同一几何做全量 rect 扫描替换 IO 边沿
 *   增量——章重挂载使旧锚脱离文档、exit 事件丢失，activeSet 否则会
 *   永久冻结在跳转前的累积并集。跟随焦点取「带内几何 top 最大」而非
 *   登记 seq 最大（T17-D），点卡后 focus 钉扎为被点注直到下次用户滚动。
 * - 目录标红钉扎（T19-P2/P3）：目录跳转入口设 pinnedTocId 钉扎，标红（章/
 *   小节）存活期恒为被点项——短节落位时 40% 线越入下一节的几何态与 phg
 *   书边界 ±50px 抖动翻转被 pin 吸收；用户滚动净位移超 tocPinReleasePx 或
 *   40% 线越过被点标题才解除（updateCurrentSection/Heading 与停稳重算均
 *   尊重 pin）。程序化滚动在途不解除（基准置 null），真正到达意图落位
 *   （到达确认）后才重定基准。
 * - 跳转精调轮询（T19-P1）：远距跳转先瞬时落估算位，再逐 rAF 轮询目标章
 *   body 就绪且落位几何稳定后精调（取代双 rAF 后 `if (!frame) return` 的
 *   静默丢弃——冷挂载 >33ms 时精调丢失、停在估算位 → 标红前一项）；超时
 *   保持估算位。进度恢复校正对齐同一轮询辅助。jumpToken 令牌作废在途轮询。
 * - 进度：rAF 节流滚动 → 全书比例；2s 节流 saveProgress（章 + 章内比例）；
 *   开书按 {sectionId, ratio} 恢复，双 rAF 校正估算误差。
 *   数学核心在 ./reader-math（纯函数、对称 save/restore）。
 * - 书身份快照（H2）：挂载时刻快照 payload.path / 书对象 / 当前章，
 *   卸载保存进度一律用快照，切书（先卸载旧组件再挂新组件）时全局
 *   bookState 已被替换/清空也不会把旧书位置写进新书存档。
 * - 关窗 flush（M2）：订阅 window.api.onFlush，收到通知同步保存进度后 ack，
 *   主进程 destroy 前统一落盘，关窗不再丢失 ≤2s 的节流进度。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, watch } from 'vue'
import SectionFrame from './SectionFrame.vue'
import type { NoteBodySpot, ParsedBook, Section } from '../../../shared/types'
import { bookState } from '../composables/useBook'
import { settings } from '../composables/useSettings'
import {
  nextFrames,
  pinFollowFocus,
  readerState,
  requestSidebarLocate,
  resumeFollow,
  unpinToc
} from '../composables/readerStore'
import {
  READER_TUNING,
  anchorInNoteBand,
  bandRootMargin,
  computeIntraRatio,
  contentBottom,
  estimateSectionHeight,
  heightsOf,
  isHeadingCrossedByLine,
  mountRootMargin,
  nearestIndexByDistance,
  noteBandRootMargin,
  prefixTopsOf,
  restoreScrollTop,
  selectDemotions,
  selectFocusAnchor,
  shouldReleaseTocPin,
  shouldUndemote,
  tocPinNetDisplacement,
  type DomBlockInfo
} from './reader-math'

const scrollEl = ref<HTMLElement | null>(null)

/* ---------------- 书身份快照（H2） ---------------- */

/** 本组件实例的书路径：卸载保存进度一律以此为准（切书时全局 payload 已换新） */
const ownPath = bookState.payload?.path ?? ''
/** 本组件实例渲染的书与章节（重新解析整书替换时同步更新） */
const ownBook = ref<ParsedBook | null>(bookState.book ?? null)
const ownSections = ref<Section[]>(bookState.book?.sections ?? [])
/** 本组件视角的当前章：不读 readerState.currentSectionId（切书时它已被清空） */
let ownSectionId = ''

/* ---------------- 高度估算与缓存 ---------------- */

const heightCache = shallowReactive(new Map<string, number>())

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/** 估算章内容高：实测缓存优先，其次字符数估算（纯计算见 reader-math） */
function estimateHeight(sec: Section): number {
  const cached = heightCache.get(sec.id)
  if (cached) return cached
  return estimateSectionHeight(stripTags(sec.html).length, {
    contentWidth: settings.contentWidth,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight
  })
}

/** 各章内容顶坐标前缀和（全部用缓存/估算，不读 DOM，可滚动帧内调用） */
function prefixTops(): number[] {
  const heights = heightsOf(ownSections.value, estimateHeight)
  return prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
}

/* ---------------- 元素登记 ---------------- */

const frameEls = new Map<string, HTMLElement>()

/** v-for 函数 ref：组件实例需取 $el */
function setFrameEl(id: string, el: unknown): void {
  const dom = el instanceof HTMLElement ? el : ((el as { $el?: unknown } | null)?.$el ?? null)
  if (dom instanceof HTMLElement) frameEls.set(id, dom)
  else frameEls.delete(id)
}

/* ---------------- 观察器 ---------------- */

const mountSet = shallowReactive(new Set<string>())
/** DOM 预算降级块：仍在 mountSet（IO 真值）中但渲染占位，滚入保护带即解除（M3） */
const demotedSet = shallowReactive(new Set<string>())
const bandSet = new Set<string>()
/** 锚点元素 → noteId */
const anchorRegistry = new Map<Element, string>()
/** noteId → 锚点元素集（正文同一注可多处锚点） */
const anchorsByNote = new Map<string, Set<Element>>()
/** 章 → 其锚点元素（卸载清理用） */
const anchorsBySection = new Map<string, Set<Element>>()
/** 锚点元素 → 文档序（焦点取活跃集中序最大者） */
const anchorSeq = new Map<Element, number>()
/** 活跃集（普通 Set，提交时整体换引用触发响应） */
const activeSet = new Set<string>()

let mountIO: IntersectionObserver | null = null
let bandIO: IntersectionObserver | null = null
let anchorIO: IntersectionObserver | null = null

function setupObservers(): void {
  const root = scrollEl.value
  if (!root) return
  mountIO = new IntersectionObserver(onMountEntries, {
    root,
    rootMargin: mountRootMargin()
  })
  bandIO = new IntersectionObserver(onBandEntries, {
    root,
    rootMargin: bandRootMargin()
  })
  anchorIO = new IntersectionObserver(onAnchorEntries, {
    root,
    rootMargin: noteBandRootMargin()
  })
  for (const el of frameEls.values()) {
    mountIO.observe(el)
    bandIO.observe(el)
  }
}

function teardownObservers(): void {
  mountIO?.disconnect()
  bandIO?.disconnect()
  anchorIO?.disconnect()
  mountIO = bandIO = anchorIO = null
}

function resetRuntime(): void {
  mountSet.clear()
  demotedSet.clear()
  bandSet.clear()
  anchorRegistry.clear()
  anchorsByNote.clear()
  anchorsBySection.clear()
  anchorSeq.clear()
  activeSet.clear()
  heightCache.clear()
  readerState.activeNoteIds = new Set()
  readerState.focusNoteId = ''
  readerState.activeAnchor = null
}

/* ---------------- 懒挂载 ---------------- */

function onMountEntries(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) {
    const id = (e.target as HTMLElement).dataset.sectionId
    if (!id) continue
    if (e.isIntersecting) mountSet.add(id)
    else mountSet.delete(id)
  }
  enforceDomBudget()
}

/** DOM 预算：挂载块节点总数超限 → 离视口最远者降回占位（不降级视口内的章）。
 *  降级块记入 demotedSet（仍留在 mountSet），滚入保护带由 undemoteNearView 回挂。 */
function enforceDomBudget(): void {
  const root = scrollEl.value
  if (!root || mountSet.size === 0) return
  const heights = heightsOf(ownSections.value, estimateHeight)
  const tops = prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
  const idxOf = new Map(ownSections.value.map((s, i) => [s.id, i]))
  const blocks: DomBlockInfo[] = []
  for (const id of mountSet) {
    if (demotedSet.has(id)) continue // 已降级块不占预算
    const idx = idxOf.get(id)
    const el = frameEls.get(id)
    if (!el || idx === undefined) continue
    blocks.push({ id, nodes: countNodes(el), top: tops[idx], height: heights[idx] })
  }
  for (const id of selectDemotions(
    blocks,
    READER_TUNING.domBudget,
    root.scrollTop,
    root.clientHeight
  )) {
    demotedSet.add(id)
  }
}

/** 回挂：视口 ±demoteGuardPct% 保护带内的降级块解除降级（M3，滚动帧内调用） */
function undemoteNearView(): void {
  if (demotedSet.size === 0) return
  const root = scrollEl.value
  if (!root) return
  const heights = heightsOf(ownSections.value, estimateHeight)
  const tops = prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
  const idxOf = new Map(ownSections.value.map((s, i) => [s.id, i]))
  for (const id of [...demotedSet]) {
    const idx = idxOf.get(id)
    if (idx === undefined) {
      demotedSet.delete(id)
      continue
    }
    if (
      shouldUndemote(
        tops[idx],
        heights[idx],
        root.scrollTop,
        root.clientHeight,
        READER_TUNING.demoteGuardPct
      )
    ) {
      demotedSet.delete(id)
    }
  }
}

function countNodes(el: Element): number {
  const walker = el.ownerDocument.createTreeWalker(
    el,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  )
  let n = 0
  while (walker.nextNode()) n++
  return n
}

/* ---------------- 当前章（40% 检测带） ---------------- */

function onBandEntries(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) {
    const id = (e.target as HTMLElement).dataset.sectionId
    if (!id) continue
    if (e.isIntersecting) bandSet.add(id)
    else bandSet.delete(id)
  }
  updateCurrentSection()
}

function updateCurrentSection(): void {
  let current = ''
  for (const s of ownSections.value) {
    if (bandSet.has(s.id)) current = s.id // 带内取文档序最后者
  }
  const root = scrollEl.value
  if (!current && root && ownSections.value.length) {
    // 回退：检测带为空（极速跳跃）时按滚动位置估算
    const line = root.scrollTop + root.clientHeight * READER_TUNING.anchorLine
    const tops = prefixTops()
    let idx = 0
    for (let i = 0; i < tops.length; i++) if (tops[i] <= line) idx = i
    current = ownSections.value[idx]?.id ?? ''
  }
  if (current) {
    ownSectionId = current // H2：本组件视角的当前章（切书卸载保存用，恒几何真值）
    // T19 目录钉扎优先（P2/P3）：钉扎存活期标红章恒为被点项章——bandIO 增量
    // 与检测带空档回退都不覆盖（短节落位时 40% 线越入下一节的几何态被 pin
    // 吸收）；几何真值仍记入 ownSectionId 供进度保存。解除见 maybeReleaseTocPin。
    if (readerState.pinnedTocId && readerState.pinnedTocSectionId) {
      readerState.currentSectionId = readerState.pinnedTocSectionId
      readerState.visitedSections.add(readerState.pinnedTocSectionId)
      return
    }
    if (current !== readerState.currentSectionId) {
      readerState.currentSectionId = current
      readerState.visitedSections.add(current)
    }
  }
}

/** 章内小节级定位：当前章已挂载时，取 40% 线上方最后一个标题的文本 */
function updateCurrentHeading(): void {
  const root = scrollEl.value
  const id = readerState.currentSectionId
  const frame = id ? frameEls.get(id) : undefined
  if (!root || !frame || !mountSet.has(id) || demotedSet.has(id)) {
    readerState.currentHeadingTitle = ''
    return
  }
  // T19 目录钉扎优先：钉扎存活期标红小节恒为被点项（P2 短节 40% 线越界的
  // 几何态与停稳重算都不覆盖）；解除后走「线上方最后一个标题」几何判定
  if (readerState.pinnedTocId && readerState.pinnedTocHeading) {
    readerState.currentHeadingTitle = readerState.pinnedTocHeading
    return
  }
  const line = root.getBoundingClientRect().top + root.clientHeight * READER_TUNING.anchorLine
  let title = ''
  for (const h of frame.querySelectorAll('h1, h2, h3')) {
    if (h.getBoundingClientRect().top <= line) title = headingText(h)
    else break
  }
  readerState.currentHeadingTitle = title
}

/* ---------------- 锚点与活跃集 ---------------- */

function onAnchorsReady(id: string, el: HTMLElement): void {
  const secIdx = ownSections.value.findIndex((s) => s.id === id)
  const anchors = el.querySelectorAll('.zmu-ref')
  let sectionAnchors = anchorsBySection.get(id)
  if (!sectionAnchors) {
    sectionAnchors = new Set()
    anchorsBySection.set(id, sectionAnchors)
  }
  anchors.forEach((a, i) => {
    const noteId = (a as HTMLElement).dataset.noteId
    if (!noteId) return
    anchorRegistry.set(a, noteId)
    anchorSeq.set(a, Math.max(0, secIdx) * 100_000 + i)
    sectionAnchors!.add(a)
    let set = anchorsByNote.get(noteId)
    if (!set) {
      set = new Set()
      anchorsByNote.set(noteId, set)
    }
    set.add(a)
    anchorIO?.observe(a)
    if (activeSet.has(noteId)) a.classList.add('is-active')
  })
}

function onAnchorsGone(id: string): void {
  const sectionAnchors = anchorsBySection.get(id)
  if (!sectionAnchors) return
  let changed = false
  for (const a of sectionAnchors) {
    anchorIO?.unobserve(a)
    const noteId = anchorRegistry.get(a)
    anchorRegistry.delete(a)
    anchorSeq.delete(a)
    if (noteId) {
      anchorsByNote.get(noteId)?.delete(a)
      if (activeSet.delete(noteId)) changed = true
    }
  }
  anchorsBySection.delete(id)
  if (changed) commitActive()
}

function onAnchorEntries(entries: IntersectionObserverEntry[]): void {
  let changed = false
  for (const e of entries) {
    const noteId = anchorRegistry.get(e.target)
    if (!noteId) continue
    if (e.isIntersecting) {
      if (!activeSet.has(noteId)) {
        activeSet.add(noteId)
        changed = true
      }
    } else if (activeSet.delete(noteId)) {
      changed = true
    }
  }
  if (changed) commitActive()
}

/** 提交活跃集：换引用触发依赖；同步正文锚点高亮与跟随焦点 */
function commitActive(): void {
  // 正文锚点 class 同步
  for (const [noteId, els] of anchorsByNote) {
    const on = activeSet.has(noteId)
    for (const el of els) el.classList.toggle('is-active', on)
  }
  // 跟随焦点：钉扎优先（T17-D，点卡跳转落位前恒为被点注——即便该注锚尚未
  // 进入几何带，被点注即 focus 的 I3 语义也由钉扎保证）；否则取「带内几何
  // top 最大」的注册锚（T17-D：取代旧「登记 seq 最大」，多锚注的晚序锚不在
  // 带内时不再误抬 focus）
  const pin = readerState.pinnedNoteId
  if (pin) {
    readerState.activeNoteIds = new Set(activeSet)
    readerState.focusNoteId = pin
    return
  }
  const root = scrollEl.value
  let focus = ''
  let focusEl: Element | null = null
  if (root) {
    const rr = root.getBoundingClientRect()
    const inBand: { noteId: string; seq: number; top: number; el: Element }[] = []
    for (const [el, noteId] of anchorRegistry) {
      if (!activeSet.has(noteId) || !el.isConnected) continue
      const rect = el.getBoundingClientRect()
      // 视口相对坐标（与 anchorIO rootMargin 同几何）：切勿叠加 scrollTop，
      // 那是内容坐标，深滚后与 clientHeight*band 比较会把带内锚全部误判为带外。
      const top = rect.top - rr.top
      const bottom = rect.bottom - rr.top
      if (anchorInNoteBand(top, bottom, root.clientHeight, READER_TUNING.anchorNoteBand)) {
        inBand.push({ noteId, seq: anchorSeq.get(el) ?? -1, top, el })
      }
    }
    focus = selectFocusAnchor(inBand)
    focusEl = inBand.find((a) => a.noteId === focus)?.el ?? null
  }
  readerState.activeNoteIds = new Set(activeSet)
  readerState.focusNoteId = focus
  // T23 引用地图：当前活跃锚点身份 = 焦点锚的反向 spot 映射（无焦点清空）。
  // pin 分支已提前 return（pin 期不覆盖：跳转声明的 spot 保持到用户滚动
  // 恢复几何真值为止），此处 pin 恒为空
  readerState.activeAnchor = focusEl ? spotOfAnchor(focusEl) : null
}

/**
 * 全量几何重算活跃集（T17-C 核心）：程序化跳转类滚动（点卡/目录/进度恢复）
 * 落位后调用。jumpToSectionInstant 触发章重挂载、锚元素换代，旧目标脱离
 * 文档后 IO 的 exit 边沿事件丢失，activeSet 永久冻结在跳转前的累积并集
 * （高亮/focus 落到无关旧注）。对 anchorRegistry 中 isConnected 元素按
 * noteBandRootMargin 同一几何做一次 rect 扫描，以扫描结果整体替换 IO 的
 * 边沿增量（重算后以重算结果为准；不采用 disconnect+re-observe 避免伪
 * exit 抖动）。O(锚点数)，几十枚锚可忽略。
 */
function recomputeActiveFromGeometry(): void {
  const root = scrollEl.value
  if (!root) return
  const rr = root.getBoundingClientRect()
  const next = new Set<string>()
  for (const [el, noteId] of anchorRegistry) {
    if (!el.isConnected) continue
    const rect = el.getBoundingClientRect()
    // 视口相对坐标（同 anchorIO rootMargin），不可叠加 scrollTop（内容坐标）
    if (
      anchorInNoteBand(
        rect.top - rr.top,
        rect.bottom - rr.top,
        root.clientHeight,
        READER_TUNING.anchorNoteBand
      )
    ) {
      next.add(noteId)
    }
  }
  activeSet.clear()
  for (const id of next) activeSet.add(id)
  commitActive()
}

/* ---------------- 滚动 / 进度 ---------------- */

let ticking = false
let restoreDone = false
let lastSave = 0
let saveTimer: number | null = null

/* ---------------- 侧栏跟随协同（T14/T17） ---------------- */

/** 正文滚动停稳兜底计时：scrollend 缺发（个别环境/合成器异常）时仍会通知收敛 */
let scrollIdleTimer: number | null = null
/** 落位重算轮询令牌（T17-C）：新一次程序化跳转使旧的 settleThenRecompute 作废 */
let settleToken = 0
/** 跳转精调轮询令牌（T19-P1）：新一次程序化滚动/卸载使在途精调轮询作废 */
let jumpToken = 0
/** 目录钉扎位移基准（T19-P2/P3）：null = 程序化滚动在途/未定基（不解除）。
 *  程序化流程真正到达意图落位后重定基为落位 scrollTop（smooth 跳转走
 *  到达确认 waitForArrivalRebase，瞬时恢复走 settle 重定基）；用户滚动不改
 *  基准——净位移口径（|scrollTop − 基准|）使 ±50px 微滚/phg 书边界抖动不交接。 */
let tocPinAnchor: number | null = null
/** 目录钉扎基准重定时刻（T19）：线界越过解除的落位静默窗起点 */
let tocPinRebasedAt = 0

/**
 * 目录钉扎解除检查（T19）：用户滚动净位移超 tocPinReleasePx，或 40% 线越过
 * 被点标题时解除；解除后立即按几何刷新标红（交接几何真值）。程序化滚动在途
 * （基准 null）不解除——进度恢复/卡片跳转引发的位移不计入用户滚动。
 * 线界越过解除有落位静默窗（tocPinCrossGraceMs）：落位后邻章挂载/高度回填
 * 使被点标题瞬时上下平移可瞬时越线（短节书实测），窗内只认位移解除；真实
 * 用户越线滚动的位移必然 > 阈值（落位标题距线 ≈ 0.4vh−16px），位移条件先
 * 触发，静默窗不漏真实的用户解除。每个 scroll 帧（rAF 节流内）调用。
 */
function maybeReleaseTocPin(): void {
  if (!readerState.pinnedTocId) return
  const root = scrollEl.value
  if (!root || tocPinAnchor === null) return
  const net = tocPinNetDisplacement(tocPinAnchor, root.scrollTop)
  // 超阈值短路（不取数）；线界越过仅在落位静默窗后参与判定
  const crossed =
    net > READER_TUNING.tocPinReleasePx ||
    (performance.now() - tocPinRebasedAt >= READER_TUNING.tocPinCrossGraceMs &&
      tocPinHeadingCrossed())
  if (!shouldReleaseTocPin(net, READER_TUNING.tocPinReleasePx, crossed)) return
  releaseTocPinNow()
}

/** 解除目录钉扎并立即按几何刷新标红（T19） */
function releaseTocPinNow(): void {
  unpinToc()
  tocPinAnchor = null
  updateCurrentSection()
  updateCurrentHeading()
}

/** 被点标题是否已被 40% 线越过（T19）：目标章 body 就绪且标题可定位才判定，
 *  未就绪不判越（保持钉扎等轮询落位）。 */
function tocPinHeadingCrossed(): boolean {
  const root = scrollEl.value
  const secId = readerState.pinnedTocSectionId
  const heading = readerState.pinnedTocHeading
  if (!root || !secId || !heading) return false
  const frame = frameEls.get(secId)
  if (!frame || !frame.querySelector('.section-body')) return false
  const hit = findHeadingEl(frame, heading)
  if (!hit) return false
  const lineY = root.getBoundingClientRect().top + root.clientHeight * READER_TUNING.anchorLine
  return isHeadingCrossedByLine(hit.getBoundingClientRect().top, lineY)
}

/** 正文滚动停稳（scrollend 或兜底 idle debounce）→ 通知侧栏收敛校验不变式 */
function notifyScrollIdle(): void {
  scrollIdleTimer = null
  // T17-C：每次滚动停稳都按几何全量对齐活跃集与 focus——IO 的边沿增量在
  // 挂载高度回填/重排后可能不再触发（锚在带内平移而非跨界），令 focus 落后
  // 于最终静止几何；静止态以 rect 扫描真值为准（重算后以重算结果为准，与
  // IO 不冲突）。commitActive 内 pin 优先，钉扎存活期 focus 仍为被点注（I3）。
  recomputeActiveFromGeometry()
  readerState.followCorrectionPhase = 'idle'
  readerState.followCorrectionSeq++
}

/**
 * 滚动停稳后全量重算（T17-C 核心，取代依赖 scrollend 的一次性触发）：
 * 逐帧轮询 scrollTop，连续 followIdleMs 内不变（或达帧上限）判定落位，再
 * recomputeActiveFromGeometry。用轮询而非 scrollend 是因为 jumpToSectionInstant
 * （instant）+ 随后的 smooth 滚动构成「两段滚动」——第一段的 scrollend 会在
 * 中间位置提前触发重算，而第二段 smooth 的 scrollend 在部分环境缺失，导致
 * 最终落位后不再重算（T16-C 冻结的残留路径）。令牌保证并发跳转只有最新一次
 * 生效；pin 存活期（到下次用户滚动）覆盖整个跳转动画，focus 全程为被点注。
 */
async function settleThenRecompute(rebaseTocPin = false): Promise<void> {
  const token = ++settleToken
  const root = scrollEl.value
  if (!root) return
  let prev = root.scrollTop
  let stableMs = 0
  let last = performance.now()
  for (let frame = 0; frame < 90; frame++) {
    await nextFrames(1)
    if (token !== settleToken) return // 被更新的程序化跳转取代
    const now = performance.now()
    const dt = now - last
    last = now
    if (Math.abs(root.scrollTop - prev) < 0.5) {
      stableMs += dt
      if (stableMs >= READER_TUNING.settleRecomputeMs) break
    } else {
      stableMs = 0
    }
    prev = root.scrollTop
  }
  if (token !== settleToken) return
  recomputeActiveFromGeometry()
  // T19：程序化滚动落位后重定目录钉扎位移基准（此后用户滚动自落位起算）。
  // 仅瞬时恢复类流程（进度恢复 scrollToRestore）经此处重定基——smooth
  // 跳转类（scrollToSection）的基准重定挂在到达确认 waitForArrivalRebase
  // 上（settle 稳定窗在减速尾段会提前判稳）；jumpToSectionInstant 的内部
  // settle 与用户滚动触发的 settle 不重定，微滚累计不被洗掉。重定时刻
  // 同时开启线界越过解除的落位静默窗。
  if (rebaseTocPin && readerState.pinnedTocId && scrollEl.value) {
    tocPinAnchor = scrollEl.value.scrollTop
    tocPinRebasedAt = performance.now()
  }
}

function onScrollEnd(): void {
  if (scrollIdleTimer !== null) {
    window.clearTimeout(scrollIdleTimer)
    scrollIdleTimer = null
  }
  notifyScrollIdle()
}

/** 正文用户输入（wheel）→ 恢复跟随并立即收敛校验；程序化滚动不经过这里 */
function onReaderWheel(): void {
  resumeFollow()
}

/** 滚动键（与侧栏同清单）：这些键会滚动「可滚动焦点链」上的容器 */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

/** 事件是否源自侧栏 / 目录抽屉（其键盘滚动属侧栏交互，维持挂起语义 T14） */
function inSidePanel(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('.notes-sidebar, .toc-drawer')
}

/** 输入区判定：input / textarea / contenteditable 的键盘输入不触发恢复 */
function inEditable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/**
 * 键盘滚动恢复（T17-A）：监听挂 window（capture）。正文点击后
 * activeElement 常为 BODY（.reader-scroll 无 tabindex），keydown 目标即
 * BODY、根本冒泡不进组件 root —— 旧 root keydown 监听永不触发，键盘滚
 * 正文后跟随冻结。BODY/document 目标一律按「正文列键盘滚动」处理；其余
 * 按命中区域过滤（侧栏/目录/输入区除外）。
 */
function onWindowKeydown(ev: KeyboardEvent): void {
  if (!SCROLL_KEYS.has(ev.key)) return
  const t = ev.target
  if (!(t instanceof Element)) return
  if (inEditable(t)) return
  if (t !== document.body && t !== document.documentElement && inSidePanel(t)) return
  resumeFollow()
}

/** 正文滚动条拖动：pointerdown 命中滚动条带（target 为容器自身且 X 越过 clientWidth） */
function onReaderPointerDown(ev: PointerEvent): void {
  const root = scrollEl.value
  if (root && ev.target === root && ev.offsetX >= root.clientWidth) resumeFollow()
}

function onScroll(): void {
  // T14 兜底：每个 scroll 事件重置停稳计时（scrollend 缺发时 200ms 后仍通知收敛）
  if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer)
  scrollIdleTimer = window.setTimeout(notifyScrollIdle, READER_TUNING.followIdleMs)
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    ticking = false
    const root = scrollEl.value
    if (!root) return
    // 进度分母取「末章底」而非 scrollHeight：尾部 42vh 留白不计入阅读进度
    const heights = heightsOf(ownSections.value, estimateHeight)
    const tops = prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
    const lastBottom = contentBottom(tops, heights, READER_TUNING.frameGap)
    const max = lastBottom - root.clientHeight
    readerState.progress = max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 1
    // M3：先回挂保护带内的降级块，再重算预算（把更远的降下去）
    undemoteNearView()
    enforceDomBudget()
    if (bandSet.size === 0) updateCurrentSection()
    updateCurrentHeading()
    maybeReleaseTocPin() // T19：用户滚动按净位移/线界解除目录钉扎
    scheduleProgressSave()
  })
}

/** 章内进度：以锚点线位置计算，clamp 0..1（数学见 reader-math.computeIntraRatio） */
function intraRatio(sectionId: string): number {
  const root = scrollEl.value
  const idx = ownSections.value.findIndex((s) => s.id === sectionId)
  if (!root || idx < 0) return 0
  const heights = heightsOf(ownSections.value, estimateHeight)
  const tops = prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
  return computeIntraRatio(
    root.scrollTop,
    root.clientHeight,
    READER_TUNING.anchorLine,
    tops[idx],
    heights[idx]
  )
}

/** intraRatio 的逆运算：把章内比例还原为 scrollTop（数学见 reader-math.restoreScrollTop） */
function scrollToRestore(idx: number, ratio: number): void {
  const root = scrollEl.value
  if (!root) return
  jumpToken++ // T19：作废在途精调轮询（程序化滚动互相打断）
  tocPinAnchor = null // T19：进度恢复引发的位移不计入用户滚动（落位重定基）
  const heights = heightsOf(ownSections.value, estimateHeight)
  const tops = prefixTopsOf(heights, READER_TUNING.colPadTop, READER_TUNING.frameGap)
  const max = Math.max(0, root.scrollHeight - root.clientHeight)
  root.scrollTop = restoreScrollTop(
    tops[idx],
    ratio,
    heights[idx],
    root.clientHeight,
    READER_TUNING.anchorLine,
    max
  )
  void settleThenRecompute(true) // T17-C：落位重算；T19：重定目录钉扎基准
}

function scheduleProgressSave(): void {
  if (!restoreDone) return
  const interval = READER_TUNING.saveIntervalMs
  const now = Date.now()
  const elapsed = now - lastSave
  if (elapsed >= interval) {
    lastSave = now
    doSaveProgress()
  } else if (saveTimer === null) {
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      lastSave = Date.now()
      doSaveProgress()
    }, interval - elapsed)
  }
}

/** 保存进度：一律用本组件的书身份快照（H2）——切书卸载时全局 bookState
 *  的 payload/book/currentSectionId 可能已被替换或清空，读全局会把旧书
 *  位置写进新书存档；当前滚动位置仍从自身 DOM 取。 */
function doSaveProgress(): void {
  if (!ownPath) return
  const sectionId = ownSectionId || ownSections.value[0]?.id || ''
  if (!sectionId) return
  window.api
    .saveProgress(ownPath, {
      sectionId,
      ratio: intraRatio(sectionId),
      updatedAt: Date.now()
    })
    .catch(() => {
      /* 进度落盘失败不打断阅读 */
    })
}

/* ---------------- 程序化滚动 ---------------- */

function jumpToSectionInstant(id: string): void {
  const root = scrollEl.value
  const idx = ownSections.value.findIndex((s) => s.id === id)
  if (!root || idx < 0) return
  mountSet.add(id)
  demotedSet.delete(id) // 目标章强制挂载（即使此前因预算被降级）
  root.scrollTop = prefixTops()[idx]
  // T17-C：瞬时跳转落位后全量几何重算。T19：此处不重定目录钉扎基准——
  // 外层流程（目录跳转的到达确认 / 进度恢复的终末 settle）才重定基，
  // 避免精调 smooth 在途时基准被钉在中间位置、位移误超阈值解除钉扎。
  void settleThenRecompute()
}

/**
 * 等待精调目标就绪（T19-P1）：远距跳转先瞬时落到估算位，目标章随后才异步
 * 挂载渲染（v-html/图片/公式 >33ms 时双 rAF 不够，1.0.7 的 `if (!frame)
 * return` 会静默丢弃精调，停在估算位 → 标红前一项）。逐 rAF 轮询：目标章
 * .section-body 就绪且「候选落位几何」连续 fineTuneStableFrames 帧位移
 * < 0.5px（挂载高度回填/重排收敛）后返回目标元素；上限 fineTunePollFrames
 * 帧，超时返回最后已知候选（body 未就绪则为 null → 保持估算位）。
 * 注意：章容器根元素常驻（占位态也注册 frameEls），必须以 body 就绪为门槛，
 * 否则占位几何提前「稳定」会重蹈退化精调。token 为 jumpToken 快照，令牌
 * 作废（新的程序化滚动/卸载）即返回 null 放弃精调（与 settleToken 协同）。
 */
async function waitForFineTuneTarget(
  id: string,
  heading: string | undefined,
  token: number
): Promise<HTMLElement | null> {
  const root = scrollEl.value
  if (!root) return null
  let prevTop = Number.NaN
  let stable = 0
  let lastTarget: HTMLElement | null = null
  for (let i = 0; i < READER_TUNING.fineTunePollFrames; i++) {
    if (token !== jumpToken) return null
    const frame = frameEls.get(id)
    if (frame && frame.querySelector('.section-body')) {
      let target: HTMLElement = frame
      if (heading) {
        const hit = findHeadingEl(frame, heading)
        if (hit) target = hit
      }
      lastTarget = target
      const top =
        root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top
      if (Math.abs(top - prevTop) < 0.5) {
        stable++
        if (stable >= READER_TUNING.fineTuneStableFrames) return target
      } else {
        stable = 0
      }
      prevTop = top
    }
    await nextFrames(1)
  }
  return lastTarget
}

async function scrollToSection(id: string, heading?: string): Promise<void> {
  const root = scrollEl.value
  if (!root) return
  const idx = ownSections.value.findIndex((s) => s.id === id)
  if (idx < 0) return
  ownSectionId = id
  readerState.currentSectionId = id
  readerState.visitedSections.add(id)
  const token = ++jumpToken // T19：新跳转令牌，作废在途精调轮询
  tocPinAnchor = null // T19：跳转在途不解除钉扎（到达确认后重定基）
  const estTop = prefixTops()[idx]
  if (Math.abs(estTop - root.scrollTop) > root.clientHeight * 1.2) {
    // 远距离：先瞬时跳到估算位置（触发挂载），再等目标就绪精调（T19-P1 轮询）
    jumpToSectionInstant(id)
    await nextFrames(2)
  }
  // 目录粒度细于章粒度（章按 H1 切分）：标题文本非空时精配到小节标题元素
  const target = await waitForFineTuneTarget(id, heading, token)
  if (!target || token !== jumpToken) return
  const top = root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top
  const intendedTop = Math.max(0, top - 16)
  root.scrollTo({ top: intendedTop, behavior: 'smooth' })
  void settleThenRecompute(false) // T17-C：落位重算（T19 重定基改由到达确认负责）
  void waitForArrivalRebase(intendedTop, token) // T19：真正到达意图位后才重定钉扎基准
}

/** 等待 smooth 真正到达意图落位后重定目录钉扎基准（T19-P2）。
 *  settleThenRecompute 的 200ms 稳定窗在 smooth 减速尾段/合成器停顿下会提前
 *  判稳（实测 edge-cases #6：st=2904 判稳而终位 3051，基准钉在中间位 → smooth
 *  走完净位移 81px 超 tocPinReleasePx 误解除）；且 headless/高刷下 rAF 不受
 *  vsync 节流，帧数上限失真（实测 60 帧 ≈ 400ms 墙钟 < smooth 动画 ≈ 1s，
 *  超时 fallback 同样把基准钉在途中）。故本函数按墙钟轮询：到
 *  「|st − 意图落位| ≤ tocPinArrivePx」即重定基；st 真停稳
 *  （连续 tocPinStableMs 每帧位移 < 0.5px，书尾 clamp/布局漂移致意图位
 *  不可达）或超 tocPinArriveTimeoutMs 兜底，以当前位重定基——用户滚动净
 *  位移自实际停稳位置起算，语义不变。token 为 jumpToken 快照：令牌作废
 *  （新跳转/卸载）或钉扎已被解除即放弃。到达后补一次几何重算，弥补
 *  settle 中途 break 时 recompute 落在 smooth 中间位的偏差。 */
async function waitForArrivalRebase(intendedTop: number, token: number): Promise<void> {
  const root0 = scrollEl.value
  if (!root0) return
  const deadline = performance.now() + READER_TUNING.tocPinArriveTimeoutMs
  let lastSt = root0.scrollTop
  let lastT = performance.now()
  let stableMs = 0
  for (;;) {
    await nextFrames(1)
    if (token !== jumpToken || !readerState.pinnedTocId) return
    const root = scrollEl.value
    if (!root) return
    const st = root.scrollTop
    const now = performance.now()
    if (Math.abs(st - intendedTop) <= READER_TUNING.tocPinArrivePx) {
      tocPinAnchor = st
      tocPinRebasedAt = now // 线界越过解除的落位静默窗自此起算
      recomputeActiveFromGeometry()
      return
    }
    if (Math.abs(st - lastSt) < 0.5) stableMs += now - lastT
    else stableMs = 0
    lastSt = st
    lastT = now
    if (stableMs >= READER_TUNING.tocPinStableMs || now >= deadline) {
      tocPinAnchor = st
      tocPinRebasedAt = now
      recomputeActiveFromGeometry()
      return
    }
  }
}

/** 标题文本提取：剔除 sup 注释锚点（与目录 stripRefMarkers 后的标题对齐） */
function headingText(h: Element): string {
  let t = ''
  for (const node of h.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) t += node.textContent
    else if (node instanceof HTMLElement && node.tagName !== 'SUP') t += node.textContent
  }
  return t.trim()
}

/** 章容器内按标题文本精配小节元素（忽略全部空白差异） */
function findHeadingEl(frame: HTMLElement, title: string): HTMLElement | null {
  const want = title.replace(/\s+/g, '')
  if (!want) return null
  for (const h of frame.querySelectorAll('h1, h2, h3')) {
    if (headingText(h).replace(/\s+/g, '') === want) return h as HTMLElement
  }
  return null
}

/* ---------------- 注释跳转（最近锚点确定性 + 指定 spot，L1/T11/T23） ---------------- */

/** spot 对应的锚点元素：spot 在其章内的位次 ↔ 该章内按文档序排列的同注锚点位次 */
function anchorForSpot(
  noteId: string,
  spot: { sectionId: string; order: number }
): HTMLElement | null {
  const note = ownBook.value?.notes.find((n) => n.id === noteId)
  if (!note) return null
  // 仅 body spot 参与正文定位（note spot 无章节坐标）；kind 缺失按 body 兼容旧数据
  const k = note.anchorSpots
    .filter((s): s is NoteBodySpot => s.kind !== 'note')
    .filter((s) => s.sectionId === spot.sectionId)
    .findIndex((s) => s.order === spot.order)
  if (k < 0) return null
  const anchors = [...(anchorsByNote.get(noteId) ?? [])]
    .filter((a): a is HTMLElement => a instanceof HTMLElement && a.isConnected)
    .filter((a) => a.closest('.section-frame')?.getAttribute('data-section-id') === spot.sectionId)
    .sort((a, b) => (anchorSeq.get(a) ?? 0) - (anchorSeq.get(b) ?? 0))
  return anchors[k] ?? null
}

/** 锚点绝对纵坐标（滚动内容坐标系）：已挂载章用 DOM 实测。
 *  取 rect 相对滚动容器的差值而非 offsetTop 链 —— 滚动容器与 section 容器
 *  均无定位，offsetParent 会跳到 body 使累加错位；rect 差值法不受定位上下文
 *  影响，且平滑滚动中 rect 与 scrollTop 同步平移、差值稳定。 */
function anchorAbsTop(noteId: string, spot: { sectionId: string; order: number }): number | null {
  const root = scrollEl.value
  const anchor = anchorForSpot(noteId, spot)
  if (!root || !anchor) return null
  return root.scrollTop + anchor.getBoundingClientRect().top - root.getBoundingClientRect().top
}

/** spot 的回退估算顶：未挂载章用章节估算顶（prefixTops 前缀和）；章不存在返回 null */
function estimatedSpotTop(spot: { sectionId: string }, tops: number[]): number | null {
  const idx = ownSections.value.findIndex((s) => s.id === spot.sectionId)
  return idx >= 0 ? (tops[idx] ?? null) : null
}

/** 距当前阅读线（scrollTop + 40% 视口，与当前章检测同线）最近的 anchorSpots 下标。
 *  已挂载 → DOM 实测锚点顶；未挂载 → 章节估算顶；全部无法定位回退第一处。 */
function nearestSpotIndex(noteId: string, spots: { sectionId: string; order: number }[]): number {
  const root = scrollEl.value
  if (!root || spots.length <= 1) return 0
  const tops = prefixTops()
  return nearestIndexByDistance(
    spots.map((spot) => anchorAbsTop(noteId, spot) ?? estimatedSpotTop(spot, tops)),
    root.scrollTop + root.clientHeight * READER_TUNING.anchorLine
  )
}

/** 注释跳转：普通点击确定性取「距阅读线最近」的锚点；引用地图指定 spot
 *  （T23）精确跳到该处引用，未命中（旧数据/章重排）回退最近锚点。
 *  无正文锚点（纯嵌套/未引用注释）直接返回（卡片改为导航父注卡，T23）。 */
async function scrollToNote(
  noteId: string,
  spot?: { sectionId: string; order: number }
): Promise<void> {
  const root = scrollEl.value
  const note = ownBook.value?.notes.find((n) => n.id === noteId)
  if (!root || !note) return
  const spots = note.anchorSpots.filter((s): s is NoteBodySpot => s.kind === 'body')
  if (spots.length === 0) return
  jumpToken++ // T19：作废在途精调轮询（程序化滚动互相打断）
  tocPinAnchor = null // T19：卡片跳转引发的位移不计入用户滚动（落位重定基）
  let idx = nearestSpotIndex(noteId, spots)
  const k = spot
    ? spots.findIndex((s) => s.sectionId === spot.sectionId && s.order === spot.order)
    : -1
  if (k >= 0) idx = k
  const target = spots[idx]
  // T23 引用地图：跳转即声明当前锚点身份（引用处条目高亮立即生效）；
  // 落位后 commitActive 的几何真值接管（pin 存活期保留本声明值）
  readerState.activeAnchor = { noteId, sectionId: target.sectionId, order: target.order }
  jumpToSectionInstant(target.sectionId)
  await nextFrames(3)
  const anchor = anchorForSpot(noteId, target) ?? findAnchorEl(noteId)
  if (!anchor) return
  const top =
    root.scrollTop +
    anchor.getBoundingClientRect().top -
    root.getBoundingClientRect().top -
    root.clientHeight * READER_TUNING.noteAnchorLine
  root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  void settleThenRecompute(true) // T17-C：落位重算；T19：重定目录钉扎基准
  flashEl(anchor)
}

/** 锚点元素 → {noteId, sectionId, order}（T23）：anchorForSpot 的反向映射。
 *  章内位次 k（同注锚点按文档序）→ note.anchorSpots 中同章第 k 个 body spot。 */
function spotOfAnchor(el: Element): { noteId: string; sectionId: string; order: number } | null {
  const noteId = anchorRegistry.get(el)
  if (!noteId) return null
  const sectionId = el.closest('.section-frame')?.getAttribute('data-section-id') ?? ''
  if (!sectionId) return null
  const note = ownBook.value?.notes.find((n) => n.id === noteId)
  if (!note) return null
  const anchors = [...(anchorsByNote.get(noteId) ?? [])]
    .filter((a): a is HTMLElement => a instanceof HTMLElement && a.isConnected)
    .filter((a) => a.closest('.section-frame')?.getAttribute('data-section-id') === sectionId)
    .sort((a, b) => (anchorSeq.get(a) ?? 0) - (anchorSeq.get(b) ?? 0))
  const k = anchors.indexOf(el as HTMLElement)
  if (k < 0) return null
  const bodySpots = note.anchorSpots.filter(
    (s): s is NoteBodySpot => s.kind === 'body' && s.sectionId === sectionId
  )
  const spot = bodySpots[k]
  return spot ? { noteId, sectionId, order: spot.order } : null
}

function findAnchorEl(noteId: string): HTMLElement | null {
  const set = anchorsByNote.get(noteId)
  if (!set) return null
  for (const a of set) {
    if (a instanceof HTMLElement && a.isConnected) return a
  }
  return null
}

function flashEl(el: Element): void {
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), 2400)
}

/* ---------------- 事件 ---------------- */

/** 点击正文锚点 → 侧栏定位（事件委托，v-html 内容无 Vue 事件） */
function onClick(ev: MouseEvent): void {
  const target = ev.target
  if (!(target instanceof Element)) return
  const sup = target.closest('.zmu-ref')
  if (sup instanceof HTMLElement && sup.dataset.noteId) {
    requestSidebarLocate(sup.dataset.noteId)
  }
}

function onHeight(id: string, px: number): void {
  heightCache.set(id, px)
}

/* ---------------- 生命周期 ---------------- */

/** 关窗 flush 退订函数（M2；mock 桥不实现时为 undefined） */
let offFlush: (() => void) | undefined

onMounted(async () => {
  // T14/T17：正文用户输入 → 恢复跟随；scrollend → 通知收敛校验（wheel passive
  // 防滚动性能损失；keydown 挂 window capture——正文点击后 activeElement 常在
  // BODY，root 上的 keydown 监听收不到，T17-A）
  const root = scrollEl.value
  if (root) {
    root.addEventListener('scrollend', onScrollEnd)
    root.addEventListener('wheel', onReaderWheel, { passive: true })
    root.addEventListener('pointerdown', onReaderPointerDown)
  }
  window.addEventListener('keydown', onWindowKeydown, { capture: true, passive: true })

  // M2：主进程 close 拦截 → flush 通知 → 同步保存进度后 ack（invoke 顺序
  // 保证 saveProgress 先于 ack 被主进程处理）
  offFlush = window.api.onFlush?.(() => {
    try {
      doSaveProgress()
    } finally {
      void window.api.ackFlush?.()
    }
  })

  setupObservers()
  await nextTick()
  // 恢复阅读进度：先按估算跳，等实测高度回填收敛后再校正（T19：与跳转精调
  // 对齐为同一轮询辅助，取代双 rAF——冷挂载 >33ms 时双 rAF 校正同样失准）
  const p = bookState.restore
  if (p && ownSections.value.some((s) => s.id === p.sectionId)) {
    await nextFrames(2)
    jumpToSectionInstant(p.sectionId)
    const root = scrollEl.value
    const idx = ownSections.value.findIndex((s) => s.id === p.sectionId)
    if (root && idx >= 0) {
      // 先按估算高度落位；轮询等挂载实测回填收敛后按真值再校正（scrollToRestore 内部 clamp 界内）
      scrollToRestore(idx, p.ratio)
      const token = ++jumpToken // scrollToRestore 已作废旧令牌，此处取新令牌供轮询
      await waitForFineTuneTarget(p.sectionId, undefined, token)
      if (token === jumpToken) scrollToRestore(idx, p.ratio)
    }
  }
  restoreDone = true
  updateCurrentSection()
  onScroll()
})

// 重新解析（层级上限变更）：书对象被整体替换 → 同步快照、复位运行态并回到原章
watch(
  () => bookState.book,
  async (newBook, oldBook) => {
    if (!newBook || !oldBook) return // 初次装载由 onMounted 处理
    ownBook.value = newBook
    ownSections.value = newBook.sections
    const resumeId = readerState.currentSectionId
    teardownObservers()
    resetRuntime()
    await nextTick()
    setupObservers()
    if (resumeId && newBook.sections.some((s) => s.id === resumeId)) {
      jumpToken++ // T19：书对象已换代，作废在途精调轮询
      await nextFrames(2)
      jumpToSectionInstant(resumeId)
    }
  }
)

// 排版参数变化：实测高度失效，清空并回到当前章（防位置漂移）
watch(
  () => [settings.fontSize, settings.lineHeight, settings.contentWidth, settings.paragraphStyle],
  async () => {
    heightCache.clear()
    const id = readerState.currentSectionId
    jumpToken++ // T19：排版参数变更旧几何失效，作废在途精调轮询
    await nextFrames(2)
    if (id) jumpToSectionInstant(id)
  }
)

// 目录 / 侧栏 → 正文 的滚动请求
watch(
  () => readerState.scrollRequest.seq,
  () => {
    const req = readerState.scrollRequest
    if (!req.id) return
    if (req.kind === 'section') {
      // T17-B：目录跳转是用户输入（点击目录项），恢复跟随——「程序化滚动
      // 不恢复」语义只覆盖跟随收敛自身的滚动与卡片跳转
      resumeFollow()
      void scrollToSection(req.id, req.heading)
    } else {
      // T17-D：钉扎被点注为跟随焦点（挂起期与落位后一致，I3）；
      // pin 存活到下次用户正文滚动（resumeFollow 清除）
      pinFollowFocus(req.id)
      void scrollToNote(req.id, req.spot)
    }
  }
)

// 钉扎释放即按几何重算（T17-C/D 收口）：用户恢复跟随会清空 pinnedNoteId
// （readerStore.resumeFollow）。钉扎存活期 commitActive 走 pin 分支，activeSet
// 里可能残留跳转动画穿带时 IO 边沿漏网的非带内锚；pin 释放后按当前几何全
// 量重算一次，让 activeSet 与 focus 同时回到带内真值。用 settleThenRecompute
// 而非即时重算：恢复常由正文 wheel/keydown 触发，那本身就是一次滚动，需等
// 其停稳再取真值，否则重算后 IO 增量又会把穿带锚写回（T16-C 边沿丢失的残留）。
watch(
  () => readerState.pinnedNoteId,
  (pin, prev) => {
    if (prev && !pin) void settleThenRecompute()
  }
)

onBeforeUnmount(() => {
  offFlush?.()
  offFlush = undefined
  doSaveProgress()
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  if (scrollIdleTimer !== null) {
    window.clearTimeout(scrollIdleTimer)
    scrollIdleTimer = null
  }
  settleToken++ // 作废在途的落位重算轮询（T17-C）
  jumpToken++ // 作废在途的精调轮询（T19）
  const root = scrollEl.value
  if (root) {
    root.removeEventListener('scrollend', onScrollEnd)
    root.removeEventListener('wheel', onReaderWheel)
    root.removeEventListener('pointerdown', onReaderPointerDown)
  }
  window.removeEventListener('keydown', onWindowKeydown, { capture: true })
  teardownObservers()
})
</script>

<template>
  <div ref="scrollEl" class="reader-scroll" @scroll.passive="onScroll" @click="onClick">
    <div
      v-if="ownSections.length"
      class="reader-column"
      :style="{ '--reader-tail-vh': READER_TUNING.tailVh }"
    >
      <SectionFrame
        v-for="sec in ownSections"
        :key="sec.id"
        :ref="(el) => setFrameEl(sec.id, el)"
        :section="sec"
        :mounted="mountSet.has(sec.id) && !demotedSet.has(sec.id)"
        :estimated-height="estimateHeight(sec)"
        @height="onHeight"
        @anchors-ready="onAnchorsReady"
        @anchors-gone="onAnchorsGone"
      />
      <p class="reader-fin" aria-hidden="true">· 全书完 ·</p>
      <div class="reader-tail" aria-hidden="true"></div>
    </div>
    <div v-else class="reader-empty">
      <p>本书没有可渲染的正文内容。</p>
    </div>
  </div>
</template>

<style scoped>
.reader-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scroll-behavior: auto;
}

.reader-column {
  padding: 56px 0 0;
}

.reader-fin {
  margin: 72px 0 0;
  text-align: center;
  font-size: 13px;
  letter-spacing: 0.35em;
  color: var(--text-3);
  user-select: none;
}

/* 末尾留白：末章也能进入视口上部检测带（高度值由 READER_TUNING.tailVh 注入） */
.reader-tail {
  height: calc(var(--reader-tail-vh, 42) * 1vh);
}

.reader-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 14px;
}
</style>
