import {
  computed,
  nextTick,
  ref,
  shallowRef,
  type Ref,
  type ShallowRef,
  type ComputedRef
} from 'vue'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import type { ParsedBook, NoteRecord } from '../../../shared/types'
import { documentSession } from './documentSession'
import { normalizeSource, type SourceChange } from './sourceText'
import { matchDefStart } from '../parser/scan'
import {
  inspectNoteSource,
  projectNote,
  noteChanges,
  createNoteChanges,
  defineMissingNote,
  expandInlineNote,
  renameNoteChanges,
  type NoteSourceRegion,
  type NoteProjection,
  type WriterPlace
} from './noteAuthoring'

interface Visit {
  label: string
  origin: number
  context: string
  place?: WriterPlace
}
interface OpenOptions {
  travel?: number
  quote?: string
  origin?: number
  replace?: boolean
}
interface NoteWriting {
  region: ShallowRef<NoteSourceRegion | null>
  component: Ref<
    { getPlace(): WriterPlace; focus(): void; sourceOffset?(): number | undefined } | undefined
  >
  projection: ComputedRef<NoteProjection | null>
  note: ComputedRef<NoteRecord | undefined>
  current: ComputedRef<Visit | undefined>
  position: Ref<number>
  revision: Ref<number>
  labels: ComputedRef<string[]>
  open(label: string, options?: OpenOptions): void
  close(atReference?: boolean): void
  apply(changes: SourceChange[]): void
  map(update: ViewUpdate): void
  create(): void
  createAt(position: number, quote: string): void
  child(position: number, quote: string): void
  select(): void
  travel(index: number): void
  navigate(id: string): void
  rename(label: string): void
  convert(): void
  reconcile(): void
}

