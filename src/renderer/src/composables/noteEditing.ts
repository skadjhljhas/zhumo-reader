import { shallowRef } from 'vue'
import { documentSession } from './documentSession'
import { bookState } from './useBook'
import { studio } from './useStudio'
import { closeNotePeek } from './notePeek'
import { rememberDocumentPosition } from './documentPosition'

type NoteEditRequest =
  | { path: string; label: string }
  | { path: string; source: string; position: number; quote: string }
export const noteEditRequest = shallowRef<NoteEditRequest | null>(null)
/** Called only from a control that explicitly activates editing. */
export function editNote(label: string): void {
  if (bookState.payload?.format === 'epub') {
    bookState.statusMessage = 'EPUB 原书以阅读模式打开。'
    return
  }
  noteEditRequest.value = { path: documentSession.path, label }
  closeNotePeek()
  studio.atlasOpen = false
  documentSession.mode = 'edit'
}

/** The reading control explicitly enables editing; no source is changed here. */
export function createReadingNote(source: string, position: number, quote: string): void {
  if (bookState.payload?.format === 'epub') return
  if (documentSession.source !== source) return
  rememberDocumentPosition(position)
  noteEditRequest.value = { path: documentSession.path, source, position, quote }
  closeNotePeek()
  studio.atlasOpen = false
  documentSession.mode = 'edit'
}
