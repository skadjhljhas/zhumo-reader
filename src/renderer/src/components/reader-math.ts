/**
 * 朱墨 ZhuMo —— 阅读列纯计算模块（无 DOM / 无 Vue 依赖，可单测）。
 *
 * 收敛三类原本散落在 ReaderView 中的数学：
 * - READER_TUNING：阅读列全部调参常量（只收敛不改值），并派生三个
 *   IntersectionObserver 的 rootMargin 字符串，消除同语义多处字面量；
 * - 进度数学：章内比例（computeIntraRatio）与恢复位置（restoreScrollTop）
 *   互为逆运算，锚点线共用同一比例，保证 save→restore 对称（roundtrip 偏差 0）；
 * - DOM 预算：超预算时选择降级块的决策（selectDemotions）与回挂保护带
 *   判定（shouldUndemote），供 M3「降级块滚回可见时重新挂载」使用。
 * - 侧栏跟随（T14）：卡片可见性放宽判定（isCardVisibleAt）与收敛决策
 *   （needsFollowCorrection）——「跟随激活且正文静止时 focus 卡在侧栏可见」
 *   不变式的数学核心，NotesSidebar 侧仅负责 DOM 取数。
 * - 活跃注释集（T17-C/D）：注释带相交判定（anchorInNoteBand，与 anchorIO
 *   rootMargin 同一几何）与带内焦点选取（selectFocusAnchor，「几何 top
 *   最大」取代旧「登记 seq 最大」）——跳转落位后全量重算的数学核心。
 * - 目录标红钉扎（T19）：解除判定（shouldReleaseTocPin：用户滚动净位移
 *   超限或 40% 线越过钉扎标题）、净位移口径（tocPinNetDisplacement，
 *   ±50px 往返为 0，程序化滚动基准未定不计）与线界越过谓词
 *   （isHeadingCrossedByLine）——ReaderView 侧仅负责 DOM 取数。
 */
import type { Section } from '../../../shared/types'

/* ------------------------------------------------------------------ */
/* 调参常量                                                             */
/* ------------------------------------------------------------------ */