/** The small editor is a projection. The master editor owns every change and undo event. */
export function useNoteWriting(
  getEditor: () => EditorView | undefined,
  getPreview: () => ParsedBook | null
): NoteWriting {
  const region = shallowRef<NoteSourceRegion | null>(null)
  const component = ref<{
    getPlace(): WriterPlace
    focus(): void
    sourceOffset?(): number | undefined
  }>()
  const visits = ref<Visit[]>([]),
    position = ref(0),
    revision = ref(0)
  const projection = computed(() =>
    region.value ? projectNote(normalizeSource(documentSession.source), region.value) : null
  )
  const note = computed(() =>
    getPreview()?.notes.find((note) => note.label === region.value?.label)
  )
  const current = computed(() => visits.value[position.value])
  function error(cause: unknown): void {
    documentSession.error =
      cause instanceof Error ? cause.message : '未能定位这条注释，请在源文中继续编辑。'
  }
  function remember(): void {
    if (current.value && component.value) current.value.place = component.value.getPlace()
  }
  function change(changes: SourceChange[]): void {
    if (changes.length) getEditor()?.dispatch({ changes, annotations: isolateHistory.of('full') })
  }
  function open(label: string, options: OpenOptions = {}): void {
    const editor = getEditor()
    if (!editor) return
    try {
      let source = editor.state.doc.toString()
      let index = inspectNoteSource(source)
      let found = index.notes.find((note) => note.label === label)
      if (!found) {
        // The caller explicitly requested writing a missing note, in editing mode.
        change(defineMissingNote(source, label))
        source = editor.state.doc.toString()
        index = inspectNoteSource(source)
        found = index.notes.find((note) => note.label === label)
      }
      if (!found) throw new Error('没有找到这条注释，请在源文中继续编辑。')
      remember()
      const reference =
        index.references.find((ref) => ref.label === label && !ref.parent) ??
        index.references.find((ref) => ref.label === label)
      const origin = options.origin ?? reference?.to ?? found.from
      const line = editor.state.doc.lineAt(
        Math.min(reference?.from ?? origin, editor.state.doc.length)
      )
      const context =
        options.quote ||
        (reference
          ? source.slice(Math.max(line.from, reference.from - 240), reference.from) +
            source.slice(reference.to, Math.min(line.to, reference.to + 160))
          : '')
      if (options.travel !== undefined) position.value = options.travel
      else if (options.replace && current.value) current.value.label = label
      else {
        const next = [
          ...visits.value.slice(0, position.value + 1),
          { label, origin, context }
        ].slice(-40)
        visits.value = next
        position.value = next.length - 1
      }
      region.value = found
      revision.value++
      documentSession.error = ''
    } catch (cause) {
      error(cause)
    }
  }
  function close(atReference = false): void {
    const editor = getEditor()
    const target = atReference ? current.value?.origin : projection.value?.offsets[0]
    remember()
    region.value = null
    visits.value = []
    position.value = 0
    void nextTick(() => {
      if (!editor) return
      const anchor = Math.max(
        0,
        Math.min(target ?? editor.state.selection.main.head, editor.state.doc.length)
      )
      editor.dispatch({ selection: { anchor }, scrollIntoView: true })
      editor.requestMeasure()
      editor.focus()
    })
  }
  function apply(changes: SourceChange[]): void {
    const editor = getEditor(),
      value = projection.value
    if (!editor || !value) return
    try {
      editor.dispatch({ changes: noteChanges(value, changes), userEvent: 'input.type' })
    } catch (cause) {
      error(cause)
      // Remount from the authoritative source if a stale projection rejected an edit.
      remember()
      revision.value++
    }
  }
  function map(update: ViewUpdate): void {
    if (!update.docChanged || !region.value) return
    for (const visit of visits.value) visit.origin = update.changes.mapPos(visit.origin, 1)
    const previous = region.value
    const mapped = {
      ...previous,
      from: update.changes.mapPos(previous.from, -1),
      to: update.changes.mapPos(previous.to, 1),
      contentFrom:
        previous.contentFrom === undefined
          ? undefined
          : update.changes.mapPos(previous.contentFrom, -1)
    }
    const source = update.state.doc.toString()
    // Renaming and undoing that rename keep the writer attached to the same definition.
    if (!mapped.inline) {
      const definition = matchDefStart(source.slice(mapped.from, mapped.to).split('\n', 1)[0])
      if (definition) {
        mapped.label = definition.label
        if (mapped.label !== previous.label) {
          for (const visit of visits.value)
            if (visit.label === previous.label) visit.label = mapped.label
        }
      }
    }
    if (!projectNote(source, mapped)) {
      region.value = null
      visits.value = []
      position.value = 0
      void nextTick(() => {
        if (region.value) component.value?.focus()
        else {
          getEditor()?.requestMeasure()
          getEditor()?.focus()
        }
      })
    } else region.value = mapped
  }
  function create(): void {
    const editor = getEditor()
    if (!editor) return
    const selection = editor.state.selection.main
    createAt(selection.to, editor.state.sliceDoc(selection.from, selection.to))
  }
  function createAt(position: number, quote: string): void {
    const editor = getEditor()
    if (!editor) return
    try {
      if (!Number.isInteger(position) || position < 0 || position > editor.state.doc.length)
        throw new Error('选区位置已经改变，请重新选择。')
      const created = createNoteChanges(editor.state.doc.toString(), position)
      change(created.changes)
      open(created.label, { quote })
    } catch (cause) {
      error(cause)
    }
  }
  function child(position: number, quote: string): void {
    const editor = getEditor(),
      value = projection.value
    if (!editor || !value) return
    try {
      const offset = value.offsets[position]
      if (offset === undefined) throw new Error('请选择注释中的文字位置。')
      remember()
      const created = createNoteChanges(editor.state.doc.toString(), offset)
      change(created.changes)
      open(created.label, { quote })
    } catch (cause) {
      error(cause)
    }
  }
  function select(): void {
    const editor = getEditor()
    if (!editor) return
    try {
      const source = editor.state.doc.toString(),
        position = editor.state.selection.main.head
      const index = inspectNoteSource(source)
      const reference = index.references
        .filter((ref) => ref.from <= position && ref.to >= position)
        .sort((a, b) => a.to - a.from - (b.to - b.from))[0]
      const definition = index.notes
        .filter((note) => note.from <= position && note.to >= position)
        .sort((a, b) => a.to - a.from - (b.to - b.from))[0]
      const label = reference?.label ?? definition?.label
      if (label) open(label)
      else throw new Error('请将光标放在注释标记或定义中，或点击预览中的「修改注释」。')
    } catch (cause) {
      error(cause)
    }
  }
  function travel(index: number): void {
    const visit = visits.value[index]
    if (visit && index !== position.value) open(visit.label, { travel: index })
  }
  function navigate(id: string): void {
    const target = getPreview()?.notes.find((note) => note.id === id)
    if (target) open(target.label)
  }
  function rename(label: string): void {
    const editor = getEditor(),
      currentRegion = region.value
    if (!editor || !currentRegion) return
    try {
      change(renameNoteChanges(editor.state.doc.toString(), currentRegion.label, label))
      documentSession.error = ''
      component.value?.focus()
    } catch (cause) {
      error(cause)
    }
  }
  function convert(): void {
    const editor = getEditor(),
      currentRegion = region.value
    if (!editor || !currentRegion) return
    try {
      remember()
      change(expandInlineNote(editor.state.doc.toString(), currentRegion))
      open(currentRegion.label, { replace: true })
    } catch (cause) {
      error(cause)
    }
  }
  function reconcile(): void {
    if (!region.value?.inline) return
    try {
      const actual = inspectNoteSource(documentSession.source).notes.find(
        (note) => note.inline && note.from === region.value?.from
      )
      if (!actual || actual.to !== region.value.to || actual.closed !== region.value.closed) {
        close()
        documentSession.error =
          '行内注的括号改变了注释范围，已保留修改并回到源文。长注释可以先转为独立注释。'
      }
    } catch (cause) {
      error(cause)
    }
  }
  return {
    region,
    component,
    projection,
    note,
    current,
    position,
    revision,
    labels: computed(() => visits.value.map((visit) => visit.label)),
    open,
    close,
    apply,
    map,
    create,
    createAt,
    child,
    select,
    travel,
    navigate,
    rename,
    convert,
    reconcile
  }
}
