/**
 * 朱墨 ZhuMo —— 阅读态共享store（非持久化，随书籍切换重置）。
 *
 * ReaderView / NotesSidebar / TocDrawer / AppToolbar 之间经由本对象协同：
 * - currentSectionId：当前可视章（驱动进度记录）
 * - currentHeadingTitle：当前章内 40% 线上方最后一个标题文本（目录小节级高亮）
 * - progress：全书进度 0..1（工具栏百分比与顶部进度条）
 * - activeNoteIds / focusNoteId：正文锚点越过 55% 线的活跃集与跟随焦点
 * - activeAnchor（T23 引用地图）：当前活跃锚点身份 {noteId, sectionId, order}——
 *   跳转时由 ReaderView 先行声明（引用处条目高亮立即生效），落位后由
 *   commitActive 的几何真值接管；NoteCard 据此高亮「当前阅读处」条目
 * - followSuspended / followCorrectionSeq：侧栏跟随挂起状态机与收敛校验
 *   请求（T14）：用户与侧栏交互 → 挂起；用户与正文交互（wheel/键盘/滚动条/
 *   目录跳转）→ 恢复并立即校验；正文滚动停稳（ReaderView 通知）→ 兜底校验。
 *   取代原 1s 时间窗语义。
 * - pinnedNoteId：跟随焦点钉扎（T17-D），点卡跳转后到下次用户正文滚动前
 *   focus 优先取被点注（I3 双保险）；resumeFollow / resetReaderState 清除
 * - pinnedTocId：目录标红钉扎（T19），目录跳转后标红（章/小节）恒为被点项，
 *   用户滚动净位移超 tocPinReleasePx 或 40% 线越过被点标题才解除（P2/P3：
 *   短节落位时 40% 线越入下一节的几何态被 pin 吸收）；resetReaderState 清除
 * - scrollRequest：目录/侧栏 → 正文 的滚动请求（seq 单调递增作触发器）
 * - sidebarRequest：正文锚点点击 → 侧栏 的定位请求
 * - visitedSections：本次会话读过的章（目录小圆点）
 */
import { reactive } from 'vue'

export interface ScrollRequest {
  kind: 'section' | 'note'
  id: string
  /** 目录小节级定位：标题文本（与章内 h1/h2/h3 匹配），缺省滚到章首 */
  heading?: string
  /** 注释锚点精确定位（T23 引用地图）：指定跳到某处正文引用；
   *  缺省取距阅读线最近锚点（仅 kind='note' 有意义） */
  spot?: { sectionId: string; order: number }
  seq: number
}

export interface SidebarRequest {
  noteId: string
  seq: number
}

/** 侧栏跟随收敛校验来源（T14）：resume = 正文用户输入恢复跟随；idle = 正文滚动停稳 */
export type FollowCorrectionPhase = 'resume' | 'idle'

export const readerState = reactive({
  currentSectionId: '',
  currentHeadingTitle: '',
  progress: 0,
  activeNoteIds: new Set<string>(),
  focusNoteId: '',
  visitedSections: new Set<string>(),
  scrollRequest: { kind: 'section', id: '', seq: 0 } as ScrollRequest,
  sidebarRequest: { noteId: '', seq: 0 } as SidebarRequest,
  /** 侧栏跟随挂起（T14）：用户与侧栏交互（滚轮/滚动条/键盘滚动/卡片点击）置 true，
   *  与正文交互（wheel/键盘/滚动条拖动/目录跳转）置 false；挂起期间跟随快/慢路径均跳过 */
  followSuspended: false,
  /** 侧栏跟随收敛校验请求（T14）：seq 递增触发 NotesSidebar 校验不变式 */
  followCorrectionSeq: 0,
  followCorrectionPhase: 'idle' as FollowCorrectionPhase,
  /** 跟随焦点钉扎（T17-D）：点击注释卡跳转后，到下次用户正文滚动前，
   *  commitActive 的 focus 优先取此注（保证「被点注即 focus」的 I3 语义） */
  pinnedNoteId: '',
  /** 目录标红钉扎（T19）：目录跳转入口设 pin，存活期标红（章/小节）恒为
   *  被点项（pin 优先于 bandIO 增量/停稳重算的几何判定）；用户滚动净位移
   *  超阈值或 40% 线越过被点标题时由 ReaderView 解除，程序化滚动不解除 */
  pinnedTocId: '',
  /** 钉扎项对应章（T19）：标红章钉扎与线界越过检查的取数键 */
  pinnedTocSectionId: '',
  /** 钉扎项标题（T19）：标红小节钉扎（空 = 无小节级钉扎） */
  pinnedTocHeading: '',
  /** 当前活跃锚点身份（T23 引用地图）：引用处条目高亮用；无活跃锚点为 null */
  activeAnchor: null as { noteId: string; sectionId: string; order: number } | null
})