export const READER_TUNING = {
  /** 进度锚点线：视口上部 40% 处（当前章检测带同一线）。
   *  保存（intraRatio）与恢复（scrollToRestore）必须共用同一比例，保证锚点对称。 */
  anchorLine: 0.4,
  /** 当前章检测带高度（占视口比例，0.5%）：bandIO 在锚点线处开带 */
  anchorBand: 0.005,
  /** 活跃注释带：视口顶部 55%（anchorIO 把视口收成此带，带内锚点为活跃集） */
  anchorNoteBand: 0.55,
  /** 注释定位线：跳转注释时锚点落至视口 30% 处 */
  noteAnchorLine: 0.3,
  /** DOM 预算：挂载块节点总数上限，超出时把离视口最远者降回占位 */
  domBudget: 120_000,
  /** 懒挂载预挂载带：mountIO rootMargin（±视口高百分比） */
  mountMarginPct: 200,
  /** 降级保护带：视口 ±此百分比内的降级块滚入即回挂（小于预挂载带） */
  demoteGuardPct: 100,
  /** 尾部留白（vh）：末章也能进入视口上部检测带（注入 CSS 变量 --reader-tail-vh） */
  tailVh: 42,
  /** 进度保存节流间隔（ms），与主进程 store 节流窗口一致 */
  saveIntervalMs: 2000,
  /** 列顶留白与章间距（px），高度前缀和与进度分母计算用 */
  colPadTop: 56,
  frameGap: 56,
  /** 侧栏跟随快路径 debounce（ms）：focusNoteId 变化后延迟定位（T14） */
  followFastMs: 200,
  /** 侧栏跟随收敛兜底：正文滚动停稳判定 debounce（ms，scrollend 缺发时兜底，T14） */
  followIdleMs: 200,
  /** 侧栏跟随可见阈值：卡顶部此比例高度段进入视口即视为可见（T14） */
  cardVisibleRatio: 0.25,
  /** 侧栏跟随收敛校验迭代轮数上限（T14）：v-html/字体/公式等异步布局
   *  可能使一次定位失效，布局静止后复检直至可见 */
  followSettleRounds: 3,
  /** 布局静止探测：最多等待帧数上限（T14） */
  followSettleFrames: 10,
  /** 布局静止探测：scrollHeight 连续不变帧数即判定静止（T14） */
  followSettleStableFrames: 2,
  /** 程序化滚动落位兜底 debounce（T17-C）：scrollend 缺发（smooth 被挂载
   *  高度回填打断等）时，最后一次 scroll 事件后此毫秒数仍执行全量几何重算 */
  settleRecomputeMs: 200,
  /** 目录钉扎解除净位移阈值（T19）：用户滚动自落位基准的净位移超过此值
   *  即解除标红钉扎、交接几何真值；以内（±50px 微滚/phg 书边界抖动）不交接 */
  tocPinReleasePx: 80,
  /** 目录钉扎重定基的到达容差（T19）：smooth 精调后 |st − 意图落位| ≤ 此值
   *  视为真正到达，才重定位移基准。settle 的 200ms 稳定窗在 smooth 减速尾段
   *  会提前判稳，基准钉在中间位 → smooth 走完净位移超阈值误解除
   *  （edge-cases #6 实测：st=2904 判稳而终位 3051），故重定基改挂到达确认 */
  tocPinArrivePx: 2,
  /** 到达确认墙钟上限（T19）：headless/高刷下 rAF 不受 vsync 节流，帧数上限
   *  可能只覆盖数百 ms 墙钟（实测 60 帧 ≈ 400ms < smooth 动画时长），超时
   *  fallback 会把基准钉在 smooth 途中 → 净位移误超阈值解除。改用墙钟上限，
   *  覆盖最长 smooth 动画 + 余量 */
  tocPinArriveTimeoutMs: 2500,
  /** 到达确认的停稳窗（T19）：st 连续此毫秒内每帧位移 < 0.5px 视为真停稳
   *  （书尾 clamp/布局漂移致意图位不可达时，以停稳位重定基）；减速尾段
   *  可能短暂满足，但此时距终位 < tocPinReleasePx，误重定无害 */
  tocPinStableMs: 400,
  /** 跳转精调轮询帧数上限（T19-P1）：远距跳转后逐 rAF 等目标章 body 就绪
   *  且落位几何稳定，超时保持估算位（1.0.7 双 rAF 不够时静默丢精调） */
  fineTunePollFrames: 60,
  /** 精调就绪判定：候选落位几何连续此帧数位移 < 0.5px 才视为就绪 */
  fineTuneStableFrames: 3,
  /** 目录钉扎线界越过解除的落位静默窗（T19）：程序化落位后邻章挂载/高度回填
   *  会使被点标题瞬时上下平移、瞬时越过 40% 线（短节书实测）；窗内只认净位移
   *  解除。真实用户越线滚动的位移必然 > tocPinReleasePx（落位标题距线 ≈
   *  0.4vh−16px），位移条件先触发，静默窗不漏真实的用户解除。 */
  tocPinCrossGraceMs: 2000
} as const

/** 比例 → 百分比字符串（40 → '40%'，59.5 → '59.5%'） */
function pct(ratio: number): string {
  return `${+(ratio * 100).toFixed(3)}%`
}

/** mountIO rootMargin：预挂载带 ±mountMarginPct% 视口 */
export function mountRootMargin(): string {
  const m = `${READER_TUNING.mountMarginPct}% 0px`
  return `${m} ${m}`
}

/** bandIO rootMargin：锚点线处的检测带（高 anchorBand） */
export function bandRootMargin(): string {
  const top = pct(READER_TUNING.anchorLine)
  const bottom = pct(1 - READER_TUNING.anchorLine - READER_TUNING.anchorBand)
  return `-${top} 0px -${bottom} 0px`
}

