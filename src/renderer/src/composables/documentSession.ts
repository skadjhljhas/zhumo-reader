import { computed, reactive } from 'vue'
import type { Draft } from './drafts'
export const documentSession = reactive({
  mode: 'read' as 'read' | 'edit',
  source: '',
  savedSource: '',
  path: '',
  saving: false,
  error: '',
  showLeaveDialog: false,
  recovery: null as Draft | null,
  recoveryAlternatives: [] as Draft[],
  recoveredId: '',
  pendingAction: null as (() => void) | null
})
export const isDirty = computed(() => documentSession.source !== documentSession.savedSource)
export function resetDocumentSession(path: string, source: string): void {
  Object.assign(documentSession, {
    mode: 'read',
    source,
    savedSource: source,
    path,
    saving: false,
    error: '',
    recovery: null,
    recoveryAlternatives: [],
    recoveredId: ''
  })
}
export function guardDocumentAction(action: () => void): void {
  if (documentSession.saving) {
    documentSession.pendingAction = action
    return
  }
  if (isDirty.value) {
    documentSession.pendingAction = action
    documentSession.showLeaveDialog = true
  } else action()
}
