/**
 * 朱墨 ZhuMo —— 阅读列纯计算模块测试（vitest，node 环境）。
 *
 * 覆盖（T8 L3/L4/M3，T11 注释跳转，T14 侧栏跟随，T17 活跃集几何重算）：
 * - READER_TUNING 常量快照与三个 rootMargin 派生串（L3 收敛防回归：只收敛不改值）；
 * - 进度数学对称性：computeIntraRatio ↔ restoreScrollTop 双向 roundtrip 偏差为 0
 *   （clamp 边界单独断言语义）（L4）；
 * - DOM 预算降级选择与回挂保护带判定（M3：纯函数单测，等价于 12 万节点
 *   真实超预算场景中 ReaderView 的实际调用序列）；
 * - 最近锚点选择（T11 根因 1：scrollToNote 确定性/无游标的数学核心，
 *   ReaderView 侧仅负责 DOM 实测/章节估算回退的取数；T23：×N 循环下标
 *   已随 ×N 循环徽标退役，引用切换由引用地图取代）；
 * - 侧栏跟随可见性与收敛判定（T14）：isCardVisibleAt 顶部段判定与
 *   needsFollowCorrection 不变式谓词（NotesSidebar 侧仅 DOM 取数）；
 * - 活跃注释集（T17-C/D）：anchorInNoteBand 与 anchorIO rootMargin 同几何
 *   的带内相交判定（跳转落位后全量重算的谓词），selectFocusAnchor 带内
 *   「几何 top 最大」焦点选取（取代旧 commitActive 的登记 seq 最大者）。
 * - 目录标红钉扎（T19）：shouldReleaseTocPin 解除判定（净位移超限或 40% 线
 *   越过钉扎标题）、tocPinNetDisplacement 净位移口径（程序化基准未定不计、
 *   ±50px 往返为 0）与 isHeadingCrossedByLine 线界越过谓词。
 */
import { describe, expect, it } from 'vitest'
import {
  READER_TUNING,
  anchorInNoteBand,
  bandRootMargin,
  computeIntraRatio,
  contentBottom,
  estimateSectionHeight,
  heightsOf,
  isCardVisibleAt,
  isHeadingCrossedByLine,
  mountRootMargin,
  nearestIndexByDistance,
  needsFollowCorrection,
  noteBandBottom,
  noteBandRootMargin,
  prefixTopsOf,
  restoreScrollTop,
  selectDemotions,
  selectFocusAnchor,
  shouldReleaseTocPin,
  shouldUndemote,
  tocPinNetDisplacement
} from '../src/renderer/src/components/reader-math'

/* ================================================================== */
/* 调参常量与派生串（L3）                                                */
/* ================================================================== */

describe('READER_TUNING 与 rootMargin 派生（L3）', () => {
  it('调参常量快照（只收敛不改值）', () => {
    expect(READER_TUNING.anchorLine).toBe(0.4)
    expect(READER_TUNING.anchorBand).toBe(0.005)
    expect(READER_TUNING.anchorNoteBand).toBe(0.55)
    expect(READER_TUNING.noteAnchorLine).toBe(0.3)
    expect(READER_TUNING.domBudget).toBe(120_000)
    expect(READER_TUNING.mountMarginPct).toBe(200)
    expect(READER_TUNING.demoteGuardPct).toBe(100)
    expect(READER_TUNING.tailVh).toBe(42)
    expect(READER_TUNING.saveIntervalMs).toBe(2000)
    expect(READER_TUNING.colPadTop).toBe(56)
    expect(READER_TUNING.frameGap).toBe(56)
    expect(READER_TUNING.followFastMs).toBe(200)
    expect(READER_TUNING.followIdleMs).toBe(200)
    expect(READER_TUNING.cardVisibleRatio).toBe(0.25)
    expect(READER_TUNING.settleRecomputeMs).toBe(200)
  })

  it('rootMargin 字符串由常量派生', () => {
    expect(mountRootMargin()).toBe('200% 0px 200% 0px')
    expect(bandRootMargin()).toBe('-40% 0px -59.5% 0px')
    expect(noteBandRootMargin()).toBe('0px 0px -45% 0px')
  })
})

/* ================================================================== */
/* 高度估算与前缀和                                                      */
/* ================================================================== */

