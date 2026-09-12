import { SYNTAX_EXAMPLES } from '../../../shared/syntax-examples'
import { reactive, shallowRef } from 'vue'
import {
  defaultAiProfile,
  aiProfileReady,
  type AiEvent,
  type AiLane,
  type AiProfiles,
  type SyntaxAnalysis,
  type SyntaxLightStyle
} from '../../../shared/ai-types'
import { SyntaxStream } from '../../../shared/syntax-stream'
import { readingAppearance } from '../effects/reading-appearance'
import {
  captureReadingSelection,
  locateReadingSelection,
  type ReadingSelection
} from './readingSelection'
import { selectionContext } from '../../../shared/selection-context'
import { rawSelectionOffset } from './selectionNote'
import { documentSession } from './documentSession'
import { uiState, settings } from './useSettings'
import { studio } from './useStudio'
import { bookState } from './useBook'
import { captureSyntaxAnchors, syntaxRegions, type SyntaxAnchor } from '../effects/syntax-ranges'

export interface AiSelection {
  quote: string
  source: string
  path: string
  origin: string
  reading: ReadingSelection
  range: Range | null
  anchors: SyntaxAnchor[]
}
interface AiRun {
  appearanceKey?: string
  id: string
  model: string
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  output: string
  reasoning: string
  error: string
  warning: string
  analysis: SyntaxAnalysis | null
}
const emptyRun = (): AiRun => ({
  id: '',
  model: '',
  status: 'idle',
  output: '',
  reasoning: '',
  error: '',
  warning: '',
  analysis: null
})
export const aiSelection = shallowRef<AiSelection | null>(null)
let syntaxStream: SyntaxStream | undefined
export const aiState = reactive({
  open: false,
  settingsOpen: false,
  lane: 'reading' as AiLane,
  settingsLane: 'reading' as AiLane,
  profiles: {
    reading: defaultAiProfile('reading'),
    syntax: defaultAiProfile('syntax')
  } as AiProfiles,
  loaded: false,
  configError: '',
  instruction: '',
  syntaxInstruction: '',
  stale: false,
  runs: { reading: emptyRun(), syntax: emptyRun() },
  lightStyle: 'spectrum' as SyntaxLightStyle,
  intensity: 0.95,
  lightsOn: true,
  activeSpan: -1,
  syntaxExample: 0,
  syntaxReading: '',
  syntaxRelation: '',
  demonstration: false
})
export async function loadAiProfiles(): Promise<void> {
  if (!window.ai) {
    aiState.loaded = true
    return
  }
  try {
    aiState.profiles = await window.ai.getProfiles()
    aiState.configError = ''
    aiState.loaded = true
  } catch (error) {
    aiState.configError = error instanceof Error ? error.message : '无法读取模型设置。'
  }
}
export function openAiSettings(lane: AiLane = aiState.lane): void {
  aiState.settingsLane = lane
  aiState.settingsOpen = true
  uiState.settingsOpen = false
  void loadAiProfiles()
}
export function openAiReading(selection: ReadingSelection, lane: AiLane): void {
  cancelAiRuns()
  const native = window.getSelection()
  const range = native?.rangeCount ? native.getRangeAt(0).cloneRange() : null
  aiSelection.value = {
    quote: selection.quote,
    source: documentSession.source,
    path: documentSession.path,
    origin: selection.origin,
    reading: selection,
    range,
    anchors: range ? captureSyntaxAnchors(range, selection.quote, bookState.book?.notes ?? []) : []
  }
  aiState.runs = { reading: emptyRun(), syntax: emptyRun() }
  aiState.stale = false
  aiState.demonstration = false
  aiState.activeSpan = -1
  aiState.syntaxReading = ''
  aiState.syntaxRelation = ''
  aiState.lane = lane
  aiState.open = true
  studio.searchOpen = false
  void loadAiProfiles()
}
export function openAiPanel(): void {
  const selection = captureReadingSelection(bookState.book?.notes ?? [])
  if (selection) {
    openAiReading(selection, aiState.lane)
    return
  }
  aiState.open = true
  void loadAiProfiles()
}
export function cancelAiRuns(): void {
  for (const lane of ['reading', 'syntax'] as const) cancelAi(lane)
}
export function cancelAi(lane: AiLane): void {
  const run = aiState.runs[lane]
  if (run.status !== 'running') return
  run.status = 'cancelled'
  void window.ai?.cancel(run.id).catch(() => undefined)
}
export function invalidateAiSelection(): void {
  if (!aiSelection.value) return
  const snapshot = aiSelection.value
  if (
    snapshot.source !== documentSession.source ||
    snapshot.path !== documentSession.path ||
    bookState.status !== 'reading' ||
    documentSession.mode !== 'read'
  ) {
    cancelAiRuns()
    aiState.stale = true
    aiState.activeSpan = -1
  }
}
export async function runAi(lane: AiLane): Promise<void> {
  const selection = aiSelection.value
  if (!selection || aiState.stale || aiState.runs[lane].status === 'running') return
  if (!window.ai) {
    openAiSettings(lane)
    return
  }
  const profile = aiState.profiles[lane]
  if (!aiProfileReady(profile)) {
    openAiSettings(lane)
    return
  }
  const id = crypto.randomUUID()
  if (lane === 'syntax') syntaxStream = new SyntaxStream(selection.quote)
  aiState.runs[lane] = { ...emptyRun(), id, model: profile.model, status: 'running' }
  aiState.demonstration = false
  aiState.activeSpan = -1
  try {
    let context: { before: string; after: string } | undefined
    if (lane === 'syntax' && profile.context === 'full') {
      const located = await locateReadingSelection(
        {
          source: selection.source,
          address: selection.reading.address,
          startAddress: selection.reading.startAddress,
          levelCap: settings.noteLevelCap
        },
        new AbortController().signal
      )
      if (located.start === undefined) throw Error('无法精确定位句法语境，未发送。')
      const c = selectionContext(
        selection.source,
        rawSelectionOffset(selection.source, located.start),
        rawSelectionOffset(selection.source, located.position),
        selection.quote
      )
      context = { before: c.before, after: c.after }
    }
    if (aiState.runs[lane].id !== id || aiState.runs[lane].status !== 'running' || aiState.stale)
      return
    const appearance = lane === 'syntax' ? readingAppearance() : undefined
    if (appearance) aiState.runs[lane].appearanceKey = JSON.stringify(appearance)
    await window.ai.start({
      id,
      profileRevision: profile.revision,
      lane,
      document: lane === 'reading' || profile.context === 'default' ? selection.source : '',
      ...(context ? { selectionContext: context } : {}),
      selectedText: selection.quote,
      ...(appearance ? { readingAppearance: appearance } : {}),
      ...(lane === 'syntax' && syntaxRegions(selection.anchors, selection.quote.length).length
        ? {
            syntaxTarget: {
              regions: syntaxRegions(selection.anchors, selection.quote.length),
              beginsMidSentence: false,
              endsMidSentence: false
            }
          }
        : {}),
      instruction: lane === 'reading' ? aiState.instruction : aiState.syntaxInstruction
    })
    // A synchronous cancel can arrive before start finishes IPC dispatch.
    if (aiState.runs[lane].id !== id || ['cancelled'].includes(aiState.runs[lane].status))
      await window.ai.cancel(id)
  } catch (error) {
    const run = aiState.runs[lane]
    if (run.id !== id || run.status !== 'running') return
    run.status = 'error'
    run.error = error instanceof Error ? error.message : '未能开始模型请求。'
  }
}
export function handleAiEvent(event: AiEvent): void {
  const lane = (['reading', 'syntax'] as const).find((lane) => aiState.runs[lane].id === event.id)
  if (!lane) return
  const run = aiState.runs[lane]
  if (run.status !== 'running') return
  if (event.type === 'delta') {
    run.output += event.text
    if (lane === 'syntax' && syntaxStream) {
      try {
        run.analysis = syntaxStream.push(event.text)
        const issues = syntaxStream.drainIssues()
        if (issues.length) run.warning = issues.at(-1)!.message + ' 后续有效批次继续显影。'
      } catch (error) {
        run.error = error instanceof Error ? error.message : '句法增量校验失败。'
        run.status = 'error'
        void window.ai?.cancel(run.id)
      }
    }
    return
  }
  if (event.type === 'reasoning') {
    run.reasoning += event.text
    return
  }
  if (event.type === 'cancelled') {
    run.status = 'cancelled'
    return
  }
  if (event.type === 'error') {
    run.status = 'error'
    run.error = event.message
    return
  }
  run.status = 'done'
  if (['length', 'max_tokens'].includes(event.finishReason)) {
    run.warning = '已达到模型输出上限，内容可能不完整。可提高输出长度后重试。'
    if (lane === 'syntax') {
      run.status = 'error'
      run.error = run.warning
      return
    }
  }
  if (lane === 'syntax' && aiSelection.value && !aiState.stale) {
    try {
      run.analysis = syntaxStream?.finish() ?? null
      aiState.syntaxReading = ''
      aiState.syntaxRelation = ''
    } catch (error) {
      run.status = 'error'
      run.error = error instanceof Error ? error.message : '句法校验失败。'
    }
  }
}

export const SYNTAX_DEMOS = SYNTAX_EXAMPLES
export const SYNTAX_DEMO = SYNTAX_EXAMPLES[0].analysis
