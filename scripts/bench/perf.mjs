#!/usr/bin/env node
/**
 * 朱墨基准脚本（CDP over 无头 Edge，Node 原生 fetch/WebSocket）。
 *
 * 整理自 T4 阶段的 .perf/perf.mjs（口径不变，工程化入库）：
 *   D7 解析与首屏：导航 → worker 解析完成 / 首个 section 可见，3 轮取中位
 *   D8 滚动性能：scrollTop 分步推进覆盖 ≥50% 全高，rAF 帧间隔 avg/p95/max/掉帧
 *   D9 内存与 DOM：usedJSHeapSize、DOM 节点数 + CDP Performance.getMetrics
 *   D11 edge-cases：console 无异常、warnings 计数、孤儿分组/缺失卡/环标记出现
 *
 * 工程约定（沿用既有结论）：
 *   - 静态预览走 4175（伺服 out/renderer，.serve.mjs）；脚本未探测到服务时自动拉起
 *   - 每次运行使用独立 Edge 会话（临时 profile，用后即删，不污染机器）
 *   - 预览 URL 一律带 ?mock=1 显式开启浏览器预览桩（生产构建默认不注入 mock）
 *
 * 参数化（环境变量）：
 *   ZHUMO_BENCH_BASE     静态预览基址（默认 http://localhost:4175）
 *   ZHUMO_BENCH_BOOK     压测书：stress-50w（默认）/ phg-sample / edge-cases
 *   ZHUMO_BENCH_EDGE     Edge 可执行文件路径（默认 x64 系统安装位置）
 *   ZHUMO_BENCH_CDP_PORT CDP 端口（默认 9225）
 *
 * 用法：npm run bench（前置：npm run build 已产出 out/renderer）
 * 输出：控制台报告 + scripts/bench/report.json，并与 baseline.json 对比打印
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 基准工具脚本 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const BASE = process.env.ZHUMO_BENCH_BASE || 'http://localhost:4175'
const STRESS_BOOK = process.env.ZHUMO_BENCH_BOOK || 'stress-50w'
const EDGE_BOOK = 'edge-cases'
const EDGE =
  process.env.ZHUMO_BENCH_EDGE ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = Number(process.env.ZHUMO_BENCH_CDP_PORT || 9225)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 静态预览服务器（自动拉起 / 复用既有） ---------------- */

async function isUp(url) {
  try {
    const res = await fetch(url)
    return res.ok
  } catch {
    return false
  }
}

let serverProc = null

async function ensureServer() {
  if (await isUp(BASE)) {
    console.log(`[bench] 复用既有静态预览：${BASE}`)
    return
  }
  if (!existsSync(join(ROOT, 'out', 'renderer', 'index.html'))) {
    console.error('[bench] 未找到 out/renderer/index.html，请先执行 npm.cmd run build')
    process.exit(1)
  }
  console.log('[bench] 静态预览未就绪，自动拉起 .serve.mjs …')
  serverProc = spawn(process.execPath, [join(ROOT, '.serve.mjs')], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) {
    if (await isUp(BASE)) return
    await sleep(250)
  }
  throw new Error(`静态服务器启动失败：${BASE}`)
}

/* ---------------- 独立 Edge 会话（临时 profile，用后即删） ---------------- */

if (!existsSync(EDGE)) {
  console.error(`[bench] 未找到 Edge：${EDGE}（可用 ZHUMO_BENCH_EDGE 指定路径）`)
  process.exit(1)
}

const PROFILE_DIR = mkdtempSync(join(tmpdir(), 'zhumo-bench-'))
// --disable-sync / --disable-extensions：阻止 Edge 把账号同步的扩展/设置带进临时 profile，
// 保证基准会话与机器状态无关（否则同步的扩展会弹页、开后台 SW，污染 CDP target 与指标）
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=1440,900',
  '--force-device-scale-factor=1',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-extensions',
  `--user-data-dir=${PROFILE_DIR}`,
  'about:blank'
])

function cleanup() {
  try {
    edge.kill()
  } catch {
    /* ignore */
  }
  try {
    if (serverProc) serverProc.kill()
  } catch {
    /* ignore */
  }
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.on('exit', cleanup)

/* ---------------- CDP 基础 ---------------- */
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      // 优先取我们 spawn 的初始页（about:blank），避免同步对话框等额外 page 抢占
      const page =
        list.find((t) => t.type === 'page' && t.url === 'about:blank') ||
        list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* CDP 尚未就绪，继续等待 */
    }
    await sleep(250)
  }
  throw new Error('Edge CDP 连接失败')
}

