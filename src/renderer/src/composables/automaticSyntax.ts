import { reactive, shallowReactive, watch } from 'vue'
import { SyntaxStream } from '../../../shared/syntax-stream'
import { SyntaxDwell } from '../../../shared/syntax-dwell'
import { readingAppearance, watchReadingAppearance } from '../effects/reading-appearance'
import {
  syntaxPassages,
  syntaxPassageChildren,
  syntaxHasProse,
  type SyntaxTarget,
  type SyntaxRegion
} from '../../../shared/syntax-passages'
import type { SyntaxPassage } from '../../../shared/syntax-passages'
import { selectionContext } from '../../../shared/selection-context'
import {
  AUTOMATIC_SYNTAX_CONCURRENCY,
  aiProfileReady,
  type AiEvent,
  type SyntaxAnalysis
} from '../../../shared/ai-types'
import { aiState, loadAiProfiles } from './aiReading'
import { bookState } from './useBook'
import { documentSession } from './documentSession'
import { settings, uiState } from './useSettings'
import { studio } from './useStudio'
import { searchTextParts } from './searchText'
import { captureReadingSelection, locateReadingSelection } from './readingSelection'
import { rawSelectionOffset } from './selectionNote'
import { syntaxProgressMessage } from '../../../shared/syntax-progress'
import {
  captureSyntaxAnchors,
  resolveSyntaxAnchors,
  syntaxSpanRanges,
  syntaxRegions,
  syntaxTextSlices,
  syntaxAtomicElement,
  type SyntaxAnchor
} from '../effects/syntax-ranges'

export interface AutomaticSyntaxEntry {
  key: string
  quote: string
  anchors: SyntaxAnchor[]
  analysis: SyntaxAnalysis | null
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  reasoning: string
  outputChars: number
  error: string
  warning: string
  id: string
  attempts: number
  reading: string
  syntaxTarget?: SyntaxTarget
}
export const automaticSyntax = reactive({
  entries: [] as AutomaticSyntaxEntry[],
  active: '',
  activeCount: 0,
  latest: '',
  error: '',
  version: 0,
  phase: '正在读取句法设置…',
  visibleCount: 0,
  qualifiedCount: 0,
  renderedCount: 0,
  blocked: false
})
const entries = new Map<string, AutomaticSyntaxEntry>(),
  dwell = new SyntaxDwell()
interface SyntaxJob {
  entry: AutomaticSyntaxEntry
  stream: SyntaxStream
  abort: AbortController
  generation: number
}
const jobs = new Map<string, SyntaxJob>()
function publishJobs(): void {
  automaticSyntax.active = jobs.keys().next().value ?? ''
  automaticSyntax.activeCount = jobs.size
}
let generation = 0,
  priority = '',
  currentVisible = new Set<string>()