/** anchorIO rootMargin：视口收成顶部 anchorNoteBand 的活跃注释带 */
export function noteBandRootMargin(): string {
  return `0px 0px -${pct(1 - READER_TUNING.anchorNoteBand)} 0px`
}

/* ------------------------------------------------------------------ */
/* 高度估算与位置前缀和                                                 */
/* ------------------------------------------------------------------ */

export interface TypeMetrics {
  contentWidth: number
  fontSize: number
  lineHeight: number
}

/** 章内容高估算：字符数 / 每行字数 × 行高 + 标题与留白常量（ReaderView 侧另有实测缓存） */
export function estimateSectionHeight(chars: number, m: TypeMetrics): number {
  const perLine = Math.max(10, m.contentWidth)
  const linePx = m.fontSize * m.lineHeight
  return Math.ceil(chars / perLine) * linePx + 150
}

/** 各章内容顶坐标前缀和（全部用缓存/估算高度，不读 DOM，可在滚动帧内调用） */
export function prefixTopsOf(heights: number[], padTop: number, gap: number): number[] {
  const tops: number[] = []
  let acc = padTop
  for (const h of heights) {
    tops.push(acc)
    acc += h + gap
  }
  return tops
}

/** 全书正文底坐标（末章底 + 章间距；尾部留白不计入阅读进度分母） */
export function contentBottom(tops: number[], heights: number[], gap: number): number {
  const count = heights.length
  return count ? tops[count - 1] + heights[count - 1] + gap : 0
}

/* ------------------------------------------------------------------ */
/* 进度数学：章内比例与恢复位置（互为逆运算）                            */
/* ------------------------------------------------------------------ */

/** 章内进度：锚点线位置相对章顶的比例，clamp 0..1（锚点落入章间空隙/书尾留白时收敛到边界） */
export function computeIntraRatio(
  scrollTop: number,
  viewportH: number,
  anchorLine: number,
  sectionTop: number,
  sectionHeight: number
): number {
  const line = scrollTop + viewportH * anchorLine
  return Math.min(1, Math.max(0, (line - sectionTop) / Math.max(1, sectionHeight)))
}

/** computeIntraRatio 的逆运算：章内比例还原为 scrollTop。
 *  锚点线要回到保存时的同一相对位置，故必须扣回同一锚点线视口偏移
 *  （否则恢复位置恒偏 anchorLine×视口高，连续 reload 每轮再漂）；clamp 到可滚范围。 */
export function restoreScrollTop(
  sectionTop: number,
  ratio: number,
  sectionHeight: number,
  viewportH: number,
  anchorLine: number,
  maxScroll: number
): number {
  const anchorY = sectionTop + ratio * sectionHeight
  return Math.min(maxScroll, Math.max(0, anchorY - viewportH * anchorLine))
}

/** 由各章高度估算表提取工具：ReaderView 的 estimateHeight（含缓存）逐章求值后传入 */
export function heightsOf(sections: Section[], estimate: (sec: Section) => number): number[] {
  return sections.map(estimate)
}

/* ------------------------------------------------------------------ */
/* 注释跳转：最近锚点选择（T11；T23 循环下标已随 ×N 徽标退役）           */
/* ------------------------------------------------------------------ */

/**
 * 最近锚点选择：给定各候选锚点的绝对顶坐标（null = 无法定位，如未挂载章
 * 且章节估算失效）与当前阅读线，返回距离最近的候选下标。
 * 平局取文档序靠前者（严格小于比较，先到者不被取代）；全部无法定位回退 0。
 * 纯函数、无游标：同一输入恒同一输出（T11 确定性要求，可单测）。
 */
