import { reactive, shallowRef, watch } from 'vue'
import {
  aiProfileReady,
  type AnnotationMode,
  type AiEvent,
  type SyntaxAnalysis
} from '../../../shared/ai-types'
import { createDocumentAnnotationStream } from '../../../shared/document-annotations'
import {
  documentAnnotationTarget,
  type DocumentAnnotationBlock
} from '../effects/document-annotation-target'
import { readingAppearance, watchReadingAppearance } from '../effects/reading-appearance'
import { aiState, loadAiProfiles } from './aiReading'
import { settings, uiState, persistSettingsNow } from './useSettings'
import { bookState } from './useBook'
import { documentSession } from './documentSession'
import { studio } from './useStudio'

export const documentAnnotations = reactive({
  status: 'idle' as 'idle' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled',
  phase: '选择全文标注后开始',
  reasoning: '',
  summary: '',
  error: '',
  warning: '',
  count: 0,
  blocks: 0
})
export const documentAnnotationSources = shallowRef<
  Array<{
    key: string
    analysis: SyntaxAnalysis
    anchors: DocumentAnnotationBlock['anchors']
  }>
>([])
let active:
  | {
      id: string
      key: string
      epoch: number
      abort: AbortController
      stream?: ReturnType<typeof createDocumentAnnotationStream>
      blocks: DocumentAnnotationBlock[]
    }
  | undefined
let remembered = '',
  paused = false,
  refresh: (() => void) | undefined
let sourceEpoch = 0

