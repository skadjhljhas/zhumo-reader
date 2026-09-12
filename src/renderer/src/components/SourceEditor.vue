<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { undo, redo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { documentSession, isDirty } from '../composables/documentSession'
import { saveCurrentDocument, flushDraft } from '../composables/useEditor'
import { applySourceChanges, normalizeSource, type SourceChange } from '../composables/sourceText'
import { bookState, parseInWorker } from '../composables/useBook'
import { settings } from '../composables/useSettings'
import type { ParsedBook } from '../../../shared/types'
import StudioIcon from './StudioIcon.vue'
import DraftPreview from './DraftPreview.vue'
import { attachBookResources } from '../composables/bookResources'
import NoteWriter from './NoteWriter.vue'
import { useNoteWriting } from '../composables/useNoteWriting'
import { noteEditRequest } from '../composables/noteEditing'
import { studio } from '../composables/useStudio'
import { editorPositionSync, type PositionPreview } from '../composables/editorPositionSync'
import { SourcePositionIndex } from '../composables/sourcePosition'
import { currentDocumentOffset, rememberDocumentPosition } from '../composables/documentPosition'

const mount = ref<HTMLElement>()
const preview = shallowRef<ParsedBook | null>(bookState.book)
const previewComponent = ref<PositionPreview>()
const sourceIndex = computed(() => new SourcePositionIndex(preview.value?.sourceBlocks))
const previewOn = ref(true)
const compactMedia = window.matchMedia('(max-width: 1000px)')
const compact = ref(compactMedia.matches),
  previewFocus = ref(false)
const previewVisible = computed(() => previewOn.value && (!compact.value || previewFocus.value))
function compactChanged(): void {
  compact.value = compactMedia.matches
}
const previewBusy = ref(false)
const line = ref(1),
  column = ref(1)
const chars = computed(() => documentSession.source.length.toLocaleString())
let editor: EditorView | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0
let fromEditor = false
let externalUpdate = false
let previewController: AbortController | undefined
const writing = useNoteWriting(
  () => editor,
  () => preview.value
)
const {
  region: writerRegion,
  component: writerComponent,
  projection: writerProjection,
  note: writerNote,
  current: writerVisit,
  position: writerPosition,
  revision: writerRevision,
  labels: writerLabels
} = writing
const positionSync = editorPositionSync({
  editor: () => editor,
  preview: () => previewComponent.value,
  index: () => sourceIndex.value,
  enabled: () => studio.syncPositions && !writerRegion.value,
  ready: () => !previewBusy.value && !writerRegion.value && !!preview.value?.sourceBlocks,
  remember: (offset) => {
    if (!writerRegion.value) rememberDocumentPosition(offset)
  }
})
function captureEditorPosition(): void {
  const offset =
    writerRegion.value && writerProjection.value
      ? (writerComponent.value?.sourceOffset?.() ??
        writerProjection.value.offsets[writerComponent.value?.getPlace().head ?? 0])
      : positionSync.current()
  if (offset !== undefined) rememberDocumentPosition(offset, true)
}
function refreshPreview(): void {
  previewController?.abort()
  if (!previewOn.value && !writerRegion.value) {
    previewBusy.value = false
    return
  }
  previewController = new AbortController()
  const seq = ++sequence
  const source = documentSession.source
  previewBusy.value = true
  void parseInWorker(source, settings.noteLevelCap, previewController.signal)
    .then((book) => {
      if (seq === sequence) {
        preview.value = attachBookResources(book, documentSession.path)
        previewBusy.value = false
        writing.reconcile()
        void nextTick(positionSync.refresh)
      }
    })
    .catch((error: unknown) => {
      if (seq !== sequence || (error instanceof DOMException && error.name === 'AbortError')) return
      previewBusy.value = false
      documentSession.error = '预览暂时不可用，源文仍可编辑和保存。'
    })
}
watch(
  () => documentSession.source,
  (source) => {
    if (editor && !fromEditor && normalizeSource(source) !== editor.state.doc.toString()) {
      externalUpdate = true
      const before = editor.state.doc.toString(),
        after = normalizeSource(source)
      let from = 0,
        suffix = 0
      while (from < before.length && from < after.length && before[from] === after[from]) from++
      while (
        suffix < before.length - from &&
        suffix < after.length - from &&
        before[before.length - suffix - 1] === after[after.length - suffix - 1]
      )
        suffix++
      editor.dispatch({
        changes: {
          from,
          to: before.length - suffix,
          insert: after.slice(from, after.length - suffix)
        }
      })
      externalUpdate = false
    }
    if (timer) clearTimeout(timer)
    previewController?.abort()
    sequence++
    previewBusy.value = true
    timer = setTimeout(refreshPreview, source.length > 300000 ? 1000 : 350)
  },
  { flush: 'sync' }
)
watch(() => settings.noteLevelCap, refreshPreview)
watch(previewOn, refreshPreview)
watch(() => studio.syncPositions, positionSync.refresh)
watch(
  () => [compact.value, previewFocus.value],
  () => {
    void nextTick(positionSync.refresh)
  }
)
watch(() => documentSession.path, refreshPreview)
watch(writerRegion, (region, before) => {
  if (region && !before) refreshPreview()
})
function consumeNoteRequest(): void {
  if (!editor || !noteEditRequest.value) return
  const request = noteEditRequest.value
  noteEditRequest.value = null
  if (request.path !== documentSession.path) return
  if ('label' in request) writing.open(request.label)
  else if (request.source === documentSession.source)
    writing.createAt(request.position, request.quote)
  else documentSession.error = '文稿已经改变，未插入注释。请重新选择要注释的句子。'
}
watch(noteEditRequest, consumeNoteRequest)
function togglePreview(): void {
  if (compact.value) {
    const offset = positionSync.current()
    previewOn.value = true
    previewFocus.value = !previewFocus.value
    if (!previewFocus.value)
      void nextTick(() => {
        editor?.requestMeasure()
        if (studio.syncPositions && offset !== undefined && editor)
          editor.dispatch({
            selection: { anchor: Math.min(offset, editor.state.doc.length) },
            effects: EditorView.scrollIntoView(Math.min(offset, editor.state.doc.length), {
              y: 'center'
            })
          })
        editor?.focus()
      })
  } else previewOn.value = !previewOn.value
}
function fragmentRequested(event: Event): void {
  if (!writerRegion.value) return
  const hash = (event as CustomEvent<unknown>).detail
  if (typeof hash !== 'string' || !hash.startsWith('#')) return
  writing.close()
  previewOn.value = true
  previewFocus.value = compact.value
  void nextTick(() => {
    document.querySelector<HTMLElement>('.preview-scroll')?.focus({ preventScroll: true })
    window.dispatchEvent(new CustomEvent('zhumo:preview-fragment', { detail: hash }))
  })
}
onMounted(() => {
  const initialPosition = currentDocumentOffset()
  editor = new EditorView({
    parent: mount.value,
    state: EditorState.create({
      doc: normalizeSource(documentSession.source),
      selection: initialPosition === undefined ? undefined : { anchor: initialPosition },
      extensions: [
        basicSetup,
        markdown(),
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
            { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
            { tag: tags.emphasis, color: 'var(--text-2)', fontStyle: 'italic' },
            { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
            { tag: [tags.monospace, tags.string], color: 'var(--accent)' },
            { tag: [tags.meta, tags.comment, tags.processingInstruction], color: 'var(--text-3)' }
          ])
        ),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Markdown 源文编辑器',
          spellcheck: 'false'
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void saveCurrentDocument()
                return true
              }
            },
            {
              key: 'Mod-Shift-s',
              run: () => {
                void saveCurrentDocument(true)
                return true
              }
            }
          ])
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !externalUpdate) {
            const changes: SourceChange[] = []
            update.changes.iterChanges((from, to, _fromB, _toB, insert) =>
              changes.push({ from, to, insert: insert.toString() })
            )
            fromEditor = true
            const nextSource = applySourceChanges(documentSession.source, changes)
            documentSession.source =
              normalizeSource(nextSource) === normalizeSource(documentSession.savedSource)
                ? documentSession.savedSource
                : nextSource
            fromEditor = false
          }
          writing.map(update)
          if (!writerRegion.value) positionSync.update(update)
          if (update.selectionSet || update.docChanged) {
            const position = update.state.selection.main.head
            const currentLine = update.state.doc.lineAt(position)
            line.value = currentLine.number
            column.value = position - currentLine.from + 1
          }
        })
      ]
    })
  })
  editor.scrollDOM.addEventListener('wheel', positionSync.claimEditor, { passive: true })
  editor.scrollDOM.addEventListener('pointerdown', positionSync.claimEditor)
  if (initialPosition !== undefined)
    editor.dispatch({ effects: EditorView.scrollIntoView(initialPosition, { y: 'center' }) })
  editor.focus()
  consumeNoteRequest()
  if (documentSession.source === bookState.payload?.content && preview.value?.sourceBlocks)
    void nextTick(positionSync.refresh)
  else refreshPreview()
  window.addEventListener('zhumo:preview-fragment', fragmentRequested)
  compactMedia.addEventListener('change', compactChanged)
  window.addEventListener('zhumo:capture-editor-position', captureEditorPosition)
})
onBeforeUnmount(() => {
  sequence++
  if (timer) clearTimeout(timer)
  previewController?.abort()
  window.removeEventListener('zhumo:preview-fragment', fragmentRequested)
  compactMedia.removeEventListener('change', compactChanged)
  window.removeEventListener('zhumo:capture-editor-position', captureEditorPosition)
  editor?.scrollDOM.removeEventListener('wheel', positionSync.claimEditor)
  editor?.scrollDOM.removeEventListener('pointerdown', positionSync.claimEditor)
  positionSync.destroy()
  void flushDraft()
  editor?.destroy()
})
function wrap(before: string, after = before): void {
  if (!editor) return
  const { from, to } = editor.state.selection.main
  const selected = editor.state.sliceDoc(from, to)
  editor.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: to + before.length }
  })
  editor.focus()
}
function run(command: 'undo' | 'redo' | 'search'): void {
  if (!editor) return
  if (command === 'undo') undo(editor)
  else if (command === 'redo') redo(editor)
  else openSearchPanel(editor)
  void nextTick(() => {
    if (writerRegion.value) writerComponent.value?.focus()
    else editor?.focus()
  })
}
</script>
<template>
  <section class="editor-workspace" aria-label="编辑工作区">
    <header class="editor-topline">
      <span
        ><strong>{{ writerRegion ? '注释写作' : '源文编辑' }}</strong> ·
        {{ isDirty ? '有未保存的修改' : '已保存' }}</span
      >
      <div class="editor-actions">
        <button
          aria-label="同步编辑与阅读位置"
          :aria-pressed="studio.syncPositions"
          :style="{ color: studio.syncPositions ? 'var(--accent)' : undefined }"
          @click="studio.syncPositions = !studio.syncPositions"
        >
          位置同步
        </button>
        <button v-if="!writerRegion" :aria-pressed="previewVisible" @click="togglePreview">
          {{ compact && previewFocus ? '回到源文' : previewVisible ? '收起预览' : '显示预览' }}
        </button>
        <button :disabled="documentSession.saving" @click="saveCurrentDocument(true)">
          另存为
        </button>
        <button
          class="studio-primary"
          :disabled="documentSession.saving"
          @click="saveCurrentDocument()"
        >
          <StudioIcon name="save" :size="14" />{{ documentSession.saving ? '保存中…' : '保存' }}
          <kbd>Ctrl S</kbd>
        </button>
      </div>
    </header>
    <div
      v-if="!writerRegion && !(compact && previewFocus)"
      class="editor-format"
      role="toolbar"
      aria-label="源文格式工具"
    >
      <button title="撤销" aria-label="撤销" @click="run('undo')">
        <StudioIcon name="undo" :size="15" />
      </button>
      <button title="重做" @click="run('redo')">重做</button><i />
      <button title="加粗" @click="wrap('**')"><b>B</b></button>
      <button title="斜体" @click="wrap('*')"><em>I</em></button>
      <button title="行内代码" @click="wrap('`')">代码</button>
      <button title="插入链接" @click="wrap('[', '](https://)')">链接</button>
      <button title="插入公式" @click="wrap('$')">公式</button>
      <button title="在所选文字之后写一条注释" @click="writing.create">写注释</button>
      <button title="修改光标所在的注释" @click="writing.select">修改注释</button><i />
      <button title="查找与替换" @click="run('search')">查找 / 替换</button>
      <span class="editor-position">{{ chars }} 字符 · {{ line }} 行 {{ column }} 列</span>
    </div>
    <p v-if="documentSession.error" class="studio-error editor-error" role="alert">
      {{ documentSession.error }}
    </p>
    <div
      v-show="!writerRegion"
      class="editor-panes"
      :class="{ 'with-preview': previewOn, 'focus-preview': compact && previewFocus }"
    >
      <div ref="mount" class="editor-mount" />
      <DraftPreview
        v-if="previewOn && !writerRegion"
        ref="previewComponent"
        :book="preview"
        :busy="previewBusy"
        @edit-note="writing.open"
        @position="positionSync.previewMoved"
        @interact="positionSync.claimPreview"
      />
    </div>
    <NoteWriter
      v-if="writerRegion && writerProjection"
      ref="writerComponent"
      :key="writerRevision"
      :label="writerRegion.label"
      :value="writerProjection.text"
      :context="writerVisit?.context ?? ''"
      :inline="writerRegion.inline"
      :closed="writerRegion.closed"
      :note="writerNote"
      :busy="previewBusy"
      :history="writerLabels"
      :position="writerPosition"
      :place="writerVisit?.place"
      :offsets="writerProjection.offsets"
      :source-blocks="preview?.sourceBlocks ?? []"
      @changes="writing.apply"
      @command="run"
      @close="writing.close()"
      @return="writing.close(true)"
      @child="writing.child"
      @travel="writing.travel"
      @navigate="writing.navigate"
      @rename="writing.rename"
      @convert="writing.convert"
    />
  </section>
</template>
