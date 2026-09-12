import { shallowRef } from 'vue'

export interface NoteHoverGuide {
  noteId: string
  origin: HTMLElement
}
export const noteHoverGuide = shallowRef<NoteHoverGuide | null>(null)
export function clearNoteHoverGuide(): void {
  noteHoverGuide.value = null
}