let switchingMode = false
export async function chooseAnnotationMode(mode: AnnotationMode): Promise<void> {
  switchingMode = true
  settings.annotationMode = mode
  settings.automaticSyntax = mode === 'follow'
  paused = false
  try {
    await persistSettingsNow()
  } catch (error) {
    documentAnnotations.error = error instanceof Error ? error.message : '标注模式未能保存。'
    paused = true
  } finally {
    switchingMode = false
    refresh?.()
  }
}
export function stopDocumentAnnotations(): void {
  paused = true
  if (active) {
    active.abort.abort()
    if (active.id) void window.ai?.cancel(active.id)
    active = undefined
  }
  documentAnnotations.status = 'cancelled'
  documentAnnotations.phase = '全文标注已停止，已有结果保留'
}
export function retryDocumentAnnotations(): void {
  stopDocumentAnnotations()
  paused = false
  remembered = ''
  refresh?.()
}
function project(analysis: SyntaxAnalysis, blocks: DocumentAnnotationBlock[], epoch: number): void {
  const previous = new Map(documentAnnotationSources.value.map((source) => [source.key, source]))
  const grouped = new Map<string, NonNullable<SyntaxAnalysis['marks']>>()
  for (const mark of analysis.marks ?? []) {
    const id = mark.blockId!
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id)!.push(mark)
  }
  documentAnnotationSources.value = blocks.flatMap((block) => {
    const marks = grouped.get(block.id)
    if (!marks?.length) return []
    const key = `document-${epoch}-${block.id}`
    const old = previous.get(key)
    return [
      old &&
      old.analysis.marks?.length === marks.length &&
      old.analysis.marks.every((m, i) => m === marks[i])
        ? old
        : {
            key,
            anchors: block.anchors,
            analysis: { version: 4 as const, text: block.text, spans: [], marks, summary: '' }
          }
    ]
  })
  documentAnnotations.count = analysis.marks?.length ?? 0
  documentAnnotations.summary = analysis.summary
}
export function mountDocumentAnnotations(): () => void {
  void loadAiProfiles()
  let pending = false,
    disposed = false
  const reconcile = async (): Promise<void> => {
    if (disposed || switchingMode) return
    const profile = aiState.profiles.syntax
    const key = JSON.stringify([
      documentSession.path,
      documentSession.source,
      profile.revision,
      readingAppearance()
    ])
    if (settings.annotationMode !== 'document' || documentSession.mode !== 'read') {
      if (active) stopDocumentAnnotations()
      documentAnnotationSources.value = []
      remembered = ''
      paused = false
      return
    }
    if (remembered && remembered !== key) {
      if (active) stopDocumentAnnotations()
      documentAnnotationSources.value = []
      remembered = ''
      paused = false
    }
    if (
      active ||
      remembered === key ||
      paused ||
      bookState.status !== 'reading' ||
      !bookState.book ||
      !aiState.loaded ||
      !window.ai ||
      !aiProfileReady(profile) ||
      aiState.settingsOpen ||
      uiState.settingsOpen ||
      !aiState.lightsOn ||
      studio.effectsMode === 'off'
    )
      return
    const job = {
      id: '',
      key,
      epoch: ++sourceEpoch,
      abort: new AbortController(),
      blocks: [] as DocumentAnnotationBlock[],
      stream: undefined as ReturnType<typeof createDocumentAnnotationStream> | undefined
    }
    active = job
    remembered = key
    Object.assign(documentAnnotations, {
      status: 'preparing',
      phase: '正在建立全文文本索引…',
      reasoning: '',
      summary: '',
      error: '',
      warning: '',
      count: 0
    })
    try {
      job.blocks = await documentAnnotationTarget(bookState.book, job.abort.signal)
      if (active !== job || job.abort.signal.aborted) return
      documentAnnotations.blocks = job.blocks.length
      job.stream = createDocumentAnnotationStream(job.blocks)
      job.id = crypto.randomUUID()
      documentAnnotations.status = 'running'
      documentAnnotations.phase = '正在通读全文，标注随输出显现'
      await window.ai.start({
        id: job.id,
        profileRevision: profile.revision,
        lane: 'syntax',
        automatic: true,
        annotationMode: 'document',
        document: documentSession.source,
        selectedText: '',
        instruction: '',
        documentBlocks: job.blocks.map(({ id, text }) => ({ id, text })),
        readingAppearance: readingAppearance()
      })
      if (active !== job || job.abort.signal.aborted) void window.ai.cancel(job.id)
    } catch (error) {
      if (active !== job || job.abort.signal.aborted) return
      active = undefined
      documentAnnotations.status = 'error'
      documentAnnotations.error = error instanceof Error ? error.message : '全文标注未能开始。'
      documentAnnotations.phase = '全文标注需要处理'
    }
  }
  const schedule = (): void => {
    if (!pending) {
      pending = true
      queueMicrotask(() => {
        pending = false
        void reconcile()
      })
    }
  }
  refresh = schedule
  const off = window.ai?.onEvent((event: AiEvent) => {
    const job = active
    if (!job || job.id !== event.id || !job.stream) return
    if (event.type === 'reasoning') {
      documentAnnotations.reasoning += event.text
      return
    }
    if (event.type === 'cancelled') {
      stopDocumentAnnotations()
      return
    }
    try {
      if (event.type === 'error') throw Error(event.message)
      if (event.type === 'delta') {
        const next = job.stream.push(event.text)
        const issues = job.stream.drainIssues()
        if (issues.length) documentAnnotations.warning = issues.at(-1)!.message
        if (next) project(next, job.blocks, job.epoch)
        return
      }
      if (['length', 'max_tokens'].includes(event.finishReason))
        throw Error('模型在完成全文前达到输出上限；已有标注保留，可调整模型配置后重试。')
      project(job.stream.finish(), job.blocks, job.epoch)
      documentAnnotations.status = 'done'
      documentAnnotations.phase = `全文标注完成 · ${documentAnnotations.count} 处`
      active = undefined
    } catch (error) {
      documentAnnotations.status = 'error'
      documentAnnotations.phase = '全文标注未完整结束，已有结果保留'
      documentAnnotations.error = error instanceof Error ? error.message : '全文标注暂时中断。'
      active = undefined
      void window.ai?.cancel(job.id)
    }
  })
  const unwatch = watch(
    () => [
      settings.annotationMode,
      documentSession.source,
      documentSession.path,
      documentSession.mode,
      bookState.status,
      aiState.loaded,
      aiState.profiles.syntax.revision,
      aiState.settingsOpen,
      uiState.settingsOpen,
      aiState.lightsOn,
      studio.effectsMode
    ],
    schedule
  )
  const appearance = watchReadingAppearance(schedule)
  schedule()
  return () => {
    disposed = true
    stopDocumentAnnotations()
    unwatch()
    appearance()
    off?.()
    refresh = undefined
    remembered = ''
    documentAnnotationSources.value = []
  }
}