let seq = 0
const pending = new Map()
let ws
const consoleErrors = []
const pageExceptions = []
const consoleInfos = []

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error('evaluate 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  }
  return r.result?.value
}

/* ---------------- 页面探针（每个新文档注入，口径与 .perf/perf.mjs 一致） ---------------- */
const PROBE_SRC = `
(() => {
  const probe = (window.__zhuProbe = {
    navStart: performance.now(),
    workerDone: null,
    firstSectionVisible: null,
    readingAt: null,
    autoClicks: 0
  })
  const OW = window.Worker
  function PW(url, opts) {
    const w = new OW(url, opts)
    w.addEventListener('message', () => {
      if (probe.workerDone === null) probe.workerDone = performance.now()
    })
    return w
  }
  try {
    PW.prototype = OW.prototype
    Object.defineProperty(window, 'Worker', { value: PW, configurable: true, writable: true })
  } catch (e) {}
  const iv = setInterval(() => {
    if (probe.firstSectionVisible !== null) { clearInterval(iv); return }
    const el = document.querySelector('.section-body')
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight) {
        probe.firstSectionVisible = performance.now()
        clearInterval(iv)
      }
    }
  }, 25)
  setTimeout(() => clearInterval(iv), 180000)
  const iv2 = setInterval(() => {
    if (probe.readingAt !== null) { clearInterval(iv2); return }
    if (document.querySelector('.reader-scroll')) {
      probe.readingAt = performance.now()
      clearInterval(iv2)
    }
  }, 25)
  setTimeout(() => clearInterval(iv2), 180000)
  const params = new URLSearchParams(location.search)
  if (params.get('book')) {
    const iv3 = setInterval(() => {
      if (document.querySelector('.reader-scroll')) { clearInterval(iv3); return }
      const btn = document.querySelector('.ws-open-btn')
      if (btn) { btn.click(); probe.autoClicks++ }
    }, 120)
    setTimeout(() => clearInterval(iv3), 180000)
  }
})()
`

/* ---------------- 统计工具 ---------------- */
function median(arr) {
  const a = [...arr].sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}
function pct(arr, p) {
  const a = [...arr].sort((x, y) => x - y)
  const idx = Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)
  return a[Math.max(0, idx)]
}
const fmt = (ms) => (ms == null ? '—' : `${Math.round(ms)} ms`)

/* ---------------- D7：首屏 3 轮 ---------------- */
async function measureFirstPaint() {
  const runs = []
  for (let i = 1; i <= 3; i++) {
    // 1) 先到主页清 localStorage（防上轮进度恢复污染首屏位置）
    await send('Page.navigate', { url: `${BASE}/?mock=1` })
    await sleep(1400)
    await evaluate('localStorage.clear(); "cleared"')
    // 2) 导航到压测书（run 参数防任何中间层缓存）
    consoleErrors.length = 0
    pageExceptions.length = 0
    await send('Page.navigate', { url: `${BASE}/?book=${STRESS_BOOK}&run=${i}&mock=1` })
    // 3) 等 firstSectionVisible
    let probe = null
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      const v = await evaluate('window.__zhuProbe ? JSON.stringify(window.__zhuProbe) : null')
      if (v) {
        const p = JSON.parse(v)
        if (p.firstSectionVisible !== null) {
          probe = p
          break
        }
      }
      await sleep(100)
    }
    if (!probe) throw new Error(`第 ${i} 轮首屏等待超时`)
    // 4) 稳定后取页面统计
    await sleep(800)
    const stats = await evaluate(`(() => {
      const q = (s) => document.querySelector(s)
      return {
        title: q('.notes-meta') ? q('.notes-meta').textContent.trim() : null,
        statsBar: q('.sb-right') ? q('.sb-right').textContent.replace(/\\s+/g, ' ').trim() : null,
        sections: document.querySelectorAll('.section-frame').length,
        mounted: document.querySelectorAll('.section-body').length,
        noteCards: document.querySelectorAll('.note-card').length,
        warnings: q('.sb-warnings') ? q('.sb-warnings').textContent.trim() : null,
        scrollHeight: (() => { const el = document.querySelector('.reader-scroll'); return el ? el.scrollHeight : 0 })()
      }
    })()`)
    runs.push({
      run: i,
      workerDone: probe.workerDone,
      firstSectionVisible: probe.firstSectionVisible,
      readingAt: probe.readingAt,
      autoClicks: probe.autoClicks,
      stats,
      consoleErrors: [...consoleErrors],
      pageExceptions: [...pageExceptions]
    })
    console.log(
      `[D7 run${i}] worker=${fmt(probe.workerDone)} 首屏=${fmt(probe.firstSectionVisible)} ` +
        `reading=${fmt(probe.readingAt)} | ${stats.statsBar} | 挂载章 ${stats.mounted}/${stats.sections} | 卡 ${stats.noteCards}`
    )
  }
  const medWorker = median(runs.map((r) => r.workerDone))
  const medFirst = median(runs.map((r) => r.firstSectionVisible))
  console.log(`[D7] 中位：worker 解析完成 ${fmt(medWorker)}；首个 section 可见 ${fmt(medFirst)}`)
  return { runs, medWorker, medFirst }
}

