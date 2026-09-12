import { EditorView, type ViewUpdate } from '@codemirror/view'
import {
  SourcePositionIndex,
  placeOffset,
  snapSourceOffset,
  sourcePlace,
  type SourcePlace
} from './sourcePosition'

export interface PositionPreview {
  locateSource(place: SourcePlace): Promise<void>
  getSourcePlace(): SourcePlace | undefined
}
interface Options {
  editor(): EditorView | undefined
  preview(): PositionPreview | undefined
  index(): SourcePositionIndex
  enabled(): boolean
  ready(): boolean
  toSource?(local: number): number
  fromSource?(global: number): number
  remember?(offset: number): void
}
interface PositionSynchronizer {
  update(update: ViewUpdate): void
  claimEditor(event?: Event): void
  claimPreview(): void
  previewMoved(place: SourcePlace): Promise<void>
  refresh(): void
  current(): number | undefined
  destroy(): void
}
/** Actual input chooses the leading pane. Followers never change text or focus. */
export function editorPositionSync(options: Options): PositionSynchronizer {
  let driver: 'editor' | 'preview' = 'editor',
    frame = 0,
    generation = 0
  let followingUntil = 0,
    closed = false,
    lastOffset: number | undefined,
    preferCaret = true
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()))
  const remember = (offset: number): number => {
    lastOffset = offset
    options.remember?.(offset)
    return offset
  }
  function editorPlace(caret = false): { offset: number; viewport: number } | undefined {
    const editor = options.editor()
    if (!editor) return
    const root = editor.scrollDOM.getBoundingClientRect()
    if (!root.height) return
    const content = editor.contentDOM.getBoundingClientRect()
    let local: number | null = null,
      viewport = Math.min(100, root.height * 0.25) / root.height
    if (caret) {
      local = editor.state.selection.main.head
      const rect = editor.coordsAtPos(local)
      if (rect && rect.top >= root.top && rect.top < root.bottom)
        viewport = Math.max(0.08, Math.min(0.85, (rect.top - root.top) / root.height))
    } else
      local = editor.posAtCoords(
        { x: Math.max(root.left + 8, content.left + 8), y: root.top + root.height * viewport },
        false
      )
    local ??= editor.state.selection.main.head
    return { offset: options.toSource?.(local) ?? local, viewport }
  }
  function schedule(caret = false): void {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (closed || driver !== 'editor') return
      const place =
        editorPlace(caret) ??
        (lastOffset === undefined ? undefined : { offset: lastOffset, viewport: 0.25 })
      if (!place) return
      remember(place.offset)
      if (!options.enabled() || !options.ready()) return
      const destination = sourcePlace(options.index(), place.offset, place.viewport)
      if (destination) void options.preview()?.locateSource(destination)
    })
  }
  function claimEditor(event?: Event): void {
    followingUntil = 0
    driver = 'editor'
    if (event) preferCaret = false
    generation++
  }
  function claimPreview(): void {
    driver = 'preview'
    generation++
    followingUntil = performance.now() + 220
    cancelAnimationFrame(frame)
  }
  function update(update: ViewUpdate): void {
    if (closed) return
    if (update.docChanged || update.selectionSet) {
      driver = 'editor'
      preferCaret = true
      const offset = update.state.selection.main.head
      remember(options.toSource?.(offset) ?? offset)
      schedule(true)
    } else if (
      update.viewportChanged &&
      driver === 'editor' &&
      performance.now() >= followingUntil
    ) {
      schedule(preferCaret)
    }
  }
  async function previewMoved(place: SourcePlace): Promise<void> {
    if (closed || !options.ready()) return
    driver = 'preview'
    cancelAnimationFrame(frame)
    const offset = remember(placeOffset(place))
    if (!options.enabled()) return
    const editor = options.editor()
    if (!editor || !editor.scrollDOM.getBoundingClientRect().height) return
    const token = ++generation
    followingUntil = performance.now() + 220
    const local = snapSourceOffset(
      editor.state.doc.toString(),
      options.fromSource?.(offset) ?? offset
    )
    editor.dispatch({ effects: EditorView.scrollIntoView(local, { y: 'center' }) })
    for (let i = 0; i < 3 && !closed && token === generation; i++) {
      await nextFrame()
      if (closed || token !== generation) return
      const rect = editor.coordsAtPos(local),
        root = editor.scrollDOM.getBoundingClientRect()
      if (!rect) continue
      const delta = rect.top - root.top - root.height * place.viewport
      if (Math.abs(delta) < 1) break
      editor.scrollDOM.scrollTop += delta
    }
    followingUntil = performance.now() + 100
  }
  function refresh(): void {
    if (driver === 'preview') {
      requestAnimationFrame(() => {
        if (closed) return
        const place =
          options.preview()?.getSourcePlace() ??
          (lastOffset === undefined ? undefined : sourcePlace(options.index(), lastOffset))
        if (place) void previewMoved(place)
      })
    } else schedule(preferCaret)
  }
  function current(): number | undefined {
    if (driver === 'preview' && options.ready()) {
      const place = options.preview()?.getSourcePlace()
      if (place) return remember(placeOffset(place))
    }
    const place = editorPlace(preferCaret)
    return place ? remember(place.offset) : lastOffset
  }
  function destroy(): void {
    closed = true
    generation++
    cancelAnimationFrame(frame)
  }
  return { update, claimEditor, claimPreview, previewMoved, refresh, current, destroy }
}