describe('高度估算与前缀和', () => {
  it('prefixTopsOf：padTop 起步，章间含 gap', () => {
    expect(prefixTopsOf([100, 200], 56, 56)).toEqual([56, 212])
    expect(prefixTopsOf([], 56, 56)).toEqual([])
  })

  it('contentBottom：末章底 + gap；空书为 0', () => {
    expect(contentBottom([56, 212], [100, 200], 56)).toBe(468)
    expect(contentBottom([], [], 56)).toBe(0)
  })

  it('estimateSectionHeight：字符数换算行数 × 行高 + 常量；每行字数下限 10', () => {
    const m = { contentWidth: 40, fontSize: 16, lineHeight: 1.8 }
    expect(estimateSectionHeight(1000, m)).toBe(Math.ceil(1000 / 40) * 28.8 + 150)
    // 极窄列：每行按 10 字计
    expect(estimateSectionHeight(100, { contentWidth: 1, fontSize: 16, lineHeight: 2 })).toBe(
      Math.ceil(100 / 10) * 32 + 150
    )
  })

  it('heightsOf：逐章求值', () => {
    const sections = [
      { id: 's1', title: '', level: 1, html: '', anchorIds: [] },
      { id: 's2', title: '', level: 1, html: '', anchorIds: [] }
    ]
    expect(heightsOf(sections, () => 300)).toEqual([300, 300])
  })
})

/* ================================================================== */
/* 进度数学对称性（L4）                                                  */
/* ================================================================== */