/* ---------------- D8：滚动帧间隔 ---------------- */
async function measureScroll() {
  const r = await evaluate(`(async () => {
    const root = document.querySelector('.reader-scroll')
    if (!root) return null
    root.scrollTop = 0
    await new Promise((r2) => setTimeout(r2, 600))
    const maxScroll = root.scrollHeight - root.clientHeight
    const target = maxScroll * 0.55
    // rAF 可用性探测：2s 内不足 5 帧视为不可用（无头合成器节流）
    let rafCount = 0
    await new Promise((resolve) => {
      let done = false
      const fin = () => { if (!done) { done = true; resolve() } }
      const t0 = performance.now()
      const tick = () => { rafCount++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else fin() }
      requestAnimationFrame(tick)
      setTimeout(fin, 2500)
    })
    const rafDriven = rafCount >= 5
    const frames = []
    let last = performance.now()
    let scrolled = 0
    const tStart = performance.now()
    const TIME_CAP = 25000
    const perFrame = Math.max(10, target / 900)
    await new Promise((resolve) => {
      const step = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        root.scrollTop += perFrame
        scrolled += perFrame
        if (scrolled >= target || frames.length > 3000 || now - tStart > TIME_CAP) { resolve(); return }
        if (rafDriven) requestAnimationFrame(step); else setTimeout(step, 16)
      }
      if (rafDriven) requestAnimationFrame(step); else setTimeout(step, 16)
    })
    return {
      frames,
      rafDriven,
      rafCount,
      coveredPx: Math.round(scrolled),
      totalScrollHeight: root.scrollHeight,
      viewport: root.clientHeight,
      finalRatio: +(root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight)).toFixed(3),
      elapsed: Math.round(performance.now() - tStart)
    }
  })()`)
  if (!r) throw new Error('滚动测试失败：未找到 .reader-scroll')
  const frames = r.frames
  const janky = frames.filter((f) => f > 33).length
  const result = {
    rafDriven: r.rafDriven,
    rafProbeCount: r.rafCount,
    frameCount: frames.length,
    elapsed: r.elapsed,
    avg: frames.reduce((a, b) => a + b, 0) / frames.length,
    p95: pct(frames, 95),
    max: Math.max(...frames),
    janky,
    jankyRatio: +(janky / frames.length).toFixed(4),
    coveredPx: r.coveredPx,
    totalScrollHeight: r.totalScrollHeight,
    coverageRatio: +(r.coveredPx / Math.max(1, r.totalScrollHeight - r.viewport)).toFixed(3),
    finalRatio: r.finalRatio
  }
  const driven = result.rafDriven ? 'rAF' : 'setTimeout(16) 退化'
  console.log(
    `[D8] 驱动=${driven} | 滚动 ${result.frameCount} 帧 / ${result.elapsed}ms：avg ${result.avg.toFixed(1)}ms / ` +
      `p95 ${fmt(result.p95)} / max ${fmt(result.max)} | >33ms ${result.janky} 次（${(result.jankyRatio * 100).toFixed(1)}%）` +
      ` | 覆盖 ${result.coveredPx}px（${(result.coverageRatio * 100).toFixed(0)}% 全高）`
  )
  if (!result.rafDriven) {
    console.log('[D8] 注意：无头环境 rAF 被节流，帧间隔为定时器驱动值，仅作参考')
  }
  return result
}