export function nearestIndexByDistance(positions: (number | null)[], readingLine: number): number {
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  let located = false
  for (let i = 0; i < positions.length; i++) {
    const top = positions[i]
    if (top === null || !Number.isFinite(top)) continue
    located = true
    const dist = Math.abs(top - readingLine)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return located ? best : 0
}

/* ------------------------------------------------------------------ */
/* DOM 预算：降级决策与回挂保护带（M3）                                  */
/* ------------------------------------------------------------------ */

export interface DomBlockInfo {
  id: string
  /** 该挂载块的 DOM 节点总数 */
  nodes: number
  /** 块顶坐标（前缀和） */
  top: number
  /** 块高（估算/缓存） */
  height: number
}

/**
 * DOM 预算降级决策：挂载块节点总数超预算时，从「离视口中心最远的
 * 非视口内块」开始依次降级（不降级视口内的块），降至预算内即止。
 * 纯函数：不触碰 DOM，行为可单测（等价于 12 万节点的真实场景）。
 */
export function selectDemotions(
  blocks: DomBlockInfo[],
  budget: number,
  viewportTop: number,
  viewportHeight: number
): string[] {
  const vBottom = viewportTop + viewportHeight
  const vCenter = viewportTop + viewportHeight / 2
  let total = 0
  const candidates: { id: string; nodes: number; dist: number; inView: boolean }[] = []
  for (const b of blocks) {
    total += b.nodes
    candidates.push({
      id: b.id,
      nodes: b.nodes,
      dist: Math.abs(b.top + b.height / 2 - vCenter),
      inView: b.top + b.height > viewportTop && b.top < vBottom
    })
  }
  if (total <= budget) return []
  const demoted: string[] = []
  candidates
    .filter((c) => !c.inView)
    .sort((a, b) => b.dist - a.dist)
    .forEach((c) => {
      if (total <= budget) return
      demoted.push(c.id)
      total -= c.nodes
    })
  return demoted
}

/** 回挂判定：块与「视口 ± guardPct% 视口高」保护带相交即应回挂。
 *  滚入保护带的降级块被解除降级，保证滚到时内容必然可见（M3）。 */
export function shouldUndemote(
  top: number,
  height: number,
  viewportTop: number,
  viewportHeight: number,
  guardPct: number
): boolean {
  const guard = (viewportHeight * guardPct) / 100
  return top + height > viewportTop - guard && top < viewportTop + viewportHeight + guard
}

/* ------------------------------------------------------------------ */
/* 侧栏跟随：可见性判定与收敛决策（T14）                                 */
/* ------------------------------------------------------------------ */

/**
 * 侧栏跟随可见性判定（T14）：卡顶部 ratio 比例高度段与视口相交即视为可见。
 * 放宽自「整卡完全包含」——focus 连续换卡时顶段已入视即不滚，减少小幅抖动。
 * 纯函数：坐标均为视口坐标系（可由 getBoundingClientRect 差值取得），可单测。
 */
export function isCardVisibleAt(
  cardTop: number,
  cardBottom: number,
  viewTop: number,
  viewBottom: number,
  ratio: number
): boolean {
  const h = Math.max(0, cardBottom - cardTop)
  const r = Math.min(1, Math.max(0, ratio))
  const topSegBottom = cardTop + h * r
  return topSegBottom > viewTop && cardTop < viewBottom
}

/**
 * 侧栏跟随收敛决策（T14）：跟随激活且 focus 卡不可见时需要校正。
 * 不变式「跟随激活且正文静止时 focus 卡在侧栏可见」的谓词形式——
 * 快路径（focusNoteId 变化 debounce 后）与慢路径（正文滚动停稳校验）
 * 共用；挂起（followSuspended）时恒不校正。
 */
export function needsFollowCorrection(
  suspended: boolean,
  cardTop: number,
  cardBottom: number,
  viewTop: number,
  viewBottom: number,
  ratio: number
): boolean {
  return !suspended && !isCardVisibleAt(cardTop, cardBottom, viewTop, viewBottom, ratio)
}

/* ------------------------------------------------------------------ */
/* 活跃注释集：几何扫描与焦点选取（T17-C/D）                             */
/* ------------------------------------------------------------------ */

/**
 * 活跃注释带底（视口相对坐标，相对滚动容器可视区顶）：视口顶部
 * anchorNoteBand 比例处。anchorIO 的 rootMargin 为 bottom -(1-band)，
 * 带内判定「锚点 rect 与该带相交」必须与此同一几何（真值口径：
 * visBot > 0 && visTop ≤ vh × band）。Chrome 按整数像素舍入
 * rootMargin，故 vh×band 消浮点误差（900px 视口 → 495）。
 */
export function noteBandBottom(viewportH: number, band: number): number {
  const r = viewportH * band
  // 消掉 0.55 一类比例的二进制浮点误差（900×0.55 = 495.00000000000006）
  return Math.round(r * 1e6) / 1e6
}

/**
 * 锚点是否落在活跃注释带内（T17-C）：元素的**视口相对**顶/底坐标
 * （rect.top - root.rect.top，切勿叠加 scrollTop——那是内容坐标，深滚
 * 后会把带内锚全误判为带外）与 [0, bandBottom] 相交。等价的 IO 语义为
 * 「bottom rootMargin -(1-band)% 时 isIntersecting」；零面积（零高）目标
 * 按点命中、恰在带底沿仍算相交（IO 对零高 rect 用闭区间），故上界取 ≤。
 */
export function anchorInNoteBand(
  relTop: number,
  relBottom: number,
  viewportH: number,
  band: number
): boolean {
  return relBottom > 0 && relTop <= noteBandBottom(viewportH, band)
}

/**
 * 带内跟随焦点选取（T17-D）：候选锚点（已按带内过滤）中取「几何位置
 * 最靠下」者——文档序 seq 作同分/并列裁决（平局取序靠后者，与旧「seq
 * 最大」语义在正常文档流下重合）。取代旧 commitActive 的「注的全部登记
 * 锚中 seq 最大者」：多锚注的晚序锚不在带内时不再把 focus 抬到该注
 * （违反 I3）。空候选返回 ''。纯函数，可单测。
 */
export function selectFocusAnchor<T extends { noteId: string; seq: number; top: number }>(
  anchorsInBand: T[]
): string {
  let focus = ''
  let bestTop = Number.NEGATIVE_INFINITY
  let bestSeq = Number.NEGATIVE_INFINITY
  for (const a of anchorsInBand) {
    const top = a.top
    if (top > bestTop || (top === bestTop && a.seq > bestSeq)) {
      bestTop = top
      bestSeq = a.seq
      focus = a.noteId
    }
  }
  return focus
}

/* ------------------------------------------------------------------ */
/* 目录标红钉扎（T19）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 目录钉扎解除判定（T19）：用户滚动净位移超过阈值，或钉扎标题被 40% 检测
 * 线越过（标题顶落到线下方，几何真值必然换项）即解除。任一条件独立成立。
 * 纯函数，可单测。
 */
export function shouldReleaseTocPin(
  netDisplacementPx: number,
  releasePx: number,
  titleCrossed: boolean
): boolean {
  return netDisplacementPx > releasePx || titleCrossed
}

/**
 * 钉扎位移基准的净位移（T19）：基准未定（null，程序化滚动在途）恒 0——
 * 进度恢复/卡片跳转引发的位移不计入用户滚动。取 |scrollTop − 基准| 而非
 * 路径累计：±50px 往返净位移为 0，phg 书边界检测带的抖动翻转被钉扎吸收。
 */
export function tocPinNetDisplacement(anchorPx: number | null, scrollTop: number): number {
  return anchorPx === null ? 0 : Math.abs(scrollTop - anchorPx)
}

/**
 * 钉扎标题是否已被 40% 线越过（T19）：标题元素视口顶落到检测线（lineY）
 * 下方即越过——用户滚回被点项起始之上，几何真值不再是被点项。恰在线上
 * （相等）不算越过，与「线上方最后一个标题」的 ≤ 闭沿语义一致。
 */
export function isHeadingCrossedByLine(headingTop: number, lineY: number): boolean {
  return headingTop > lineY
}