describe('进度数学对称性（L4）', () => {
  const a = READER_TUNING.anchorLine

  it('restore → compute：非 clamp 域 roundtrip 偏差为 0', () => {
    const ratios = [0, 0.001, 0.25, 0.5, 0.733, 0.999, 1]
    const tops = [0, 56, 5000, 123456]
    const heights = [100, 3000, 80000]
    const viewports = [400, 800, 1080]
    let checked = 0
    let clampedLow = 0
    for (const ratio of ratios) {
      for (const top of tops) {
        for (const h of heights) {
          for (const vh of viewports) {
            const maxScroll = top + h + vh // 上界宽松：上界 clamp 另测
            const st = restoreScrollTop(top, ratio, h, vh, a, maxScroll)
            const back = computeIntraRatio(st, vh, a, top, h)
            const unclamped = top + ratio * h - vh * a
            if (unclamped >= 0 && unclamped <= maxScroll) {
              expect(back, `ratio=${ratio} top=${top} h=${h} vh=${vh}`).toBeCloseTo(ratio, 12)
              checked++
            } else {
              // 下界 clamp：章顶距锚点线不足（矮章/靠书首），恢复位置钳到 0，
              // 比例必然有损——断言语义：回到顶部且还原比例不小于保存值
              expect(st, `ratio=${ratio} top=${top} h=${h} vh=${vh}`).toBe(0)
              expect(back).toBeGreaterThanOrEqual(ratio - 1e-9)
              clampedLow++
            }
          }
        }
      }
    }
    // 两种分支都确实被覆盖到（252 组合中非 clamp 域 186 个）
    expect(checked).toBeGreaterThan(150)
    expect(clampedLow).toBeGreaterThan(0)
  })

  it('compute → restore：非 clamp 域位置 roundtrip 偏差为 0', () => {
    const tops = [0, 56, 5000]
    const heights = [1000, 30000]
    const viewports = [400, 800]
    let checked = 0
    for (const top of tops) {
      for (const h of heights) {
        for (const vh of viewports) {
          for (let k = 0; k <= 10; k++) {
            // 锚点线落点在章内均匀取 11 档
            const st0 = top - vh * a + (h * k) / 10
            if (st0 < 0) continue
            const raw = (st0 + vh * a - top) / h
            if (raw < 0 || raw > 1) continue // compute 的 clamp 域（章间空隙）另测
            const maxScroll = top + h + vh
            const ratio = computeIntraRatio(st0, vh, a, top, h)
            const st1 = restoreScrollTop(top, ratio, h, vh, a, maxScroll)
            expect(st1, `top=${top} h=${h} vh=${vh} k=${k}`).toBeCloseTo(st0, 6)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('章内比例 clamp 0..1：锚点线在章外（章间空隙/书首）收敛到边界', () => {
    // 锚点线在章顶上方
    expect(computeIntraRatio(0, 800, 0.4, 5000, 3000)).toBe(0)
    // 锚点线在章底下方
    expect(computeIntraRatio(9000, 800, 0.4, 5000, 3000)).toBe(1)
  })

  it('restore 上界 clamp：恢复位置不超出 maxScroll', () => {
    // unclamped = 10000 + 1×5000 − 320 = 14680 > maxScroll=10000
    expect(restoreScrollTop(10000, 1, 5000, 800, 0.4, 10000)).toBe(10000)
    // 同参数上界宽松时不钳
    expect(restoreScrollTop(10000, 1, 5000, 800, 0.4, 20000)).toBe(14680)
  })
})

/* ================================================================== */
/* 最近锚点选择（T11；T23 ×N 循环下标已随徽标退役）                      */
/* ================================================================== */

describe('最近锚点选择 nearestIndexByDistance（T11）', () => {
  it('取距阅读线最近者（上方/下方候选均可命中）', () => {
    // 阅读线 560：候选 574（dist 14）vs 1744（dist 1184）
    expect(nearestIndexByDistance([574, 1744], 560)).toBe(0)
    // 阅读线 1600：1744 更近
    expect(nearestIndexByDistance([574, 1744], 1600)).toBe(1)
    // 阅读线恰在两者中点偏上/偏下
    expect(nearestIndexByDistance([100, 300], 199)).toBe(0)
    expect(nearestIndexByDistance([100, 300], 201)).toBe(1)
  })

  it('平局取文档序靠前者；空/单候选直接返回 0', () => {
    expect(nearestIndexByDistance([100, 300], 200)).toBe(0)
    // 值更近者胜出，与其在候选表中的顺序无关
    expect(nearestIndexByDistance([500, 100], 200)).toBe(1)
    expect(nearestIndexByDistance([], 500)).toBe(0)
    expect(nearestIndexByDistance([42], 999)).toBe(0)
  })

  it('null（未挂载且估算失效）候选被跳过；混合时仍在可定位者中取最近', () => {
    // 索引 0 无法定位：在 1/2 中取最近
    expect(nearestIndexByDistance([null, 500, 900], 850)).toBe(2)
    expect(nearestIndexByDistance([null, 500, 900], 600)).toBe(1)
    // 非有限数同 null 处理
    expect(nearestIndexByDistance([NaN, Infinity, 100], 0)).toBe(2)
  })

  it('全部无法定位回退第一处（兜底语义）', () => {
    expect(nearestIndexByDistance([null, null, null], 500)).toBe(0)
    expect(nearestIndexByDistance([NaN, null], 500)).toBe(0)
  })

  it('确定性：同一输入重复调用结果一致（T11 核心断言，无游标）', () => {
    const positions = [574, 1744, null, 60, 2100]
    const line = 560
    const results = new Set(
      Array.from({ length: 10 }, () => nearestIndexByDistance(positions, line))
    )
    expect(results.size).toBe(1)
    expect(results.has(0)).toBe(true)
  })
})

/* ================================================================== */
/* DOM 预算降级与回挂（M3）                                              */
/* ================================================================== */

describe('DOM 预算降级与回挂（M3）', () => {
  it('未超预算不降级', () => {
    const blocks = [
      { id: 'A', nodes: 50, top: 0, height: 1000 },
      { id: 'B', nodes: 50, top: 3000, height: 200 }
    ]
    expect(selectDemotions(blocks, 100, 0, 1000)).toEqual([])
  })

  it('超预算从离视口最远的非视口块开始降级，直至预算内', () => {
    const blocks = [
      { id: 'near', nodes: 50, top: 900, height: 200 }, // 视口 [0,1000] 内
      { id: 'mid', nodes: 60, top: 2000, height: 200 },
      { id: 'far', nodes: 60, top: 50000, height: 200 }
    ]
    // total=170 > 100：先降 far（最远，total→110），仍超再降 mid（total→50）
    expect(selectDemotions(blocks, 100, 0, 1000)).toEqual(['far', 'mid'])
  })

  it('视口内块永不降级（尽力降后仍超预算也不动视口）', () => {
    const blocks = [
      { id: 'inview', nodes: 200, top: 100, height: 800 }, // 视口 [0,1000] 内
      { id: 'far', nodes: 50, top: 50000, height: 200 }
    ]
    // total=250 > 100：降 far 后 total=200 仍超，但视口内不可降
    expect(selectDemotions(blocks, 100, 0, 1000)).toEqual(['far'])
  })

  it('回挂保护带：视口 ±guardPct% 相交即回挂（shouldUndemote）', () => {
    // 视口 [1000, 1000]，guard 100% → 保护带 [0, 3000]
    const g = READER_TUNING.demoteGuardPct
    // 视口上方紧邻（块底 1000 在带上沿 0 之上）
    expect(shouldUndemote(900, 100, 1000, 1000, g)).toBe(true)
    // 视口正中
    expect(shouldUndemote(1200, 300, 1000, 1000, g)).toBe(true)
    // 视口下方紧邻（块顶 1950 在带内，块底越过视口下沿不久）
    expect(shouldUndemote(1950, 100, 1000, 1000, g)).toBe(true)
    // 远离视口（上下两侧、保护带外）
    expect(shouldUndemote(-2000, 100, 1000, 1000, g)).toBe(false)
    expect(shouldUndemote(3100, 100, 1000, 1000, g)).toBe(false)
  })

  it('降级-回挂闭环：滚入保护带解除降级，重算预算再降更远者', () => {
    // 三章：A(0..1000)、B(3000..3200)、C(60000..60200)；节点预算 250
    const blocks = [
      { id: 'A', nodes: 200, top: 0, height: 1000 },
      { id: 'B', nodes: 100, top: 3000, height: 200 },
      { id: 'C', nodes: 100, top: 60000, height: 200 }
    ]
    const budget = 250
    const demoted = new Set<string>()
    // ① 视口 [0,1000]：total=400 超限 → 依次降最远的非视口块 C、B
    for (const id of selectDemotions(blocks, budget, 0, 1000)) demoted.add(id)
    expect([...demoted].sort()).toEqual(['B', 'C'])
    // ② 滚到 [2800,3800]：B 进入保护带 [1800,4800] → 回挂；C 仍在远处保持降级
    for (const b of blocks) {
      if (
        demoted.has(b.id) &&
        shouldUndemote(b.top, b.height, 2800, 1000, READER_TUNING.demoteGuardPct)
      ) {
        demoted.delete(b.id)
      }
    }
    expect(demoted.has('B')).toBe(false) // 回挂成功：滚到必可见
    expect(demoted.has('C')).toBe(true)
    // ③ 回挂后挂载集 {A,B}（300 节点）仍超预算 → 重算：降离视口最远的非视口块 A
    const mounted = blocks.filter((b) => !demoted.has(b.id))
    for (const id of selectDemotions(mounted, budget, 2800, 1000)) demoted.add(id)
    expect([...demoted].sort()).toEqual(['A', 'C'])
  })
})

/* ================================================================== */
/* 侧栏跟随：可见性判定与收敛决策（T14）                                 */
/* ================================================================== */

describe('侧栏跟随可见性 isCardVisibleAt（T14）', () => {
  const r = READER_TUNING.cardVisibleRatio // 0.25

  it('整卡在视口内 → 可见', () => {
    expect(isCardVisibleAt(100, 200, 0, 800, r)).toBe(true)
    expect(isCardVisibleAt(0, 800, 0, 800, r)).toBe(true)
  })

  it('卡顶部段进入视口即可见（不再要求整卡完全包含——减少换卡抖动）', () => {
    // 卡 [700, 900]：顶段 [700, 750] 在视口 [0,800] 内，底部出界仍可见
    expect(isCardVisibleAt(700, 900, 0, 800, r)).toBe(true)
    // 卡 [790, 990]：顶段 [790, 795] 刚入视口
    expect(isCardVisibleAt(790, 990, 0, 800, r)).toBe(true)
  })

  it('卡顶在视口底沿及以下 → 不可见', () => {
    expect(isCardVisibleAt(800, 1000, 0, 800, r)).toBe(false)
    expect(isCardVisibleAt(900, 1100, 0, 800, r)).toBe(false)
  })

  it('卡悬在视口上沿：顶部段未进视口 → 不可见；越过上沿 → 可见', () => {
    // 卡 [-100, 100]：顶段 [-100, -75] 全在上方 → 不可见
    expect(isCardVisibleAt(-100, 100, 0, 800, r)).toBe(false)
    // 卡 [-10, 110]：顶段 [-10, 15] 越过视口上沿 → 可见
    expect(isCardVisibleAt(-10, 110, 0, 800, r)).toBe(true)
  })

  it('零高度退化卡按顶点在视口内判定', () => {
    expect(isCardVisibleAt(300, 300, 0, 800, r)).toBe(true)
    expect(isCardVisibleAt(900, 900, 0, 800, r)).toBe(false)
  })

  it('ratio 边界：1 → 整卡与视口相交即可见；0 → 顶点在视口内', () => {
    expect(isCardVisibleAt(-50, 50, 0, 800, 1)).toBe(true) // 部分相交
    expect(isCardVisibleAt(-50, 50, 0, 800, 0)).toBe(false) // 顶点在上方
    expect(isCardVisibleAt(799, 999, 0, 800, 0)).toBe(true) // 顶点恰在视口内
  })
})

describe('侧栏跟随收敛决策 needsFollowCorrection（T14）', () => {
  const r = READER_TUNING.cardVisibleRatio

  it('挂起时恒不需要校正（不变式不适用于用户手动浏览）', () => {
    expect(needsFollowCorrection(true, 900, 1100, 0, 800, r)).toBe(false)
    expect(needsFollowCorrection(true, 100, 200, 0, 800, r)).toBe(false)
  })

  it('激活且不可见 → 需要校正（自愈动作触发条件）', () => {
    expect(needsFollowCorrection(false, 900, 1100, 0, 800, r)).toBe(true)
    expect(needsFollowCorrection(false, -100, 100, 0, 800, r)).toBe(true)
  })

  it('激活且可见（含顶段入视口）→ 不需要校正（不扰动）', () => {
    expect(needsFollowCorrection(false, 100, 200, 0, 800, r)).toBe(false)
    expect(needsFollowCorrection(false, 700, 900, 0, 800, r)).toBe(false)
  })
})

/* ================================================================== */
/* 活跃注释集：几何扫描与焦点选取（T17-C/D）                             */
/* ================================================================== */

describe('注释带相交判定 anchorInNoteBand（T17-C）', () => {
  const band = READER_TUNING.anchorNoteBand // 0.55
  const vh = 900 // 带底 = 495

  it('与 noteBandRootMargin 同一几何：rootMargin bottom -(1-band)%', () => {
    expect(noteBandRootMargin()).toBe('0px 0px -45% 0px')
    expect(noteBandBottom(vh, band)).toBeCloseTo(495)
  })

  it('带内锚点命中；带下/带上（整锚出带）不命中', () => {
    expect(anchorInNoteBand(100, 116, vh, band)).toBe(true) // 完全带内
    expect(anchorInNoteBand(490, 506, vh, band)).toBe(true) // 骑跨带底沿
    expect(anchorInNoteBand(495, 511, vh, band)).toBe(true) // 顶恰在带底（≤ 闭沿，IO 同语义）
    expect(anchorInNoteBand(496, 512, vh, band)).toBe(false) // 顶越过带底
    expect(anchorInNoteBand(600, 616, vh, band)).toBe(false) // 带下方
    expect(anchorInNoteBand(-50, -20, vh, band)).toBe(false) // 视口上方
  })

  it('骑跨视口上沿（底 > 0）即命中；完全在上方不命中', () => {
    expect(anchorInNoteBand(-30, 5, vh, band)).toBe(true)
    expect(anchorInNoteBand(-40, 0, vh, band)).toBe(false) // 底恰为 0，开界
  })

  it('零高锚点按点命中：top ≤ 带底 即活跃（IO 零面积闭区间）', () => {
    expect(anchorInNoteBand(300, 300, vh, band)).toBe(true)
    expect(anchorInNoteBand(495, 495, vh, band)).toBe(true) // 恰在带底
    expect(anchorInNoteBand(496, 496, vh, band)).toBe(false)
  })
})

describe('带内焦点选取 selectFocusAnchor（T17-D）', () => {
  it('空候选返回空串', () => {
    expect(selectFocusAnchor([])).toBe('')
  })

  it('取几何 top 最大者（非登记 seq 最大者）', () => {
    // 多锚缺陷场景：note-2 晚序锚（seq 大）几何更靠上，focus 应为更靠下的 note-6
    const anchors = [
      { noteId: 'note-2', seq: 1691, top: 120 }, // seq 最大但在带内更靠上
      { noteId: 'note-6', seq: 800, top: 300 } // 几何最靠下
    ]
    expect(selectFocusAnchor(anchors)).toBe('note-6')
  })

  it('文档序正常时与「seq 最大」语义重合（top 最大 ↔ 序最后）', () => {
    const anchors = [
      { noteId: 'note-1', seq: 0, top: 40 },
      { noteId: 'note-3', seq: 200, top: 210 },
      { noteId: 'note-4', seq: 300, top: 355 }
    ]
    expect(selectFocusAnchor(anchors)).toBe('note-4')
  })

  it('同 top 并列取 seq 较大者（确定性，重复调用结果一致）', () => {
    const a = { noteId: 'note-x', seq: 10, top: 200 }
    const b = { noteId: 'note-y', seq: 40, top: 200 }
    expect(selectFocusAnchor([a, b])).toBe('note-y')
    expect(selectFocusAnchor([b, a])).toBe('note-y')
  })

  it('负 top（骑跨上沿）仍参与比较', () => {
    const anchors = [
      { noteId: 'note-top', seq: 0, top: -12 },
      { noteId: 'note-mid', seq: 1, top: 88 }
    ]
    expect(selectFocusAnchor(anchors)).toBe('note-mid')
  })
})

/* ================================================================== */
/* 目录标红钉扎与精调轮询（T19）                                         */
/* ================================================================== */

describe('目录钉扎解除判定 shouldReleaseTocPin（T19）', () => {
  const releasePx = READER_TUNING.tocPinReleasePx // 80

  it('新常量快照（只收敛不改值）', () => {
    expect(READER_TUNING.tocPinReleasePx).toBe(80)
    expect(READER_TUNING.tocPinArrivePx).toBe(2)
    expect(READER_TUNING.tocPinArriveTimeoutMs).toBe(2500)
    expect(READER_TUNING.tocPinStableMs).toBe(400)
    expect(READER_TUNING.fineTunePollFrames).toBe(60)
    expect(READER_TUNING.fineTuneStableFrames).toBe(3)
    expect(READER_TUNING.tocPinCrossGraceMs).toBe(2000)
  })

  it('净位移未超阈值且未越线 → 维持钉扎（±50px 微滚不交接）', () => {
    expect(shouldReleaseTocPin(0, releasePx, false)).toBe(false)
    expect(shouldReleaseTocPin(50, releasePx, false)).toBe(false)
    expect(shouldReleaseTocPin(80, releasePx, false)).toBe(false) // 开界：恰达阈值不解除
  })

  it('净位移超阈值 → 解除（滚 >80px 交接几何真值）', () => {
    expect(shouldReleaseTocPin(81, releasePx, false)).toBe(true)
    expect(shouldReleaseTocPin(500, releasePx, false)).toBe(true)
  })

  it('未超阈值但 40% 线越过钉扎标题 → 解除（任一条件独立成立）', () => {
    expect(shouldReleaseTocPin(10, releasePx, true)).toBe(true)
    expect(shouldReleaseTocPin(0, releasePx, true)).toBe(true)
  })
})

describe('钉扎净位移 tocPinNetDisplacement（T19）', () => {
  it('基准未定（null，程序化滚动在途）恒 0', () => {
    expect(tocPinNetDisplacement(null, 0)).toBe(0)
    expect(tocPinNetDisplacement(null, 70_000)).toBe(0)
  })

  it('净位移口径（非路径累计）：±50px 往返各自为 50、回起点为 0', () => {
    const anchor = 10_000
    expect(tocPinNetDisplacement(anchor, 10_050)).toBe(50)
    expect(tocPinNetDisplacement(anchor, 9_950)).toBe(50)
    expect(tocPinNetDisplacement(anchor, 10_000)).toBe(0)
  })

  it('大位移取绝对值（上滚/下滚同判）', () => {
    expect(tocPinNetDisplacement(1_000, 2_500)).toBe(1_500)
    expect(tocPinNetDisplacement(2_500, 1_000)).toBe(1_500)
  })
})

describe('线界越过谓词 isHeadingCrossedByLine（T19）', () => {
  const lineY = 360 // 900px 视口的 40% 线

  it('钉扎落位（标题贴顶 16px）未越过', () => {
    expect(isHeadingCrossedByLine(16, lineY)).toBe(false)
    expect(isHeadingCrossedByLine(0, lineY)).toBe(false)
  })

  it('恰在线上（相等）不算越过（与几何 ≤ 闭沿同语义）', () => {
    expect(isHeadingCrossedByLine(360, lineY)).toBe(false)
  })

  it('标题顶落到线下方（用户滚回项起始之上）→ 越过', () => {
    expect(isHeadingCrossedByLine(361, lineY)).toBe(true)
    expect(isHeadingCrossedByLine(500, lineY)).toBe(true)
  })
})