/* ---------------- D9：内存与 DOM ---------------- */
async function measureMemory() {
  // 滚动结束后停在中部，等挂载与 GC 稳定
  await sleep(2000)
  const dom = await evaluate(`(() => ({
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    heapLimitMB: performance.memory ? +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) : null,
    domNodes: document.getElementsByTagName('*').length,
    sections: document.querySelectorAll('.section-frame').length,
    mountedSections: document.querySelectorAll('.section-body').length,
    noteCards: document.querySelectorAll('.note-card').length,
    anchors: document.querySelectorAll('.zmu-ref').length,
    katex: document.querySelectorAll('.katex').length
  }))()`)
  await send('Performance.enable')
  const m = await send('Performance.getMetrics')
  const pick = (name) => m.metrics.find((x) => x.name === name)?.value ?? null
  const cdp = {
    JSHeapUsedSizeMB:
      pick('JSHeapUsedSize') != null ? +(pick('JSHeapUsedSize') / 1048576).toFixed(1) : null,
    Nodes: pick('Nodes'),
    Documents: pick('Documents'),
    JSEventListeners: pick('JSEventListeners'),
    RecalcStyleCount: pick('RecalcStyleCount'),
    LayoutCount: pick('LayoutCount')
  }
  console.log(
    `[D9] DOM 节点 ${dom.domNodes.toLocaleString()} | 挂载章 ${dom.mountedSections}/${dom.sections} | ` +
      `卡片 ${dom.noteCards} | 锚点 ${dom.anchors} | KaTeX ${dom.katex} | ` +
      `performance.memory 堆 ${dom.heapMB ?? '不可用'} MB | CDP JSHeapUsedSize ${cdp.JSHeapUsedSizeMB ?? '不可用'} MB | CDP Nodes ${cdp.Nodes}`
  )
  return { dom, cdp }
}

/* ---------------- D11：edge-cases 边界书验证 ---------------- */
async function verifyEdgeCases() {
  consoleErrors.length = 0
  pageExceptions.length = 0
  await send('Page.navigate', { url: `${BASE}/?mock=1` })
  await sleep(1200)
  await evaluate('localStorage.clear(); "cleared"')
  await send('Page.navigate', { url: `${BASE}/?book=${EDGE_BOOK}&mock=1` })
  // 等阅读态
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    const ok = await evaluate(
      `!!document.querySelector('.reader-scroll') && !!document.querySelector('.section-body')`
    )
    if (ok) break
    await sleep(150)
  }
  await sleep(800)
  const r = await evaluate(`(() => {
    const q = (s) => document.querySelector(s)
    const qa = (s) => document.querySelectorAll(s)
    return {
      reading: !!q('.reader-scroll'),
      warningsText: q('.sb-warnings') ? q('.sb-warnings').textContent.trim() : null,
      notesMeta: q('.notes-meta') ? q('.notes-meta').textContent.trim() : null,
      statsBar: q('.sb-right') ? q('.sb-right').textContent.replace(/\\s+/g, ' ').trim() : null,
      orphanGroup: !!q('.orphan-group'),
      orphanCount: q('.orphan-count') ? q('.orphan-count').textContent.trim() : null,
      missingCards: qa('.note-card.is-missing').length,
      cycleIcons: qa('.note-state-icon').length,
      noteCards: qa('.note-card').length,
      sections: qa('.section-frame').length
    }
  })()`)
  // 展开状态栏警告明细，按 kind 计数
  await evaluate(
    `document.querySelector('.sb-warnings') ? (document.querySelector('.sb-warnings').click(), 'ok') : 'none'`
  )
  await sleep(400)
  r.warningKinds = await evaluate(
    `[...document.querySelectorAll('.sb-warning-kind')].map((e) => e.textContent.trim())`
  )
  console.log(
    `[D11] reading=${r.reading} | 警告「${r.warningsText}」| ${r.notesMeta} | ${r.statsBar} | ` +
      `孤儿分组=${r.orphanGroup}(${r.orphanCount} 条) 缺失卡=${r.missingCards} 环图标=${r.cycleIcons} | ` +
      `警告种类=${JSON.stringify(r.warningKinds)}`
  )
  console.log(
    `[D11] console error：${consoleErrors.length === 0 ? '无' : JSON.stringify(consoleErrors.slice(0, 5))}`
  )
  console.log(
    `[D11] 页面异常：${pageExceptions.length === 0 ? '无' : JSON.stringify(pageExceptions.slice(0, 5))}`
  )
  return { ...r, consoleErrors: [...consoleErrors], pageExceptions: [...pageExceptions] }
}

