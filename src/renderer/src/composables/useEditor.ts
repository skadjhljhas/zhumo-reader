import { watch } from 'vue'
import { bookState, applyDocumentSource } from './useBook'
import { documentSession, isDirty, guardDocumentAction } from './documentSession'
import { writeDraft, readDrafts, removeRecovery } from './drafts'

let recoveryTimer: ReturnType<typeof setTimeout> | undefined
export async function flushDraft(): Promise<void> {
  if (recoveryTimer) clearTimeout(recoveryTimer)
  if (!documentSession.path || !isDirty.value) return
  const { path, source, savedSource } = documentSession
  try {
    await writeDraft({ path, source, savedSource, updatedAt: Date.now() }, path)
  } catch {
    documentSession.error = '恢复草稿暂时无法写入，请及时保存文档。'
  }
}
watch(
  () => documentSession.source,
  () => {
    if (recoveryTimer) clearTimeout(recoveryTimer)
    if (isDirty.value)
      recoveryTimer = setTimeout(() => {
        void flushDraft()
      }, 500)
  }
)
watch(
  isDirty,
  (dirty) => {
    void window.api?.setDocumentDirty?.(dirty)
  },
  { flush: 'sync' }
)

export async function saveCurrentDocument(saveAs = false): Promise<boolean> {
  if (bookState.payload?.format === 'epub') {
    bookState.statusMessage = 'EPUB 原书以阅读模式打开。'
    return false
  }
  if (documentSession.saving || !bookState.payload) return false
  documentSession.saving = true
  documentSession.error = ''
  const { path, source, savedSource } = documentSession
  try {
    const asNew = saveAs || path.startsWith('zhumo:')
    const payload = asNew
      ? await window.api.saveBookAs(bookState.payload.title, source)
      : await window.api.saveBook(path, source, savedSource)
    if (!payload) return false
    // Edits made while the async save is running remain dirty.
    documentSession.path = payload.path
    documentSession.savedSource = source
    bookState.payload = payload
    await writeDraft(null, path, documentSession.recoveredId).catch(() => undefined)
    documentSession.recoveredId = ''
    if (isDirty.value) await flushDraft()
    await applyDocumentSource(source)
    bookState.statusMessage = '已保存'
    bookState.recentsVersion++
    return true
  } catch (e) {
    documentSession.error = (e instanceof Error ? e.message : String(e)).replace(
      /^Error invoking remote method '[^']+': Error: /,
      ''
    )
    return false
  } finally {
    documentSession.saving = false
    const action = documentSession.pendingAction
    if (action && !documentSession.showLeaveDialog) {
      documentSession.pendingAction = null
      guardDocumentAction(action)
    }
  }
}
export async function discardDraft(): Promise<void> {
  if (recoveryTimer) clearTimeout(recoveryTimer)
  documentSession.savedSource = bookState.payload?.content ?? documentSession.savedSource
  documentSession.source = documentSession.savedSource
  documentSession.error = ''
  await writeDraft(null, documentSession.path, documentSession.recoveredId).catch(() => undefined)
  documentSession.recoveredId = ''
}
export function restoreDraft(): void {
  const draft = documentSession.recovery
  if (!draft) return
  documentSession.recoveredId = draft.id
  documentSession.savedSource = draft.savedSource
  documentSession.source = draft.source
  documentSession.mode = 'edit'
  documentSession.recovery = null
}

export async function ignoreRecovery(): Promise<void> {
  const draft = documentSession.recovery
  if (!draft) return
  try {
    await removeRecovery(draft.id)
    const drafts = await readDrafts(documentSession.path)
    documentSession.recoveryAlternatives = drafts
    documentSession.recovery = drafts[0] ?? null
  } catch {
    documentSession.error = '暂时无法清除这份草稿，请稍后重试。'
  }
}