let windowActivity: { focused: boolean; visible: boolean; backgroundTest: boolean } | undefined
function pauseReason(): string {
  if (!window.ai) return '桌面版连接模型后可自动标注'
  if (settings.annotationMode === 'document') return '全文标注已开启，跟随标注暂停'
  if (!settings.automaticSyntax) return '自动句法已关闭'
  if (!aiState.lightsOn) return '文本光效已关闭'
  if (studio.effectsMode === 'off') return '光效总开关已关闭'
  if (bookState.status !== 'reading' || documentSession.mode !== 'read') return '回到阅读模式后继续'
  const foreground = windowActivity
    ? (windowActivity.focused && windowActivity.visible) ||
      (windowActivity.backgroundTest && document.hasFocus())
    : document.hasFocus()
  if (document.hidden || !foreground) return '阅读窗口在后台，暂停新分析'
  if (
    uiState.settingsOpen ||
    aiState.settingsOpen ||
    studio.galleryOpen ||
    studio.panoramaOpen ||
    studio.atlasOpen ||
    document.querySelector('dialog[open]')
  )
    return '关闭覆盖面板后继续'
  if (aiState.configError) return aiState.configError
  if (!aiProfileReady(aiState.profiles.syntax)) return '请先配置句法模型'
  if (aiState.profiles.syntax.keyStorage === 'unavailable')
    return '句法密钥无法读取，请重新保存配置'
  return ''
}
const ready = (): boolean => !pauseReason()
function stopActive(job?: SyntaxJob): void {
  for (const current of job ? [job] : [...jobs.values()]) {
    current.abort.abort()
    current.entry.status = 'cancelled'
    if (current.entry.id) void window.ai?.cancel(current.entry.id).catch(() => undefined)
    jobs.delete(current.entry.key)
  }
  publishJobs()
}
function reset(): void {
  generation++
  stopActive()
  entries.clear()
  automaticSyntax.entries = []
  automaticSyntax.error = ''
  automaticSyntax.blocked = false
  automaticSyntax.latest = ''
  automaticSyntax.version++
  priority = ''
  dwell.reset()
  automaticSyntax.visibleCount = 0
  automaticSyntax.qualifiedCount = 0
  automaticSyntax.renderedCount = 0
}
export function retryAutomaticSyntax(): void {
  automaticSyntax.error = ''
  automaticSyntax.blocked = false
  for (const entry of entries.values())
    if (entry.status === 'error') {
      entry.status = 'idle'
      entry.attempts = 0
    }
  dwell.reset()
}
function target(
  range: Range,
  quote: string,
  fragment?: { beginsMidSentence: boolean; endsMidSentence: boolean }
): AutomaticSyntaxEntry | undefined {
  if (!quote.trim() || quote.length > 12000) return
  const anchors = captureSyntaxAnchors(range, quote, bookState.book?.notes ?? [])
  if (!anchors.length) return
  const regions = syntaxRegions(anchors, quote.length)
  const scope =
    regions.length || fragment?.beginsMidSentence || fragment?.endsMidSentence
      ? {
          regions,
          beginsMidSentence: fragment?.beginsMidSentence ?? false,
          endsMidSentence: fragment?.endsMidSentence ?? false
        }
      : undefined
  const key = JSON.stringify(anchors.map((a) => [a.kind, a.id, a.inline, a.from, a.to]))
  if (entries.has(key)) return entries.get(key)
  const entry = shallowReactive<AutomaticSyntaxEntry>({
    key,
    quote,
    anchors,
    analysis: null,
    status: 'idle',
    reasoning: '',
    outputChars: 0,
    error: '',
    warning: '',
    id: '',
    attempts: 0,
    reading: '',
    ...(scope ? { syntaxTarget: scope } : {})
  })
  entries.set(key, entry)
  while (entries.size > 96) {
    const oldest = [...entries.keys()].find((key) => !jobs.has(key) && !currentVisible.has(key))
    if (!oldest) break
    entries.delete(oldest)
  }
  automaticSyntax.entries = [...entries.values()]
  return entry
}
function visibility(range: Range, quote?: string): { eligible: boolean; oversized: boolean } {
  const root = range.startContainer.parentElement?.closest('.reader-scroll,.notes-scroll')
  if (!root) return { eligible: false, oversized: false }
  const clip = root.getBoundingClientRect()
  const native =
    quote === undefined
      ? [range]
      : syntaxSpanRanges(syntaxTextSlices(range, quote), { start: 0, end: quote.length } as never)
  const rects = native
    .flatMap((r) => {
      const atom = syntaxAtomicElement(r)
      return atom ? [atom.getBoundingClientRect()] : [...r.getClientRects()]
    })
    .filter((r) => r.width > 1 && r.height > 1)
  let total = 0,
    exposed = 0
  for (const r of rects) {
    total += r.width * r.height
    const left = Math.max(r.left, clip.left, 0),
      right = Math.min(r.right, clip.right, innerWidth)
    const top = Math.max(r.top, clip.top, 0),
      bottom = Math.min(r.bottom, clip.bottom, innerHeight)
    if (right <= left || bottom <= top) continue
    let clear = 0
    for (const fraction of [0.15, 0.5, 0.85]) {
      const el = document.elementFromPoint(left + (right - left) * fraction, (top + bottom) / 2)
      if (el && root.contains(el)) clear++
    }
    exposed += ((right - left) * (bottom - top) * clear) / 3
  }
  const availableHeight = Math.min(clip.bottom, innerHeight) - Math.max(clip.top, 0)
  const height = rects.length
    ? Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))
    : 0
  return {
    eligible: total > 0 && exposed / total >= 0.7,
    oversized: availableHeight > 0 && height > availableHeight
  }
}
const fullyVisible = (range: Range, quote?: string): boolean => visibility(range, quote).eligible
interface PlannedPassage extends SyntaxPassage {
  children?: PlannedPassage[]
}
const passagePlans = new WeakMap<
  Element,
  { text: string; regions: string; passages: PlannedPassage[] }