/* ---------------- baseline 对比 ---------------- */
function compareWithBaseline(report) {
  const baselinePath = join(HERE, 'baseline.json')
  if (!existsSync(baselinePath)) {
    console.log('[bench] 未找到 baseline.json，跳过对比')
    return
  }
  let baseline
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    console.log(`[bench] baseline.json 解析失败，跳过对比：${error.message}`)
    return
  }
  const b = baseline.metrics
  const now = {
    medWorkerMs: report.firstPaint.medWorker,
    medFirstMs: report.firstPaint.medFirst,
    avgFrameMs: report.scroll.avg,
    p95FrameMs: report.scroll.p95,
    jankyRatio: report.scroll.jankyRatio,
    heapMB: report.memory.dom.heapMB,
    domNodes: report.memory.dom.domNodes
  }
  const rows = [
    ['worker 解析中位 (ms)', b.firstPaint.medWorkerMs, now.medWorkerMs],
    ['首屏可见中位 (ms)', b.firstPaint.medFirstMs, now.medFirstMs],
    ['滚动帧间隔 avg (ms)', b.scroll.avgMs, now.avgFrameMs],
    ['滚动帧间隔 p95 (ms)', b.scroll.p95Ms, now.p95FrameMs],
    ['掉帧率 >33ms', b.scroll.jankyRatio, now.jankyRatio],
    ['JS 堆 (MB)', b.memory.heapMB, now.heapMB],
    ['DOM 节点数', b.memory.domNodes, now.domNodes]
  ]
  console.log(
    `\n===== 与 baseline 对比（采集于 ${baseline.capturedAt}，书：${baseline.book}）=====`
  )
  for (const [label, base, cur] of rows) {
    if (typeof base !== 'number' || typeof cur !== 'number') {
      console.log(`  ${label.padEnd(22)} baseline=${base} 本次=${cur}`)
      continue
    }
    const delta = base !== 0 ? ((cur - base) / base) * 100 : NaN
    const mark = Number.isNaN(delta) ? '' : delta > 5 ? ' ↑' : delta < -5 ? ' ↓' : ' ≈'
    console.log(
      `  ${label.padEnd(22)} baseline=${String(base).padEnd(10)} 本次=${String(cur).padEnd(10)} Δ=${delta.toFixed(1)}%${mark}`
    )
  }
  console.log('  （↑ 变慢/变大，↓ 变快/变小，≈ ±5% 内视为噪声）')
}

/* ---------------- 主流程 ---------------- */
await ensureServer()

const target = await getTarget()
ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).res(msg.result)
    pending.delete(msg.id)
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const line =
      msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (msg.params.type === 'error') consoleErrors.push(line)
    else if (msg.params.type === 'info' || msg.params.type === 'warning') consoleInfos.push(line)
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageExceptions.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400))
  }
}
await send('Runtime.enable')
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SRC })
console.log(`[bench] CDP 就绪，探针已注入。目标: ${BASE}（压测书 ${STRESS_BOOK}）`)

const report = {
  startedAt: new Date().toISOString(),
  base: BASE,
  book: STRESS_BOOK
}

console.log(`\n===== D7 解析与首屏（?book=${STRESS_BOOK}，3 轮）=====`)
report.firstPaint = await measureFirstPaint()

console.log('\n===== D8 滚动性能（rAF 帧间隔）=====')
report.scroll = await measureScroll()

console.log('\n===== D9 内存与 DOM =====')
report.memory = await measureMemory()

console.log('\n===== D11 edge-cases 边界书验证 =====')
report.edgeCases = await verifyEdgeCases()

report.finishedAt = new Date().toISOString()
report.consoleInfos = consoleInfos.slice(0, 20)
const outPath = join(HERE, 'report.json')
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n[bench] 报告已写入 ${outPath}`)

compareWithBaseline(report)

edge.kill()
process.exit(0)