// 开发/预览模式的只读诊断钩子（E2E/CDP 验证脚本取 readerState 真值；
// 与 api-mock 同一门控：dev 构建或 ?mock=1 预览，生产应用不存在）
try {
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).get('mock') === '1') {
    ;(window as unknown as { __zhumoReaderState?: typeof readerState }).__zhumoReaderState =
      readerState
  }
} catch {
  /* 非浏览器环境忽略 */
}

/** 开新书时复位全部阅读态 */
export function resetReaderState(): void {
  readerState.currentSectionId = ''
  readerState.currentHeadingTitle = ''
  readerState.progress = 0
  readerState.activeNoteIds = new Set()
  readerState.focusNoteId = ''
  readerState.visitedSections = new Set()
  readerState.scrollRequest = { kind: 'section', id: '', seq: 0 }
  readerState.sidebarRequest = { noteId: '', seq: 0 }
  readerState.followSuspended = false
  readerState.followCorrectionSeq = 0
  readerState.followCorrectionPhase = 'idle'
  readerState.pinnedNoteId = ''
  readerState.activeAnchor = null
  unpinToc()
}

/** 挂起侧栏跟随（T14）：用户与侧栏交互（滚轮/滚动条拖动/键盘滚动/卡片点击/
 *  正文锚点定位）时调用。挂起期间跟随快/慢路径均跳过（focus 高亮不受影响），
 *  用户点击卡片仍正常跳正文；直到用户与正文交互才恢复。取代原 1s 时间窗。 */
export function suspendFollow(): void {
  readerState.followSuspended = true
}

/** 恢复侧栏跟随并请求一次立即收敛校验（T14）：用户与正文交互（wheel/键盘滚动/
 *  滚动条拖动/目录跳转）时调用。程序化正文滚动（卡片跳转/进度恢复、以及跟随
 *  收敛自身的滚动）不经过本函数——以输入事件而非 scroll 事件判定，天然区分
 *  用户输入。T17-A：键盘滚动改由 window keydown 判定（activeElement 常在
 *  BODY 使事件冒泡不到组件 root）；T17-B：目录跳转是用户输入，应当恢复。
 *  恢复同时清除跟随焦点钉扎（T17-D：pin 只存活到下次用户正文滚动为止）。 */
export function resumeFollow(): void {
  readerState.pinnedNoteId = ''
  if (readerState.followSuspended) {
    readerState.followSuspended = false
    readerState.followCorrectionPhase = 'resume'
    readerState.followCorrectionSeq++
  }
}

/** 钉扎跟随焦点到某注（T17-D）：点击注释卡跳转正文时调用；commitActive 在
 *  钉扎注仍在活跃集时优先以其为 focus（挂起期与落位后均为被点注，保证 I3）。 */
export function pinFollowFocus(noteId: string): void {
  readerState.pinnedNoteId = noteId
}

/** 钉扎目录标红到某目录项（T19）：目录跳转入口调用；存活期标红（章/小节）
 *  恒为被点项——pin 优先于几何判定（短节落位 40% 线越界的几何态、phg 书
 *  边界 ±50px 抖动翻转均被 pin 吸收）。解除见 unpinToc / resetReaderState。 */
export function pinTocItem(tocId: string, sectionId: string, heading: string): void {
  readerState.pinnedTocId = tocId
  readerState.pinnedTocSectionId = sectionId
  readerState.pinnedTocHeading = heading
}

/** 解除目录标红钉扎（T19）：用户滚动净位移超 tocPinReleasePx 或 40% 线越过
 *  被点标题时由 ReaderView 调用；解除后标红立即交回几何真值。 */
export function unpinToc(): void {
  readerState.pinnedTocId = ''
  readerState.pinnedTocSectionId = ''
  readerState.pinnedTocHeading = ''
}

/** 请求正文滚动到某章 / 某注释锚点；heading 用于目录小节级精确定位；
 *  spot 用于注释引用地图的指定锚点跳转（T23，缺省取最近锚点）。 */
export function requestScroll(
  kind: ScrollRequest['kind'],
  id: string,
  heading?: string,
  spot?: { sectionId: string; order: number }
): void {
  readerState.scrollRequest = { kind, id, heading, spot, seq: readerState.scrollRequest.seq + 1 }
}

/** 请求侧栏定位到某注释卡 */
export function requestSidebarLocate(noteId: string): void {
  readerState.sidebarRequest = { noteId, seq: readerState.sidebarRequest.seq + 1 }
}

/** 双 rAF：等一帧布局 + 一帧绘制（高度估算误差校正的节拍） */
export function nextFrames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) resolve()
      else requestAnimationFrame(() => step(left - 1))
    }
    step(n)
  })
}