>()
function visibleEntries(): AutomaticSyntaxEntry[] {
  const result: AutomaticSyntaxEntry[] = []
  for (const inline of document.querySelectorAll<HTMLElement>(
    '.reader-scroll .section-body [data-source-inline]'
  )) {
    const rect = inline.getBoundingClientRect()
    if (
      rect.bottom < 0 ||
      rect.top > innerHeight ||
      inline.closest('pre,code,h1,h2,h3,h4,h5,h6,.zmu-diagram,.zmu-math-block')
    )
      continue
    const parts = searchTextParts(inline, true)
    if (parts.some((p) => p.atomic && !(p.node instanceof Element && p.node.matches('.zmu-math'))))
      continue
    const text = parts.map((p) => p.text).join('')
    let offset = 0
    const slices = parts.map((p) => {
      const start = offset
      offset += p.text.length
      return { node: p.node, atomic: p.atomic, from: 0, to: p.text.length, start, end: offset }
    })
    const regions = slices.flatMap<SyntaxRegion>((slice) =>
      slice.atomic
        ? [{ kind: 'math', start: slice.start, end: slice.end }]
        : slice.node.parentElement?.closest('code')
          ? [{ kind: 'code', start: slice.start, end: slice.end }]
          : []
    )
    // A fully visible short paragraph is one discourse unit: pronouns in its later
    // sentences can then point to exact earlier anchors instead of an invisible context.
    const whole = text.trim()
    if (whole.length >= 4 && whole.length <= 1200 && syntaxHasProse(text, regions)) {
      const ranges = syntaxSpanRanges(slices, { start: 0, end: text.length } as never)
      if (ranges.length) {
        const range = document.createRange()
        range.setStart(ranges[0].startContainer, ranges[0].startOffset)
        range.setEnd(ranges.at(-1)!.endContainer, ranges.at(-1)!.endOffset)
        if (fullyVisible(range, whole)) {
          const entry = target(range, whole)
          if (entry) result.push(entry)
          continue
        }
      }
    }
    const signature = JSON.stringify(regions)
    let plan = passagePlans.get(inline)
    if (!plan || plan.text !== text || plan.regions !== signature) {
      plan = { text, regions: signature, passages: syntaxPassages(text, regions) }
      passagePlans.set(inline, plan)
    }
    const visit = (segment: PlannedPassage): void => {
      if (result.length >= 32) return
      const { start, end } = segment
      const quote = text.slice(start, end).trim()
      const ranges = syntaxSpanRanges(slices, { start, end } as never)
      if (!ranges.length) return
      const range = document.createRange()
      range.setStart(ranges[0].startContainer, ranges[0].startOffset)
      range.setEnd(ranges.at(-1)!.endContainer, ranges.at(-1)!.endOffset)
      const view = visibility(range, quote)
      if (!view.eligible) {
        // Do not turn an ordinary sentence near the screen edge into tiny fragments.
        // Only refine a window that cannot fit this viewport's physical height.
        if (view.oversized) {
          segment.children ??= syntaxPassageChildren(text, regions, segment)
          segment.children.forEach(visit)
        }
        return
      }
      const entry = target(range, quote, {
        beginsMidSentence: text.slice(segment.sentenceStart, start).trim().length > 0,
        endsMidSentence: text.slice(end, segment.sentenceEnd).trim().length > 0
      })
      if (entry) result.push(entry)
    }
    plan.passages.forEach(visit)
    if (result.length >= 32) return result
  }
  return result
}
export function syntaxEntryContains(
  outer: AutomaticSyntaxEntry,
  inner: AutomaticSyntaxEntry
): boolean {
  if (outer.quote.length <= inner.quote.length) return false
  return inner.anchors.every((a) => {
    const matches = outer.anchors.filter(
      (b) => b.kind === a.kind && b.id === a.id && b.inline === a.inline
    )
    return (
      matches.length > 0 &&
      Math.min(...matches.map((b) => b.from)) <= a.from &&
      Math.max(...matches.map((b) => b.to)) >= a.to
    )
  })
}
function coveredByCompleted(entry: AutomaticSyntaxEntry): boolean {
  return automaticSyntax.entries.some(
    (other) => other.status === 'done' && other.analysis && syntaxEntryContains(other, entry)
  )
}
async function start(entry: AutomaticSyntaxEntry): Promise<void> {
  if (jobs.has(entry.key) || jobs.size >= AUTOMATIC_SYNTAX_CONCURRENCY) return
  if (!automaticSyntax.blocked) automaticSyntax.error = ''
  const own = generation,
    source = documentSession.source,
    profile = { ...aiState.profiles.syntax }
  entry.status = 'running'
  entry.attempts++
  entry.error = ''
  entry.warning = ''
  entry.reasoning = ''
  entry.outputChars = 0
  // Keep the live thinking transcript for the most recent request, not 96 unbounded copies.
  for (const other of entries.values())
    if (other !== entry && !jobs.has(other.key)) other.reasoning = ''
  if (!aiState.open || !automaticSyntax.latest || !entries.has(automaticSyntax.latest))
    automaticSyntax.latest = entry.key
  const job = {
    entry,
    stream: new SyntaxStream(entry.quote),
    abort: new AbortController(),
    generation: own
  }
  jobs.set(entry.key, job)
  publishJobs()
  let dispatched = false
  try {
    let context: { before: string; after: string } | undefined
    if (profile.context === 'full') {
      const first = entry.anchors[0],
        last = entry.anchors.at(-1)!
      const located = await locateReadingSelection(
        {
          source,
          levelCap: settings.noteLevelCap,
          address: {
            kind: last.kind,
            id: last.id,
            inline: last.inline,
            text: last.text,
            end: last.to,
            projectionFrom: last.projectionFrom
          },
          startAddress: {
            kind: first.kind,
            id: first.id,
            inline: first.inline,
            text: first.text,
            end: first.from,
            boundary: 'start',
            projectionFrom: first.projectionFrom
          }
        },
        job.abort.signal
      )
      if (located.start === undefined) throw Error('句法语境的起点无法精确定位，未发送。')
      const c = selectionContext(
        source,
        rawSelectionOffset(source, located.start),
        rawSelectionOffset(source, located.position),
        entry.quote
      )
      context = { before: c.before, after: c.after }
    }
    if (jobs.get(entry.key) !== job || own !== generation || !ready()) {
      if (jobs.get(entry.key) === job) stopActive(job)
      return
    }
    const id = crypto.randomUUID()
    entry.id = id
    dispatched = true
    await window.ai!.start({
      id,
      profileRevision: profile.revision,
      lane: 'syntax',
      automatic: true,
      document: profile.context === 'default' ? source : '',
      selectedText: entry.quote,
      instruction: '',
      readingAppearance: readingAppearance(),
      ...(entry.syntaxTarget ? { syntaxTarget: entry.syntaxTarget } : {}),
      ...(context ? { selectionContext: context } : {})
    })
    if (jobs.get(entry.key) !== job) void window.ai!.cancel(id)
  } catch (error) {
    if (jobs.get(entry.key) !== job || job.abort.signal.aborted) return
    fail(job, error instanceof Error ? error.message : '自动句法暂时无法开始。', dispatched)
  }
}
function fail(job: SyntaxJob, message: string, blockQueue = true): void {
  if (jobs.get(job.entry.key) !== job) return
  job.entry.status = 'error'
  job.entry.error = message
  automaticSyntax.error = message
  automaticSyntax.blocked ||= blockQueue
  if (job.entry.id) void window.ai?.cancel(job.entry.id)
  jobs.delete(job.entry.key)
  publishJobs()
}
function event(value: AiEvent): void {
  const job = [...jobs.values()].find((j) => j.entry.id === value.id)
  if (!job || job.generation !== generation) return
  const entry = job.entry
  if (value.type === 'reasoning') {
    entry.reasoning += value.text
    return
  }
  if (value.type === 'error') {
    fail(job, value.message)
    return
  }
  if (value.type === 'cancelled') {
    stopActive(job)
    return
  }
  try {
    if (value.type === 'delta') {
      entry.outputChars += value.text.length
      const next = job.stream.push(value.text)
      const issues = job.stream.drainIssues()
      if (issues.length) entry.warning = issues.at(-1)!.message + ' 后续有效批次继续显影。'
      if (next !== entry.analysis) {
        entry.analysis = next
        automaticSyntax.version++
      }
      return
    }
    if (['length', 'max_tokens'].includes(value.finishReason))
      throw Error('句法输出达到长度上限；已校验的光效保留，可提高输出长度或降低思考强度。')
    entry.analysis = job.stream.finish()
    entry.status = 'done'
    jobs.delete(entry.key)
    publishJobs()
    automaticSyntax.version++
  } catch (error) {
    fail(job, error instanceof Error ? error.message : '句法流校验失败。', false)
  }
}
function selection(): void {
  if (!ready() || automaticSyntax.blocked || aiState.runs.syntax.status === 'running') return
  const selected = captureReadingSelection(bookState.book?.notes ?? []),
    native = window.getSelection()
  if (!selected || !native?.rangeCount) return
  const entry = target(native.getRangeAt(0).cloneRange(), selected.quote)
  if (!entry || entry.status === 'done' || jobs.has(entry.key)) return
  if (entry.status === 'error') {
    entry.status = 'idle'
    entry.error = ''
  }
  priority = entry.key
  if (jobs.size < AUTOMATIC_SYNTAX_CONCURRENCY) void start(entry)
}
export function analyzeVisibleSyntax(): void {
  if (!ready()) {
    automaticSyntax.phase = pauseReason()
    return
  }
  automaticSyntax.error = ''
  automaticSyntax.blocked = false
  const entry = visibleEntries().find((e) => e.status !== 'done' && !jobs.has(e.key))
  if (!entry) {
    automaticSyntax.phase = '当前可见句段已完成，或没有可定位的正文'
    return
  }
  if (entry.status === 'error') {
    entry.status = 'idle'
    entry.error = ''
  }
  priority = entry.key
  if (jobs.size < AUTOMATIC_SYNTAX_CONCURRENCY) void start(entry)
}
export function mountAutomaticSyntax(): () => void {
  void loadAiProfiles()
  const off = window.ai?.onEvent(event)
  let activityBusy = false
  const refreshActivity = async (): Promise<void> => {
    if (activityBusy || !window.ai?.activity) return
    activityBusy = true
    try {
      windowActivity = await window.ai.activity()
    } catch {
      windowActivity = undefined
    } finally {
      activityBusy = false
    }
  }
  const focused = (): void => {
    void refreshActivity()
    void loadAiProfiles()
  }
  void refreshActivity()
  window.addEventListener('focus', focused)
  const unwatchAppearance = watchReadingAppearance(reset)
  const unwatchMode = watch(
    () => settings.annotationMode,
    () => {
      stopActive()
      dwell.reset()
    },
    { flush: 'sync' }
  )
  const unwatch = watch(
    [
      () => documentSession.source,
      () => documentSession.path,
      () => aiState.profiles.syntax.revision
    ],
    reset
  )
  const timer = setInterval(() => {
    void refreshActivity()
    const enabled = ready()
    if (!enabled) {
      automaticSyntax.phase = pauseReason()
      dwell.reset()
      // Pause admission on blur/modal display. An already admitted slow request may finish
      // into the cache, so changing focus does not repeatedly discard paid reasoning.
      if (
        jobs.size > 0 &&
        (settings.annotationMode === 'document' ||
          !settings.automaticSyntax ||
          !aiState.lightsOn ||
          studio.effectsMode === 'off' ||
          documentSession.mode !== 'read' ||
          bookState.status !== 'reading')
      )
        stopActive()
      return
    }
    const visible = visibleEntries()
    automaticSyntax.visibleCount = visible.length
    currentVisible = new Set(visible.map((e) => e.key))
    // An explicit passage remains eligible while its selected sentence stays mounted on screen.
    if (priority && !currentVisible.has(priority)) {
      const e = entries.get(priority)
      const slices = e && resolveSyntaxAnchors(e.anchors, bookState.book?.notes ?? [])
      if (
        e &&
        slices?.length &&
        syntaxSpanRanges(slices, { start: 0, end: e.quote.length } as never).some((r) =>
          fullyVisible(r)
        )
      )
        currentVisible.add(priority)
    }
    // Scrolling discards eligibility, not an already admitted request. Exact anchors keep
    // offscreen output off the page; a later revisit can reuse the completed analysis.
    const eligible = dwell.tick(
      performance.now(),
      [...currentVisible],
      true,
      settings.automaticSyntaxWaitSeconds * 1000
    )
    automaticSyntax.qualifiedCount = eligible.length
    const active = jobs.get(automaticSyntax.latest) ?? jobs.values().next().value
    automaticSyntax.phase =
      jobs.size > 1
        ? `${jobs.size} 个句段并行分析，已完成的关系随到随显`
        : automaticSyntax.error
          ? '句法请求需要处理'
          : active
            ? syntaxProgressMessage(active.entry, automaticSyntax.renderedCount)
            : automaticSyntax.renderedCount
              ? '当前正文已有可见标注'
              : visible.some((e) => e.analysis || coveredByCompleted(e))
                ? '已收到分析，当前没有可绘制片段'
                : visible.length
                  ? `等待当前句段停留满 ${settings.automaticSyntaxWaitSeconds} 秒`
                  : '当前视口没有可定位的正文句段'
    if (
      jobs.size >= AUTOMATIC_SYNTAX_CONCURRENCY ||
      automaticSyntax.blocked ||
      aiState.runs.syntax.status === 'running'
    )
      return
    const next = [...new Set([priority, ...eligible])]
      .map((key) => entries.get(key))
      .filter(
        (e) =>
          e &&
          currentVisible.has(e.key) &&
          ['idle', 'cancelled'].includes(e.status) &&
          !jobs.has(e.key) &&
          ![...jobs.values()].some((job) => syntaxEntryContains(job.entry, e)) &&
          (e.key === priority || !coveredByCompleted(e))
      )
    for (const entry of next) {
      if (jobs.size >= AUTOMATIC_SYNTAX_CONCURRENCY) break
      if (entry) {
        if (entry.key === priority) priority = ''
        void start(entry)
      }
    }
  }, 500)
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') selection()
  }
  let gesture = false
  const down = (e: PointerEvent): void => {
    gesture =
      e.button === 0 &&
      e.target instanceof Element &&
      Boolean(e.target.closest('.section-body,.zmu-note-body')) &&
      !e.target.closest('button,.zmu-ref,input,textarea')
  }
  const up = (): void => {
    if (gesture) selection()
    gesture = false
  }
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('keyup', key)
  return () => {
    clearInterval(timer)
    off?.()
    unwatch()
    unwatchAppearance()
    unwatchMode()
    stopActive()
    document.removeEventListener('pointerdown', down, true)
    document.removeEventListener('pointerup', up, true)
    document.removeEventListener('keyup', key)
    window.removeEventListener('focus', focused)
  }
}
