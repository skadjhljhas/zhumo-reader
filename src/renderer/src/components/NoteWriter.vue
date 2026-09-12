<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, Prec, Transaction } from '@codemirror/state'
import { keymap, placeholder } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import type { NoteRecord, SourceBlock } from '../../../shared/types'
import type { SourceChange } from '../composables/sourceText'
import type { WriterPlace } from '../composables/noteAuthoring'
import { saveCurrentDocument } from '../composables/useEditor'
import NoteCard from './NoteCard.vue'
import StudioIcon from './StudioIcon.vue'
import { studio } from '../composables/useStudio'
import { editorPositionSync } from '../composables/editorPositionSync'
import {
  SourcePositionIndex,
  visibleSourcePlace,
  type SourcePlace
} from '../composables/sourcePosition'
import { rememberDocumentPosition } from '../composables/documentPosition'

const props = defineProps<{
  label: string
  value: string
  context: string
  inline: boolean
  closed: boolean
  note?: NoteRecord
  busy: boolean
  history: string[]
  position: number
  place?: WriterPlace
  offsets: number[]
  sourceBlocks: SourceBlock[]
}>()
const emit = defineEmits<{
  changes: [changes: SourceChange[]]
  command: [command: 'undo' | 'redo']
  close: []
  return: []
  convert: []
  rename: [label: string]
  navigate: [id: string]
  travel: [index: number]
  child: [position: number, quote: string]
}>()
const mount = ref<HTMLElement>(),
  newLabel = ref(props.label)
const previewEl = ref<HTMLElement>()
const sourceIndex = computed(
  () =>
    new SourcePositionIndex(
      props.sourceBlocks.filter((block) => block.kind === 'note' && block.label === props.label)
    )
)
let editor: EditorView | undefined,
  external = false
let previewNavigation = 0,
  positionFrame = 0,
  updateRevision = 0
let userPreview = false,
  restoring = Boolean(props.place)
function getSourcePlace(): SourcePlace | undefined {
  return previewEl.value ? visibleSourcePlace(previewEl.value, sourceIndex.value) : undefined
}
async function locateSource(place: SourcePlace): Promise<void> {
  userPreview = false
  const token = ++previewNavigation
  for (let i = 0; i < 4 && token === previewNavigation; i++) {
    await nextTick()
    const root = previewEl.value
    const target =
      place.block.key === 'row'
        ? root?.querySelector('.note-card')
        : root?.querySelector('[data-source-block="' + CSS.escape(place.block.key) + '"]')
    if (!root || !target) return
    const rect = target.getBoundingClientRect()
    const delta =
      rect.top +
      rect.height * place.ratio -
      root.getBoundingClientRect().top -
      root.clientHeight * place.viewport
    if (Math.abs(delta) < 1) return
    root.scrollTop += delta
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
const positionSync = editorPositionSync({
  editor: () => editor,
  preview: () => ({ locateSource, getSourcePlace }),
  index: () => sourceIndex.value,
  enabled: () => studio.syncPositions,
  ready: () => !props.busy && !!props.note && !restoring,
  toSource: (offset) => props.offsets[offset] ?? props.offsets.at(-1) ?? 0,
  fromSource: (offset) => {
    let low = 0,
      high = props.offsets.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (props.offsets[mid] < offset) low = mid + 1
      else high = mid
    }
    return Math.min(props.value.length, low)
  },
  remember: rememberDocumentPosition
})
function previewPosition(): void {
  if (!userPreview || props.busy || restoring) return
  cancelAnimationFrame(positionFrame)
  positionFrame = requestAnimationFrame(() => {
    const place = getSourcePlace()
    if (place && userPreview && !props.busy) void positionSync.previewMoved(place)
  })
}
function claimPreview(): void {
  positionSync.claimPreview()
  previewNavigation++
  userPreview = true
  previewPosition()
}
watch(
  () => [props.note, props.busy, studio.syncPositions],
  () => {
    if (!props.busy && !restoring) void nextTick(positionSync.refresh)
  }
)
const words = computed(() => Array.from(props.value).length)
watch(
  () => props.label,
  (label) => {
    newLabel.value = label
  }
)
watch(
  () => props.value,
  (value) => {
    if (!editor || value === editor.state.doc.toString()) return
    const old = editor.state.doc.toString()
    let from = 0,
      end = 0
    while (from < old.length && from < value.length && old[from] === value[from]) from++
    while (
      end < old.length - from &&
      end < value.length - from &&
      old[old.length - end - 1] === value[value.length - end - 1]
    )
      end++
    external = true
    editor.dispatch({
      changes: { from, to: old.length - end, insert: value.slice(from, value.length - end) },
      annotations: Transaction.addToHistory.of(false)
    })
    external = false
  }
)
onMounted(() => {
  const place = props.place
  editor = new EditorView({
    parent: mount.value,
    state: EditorState.create({
      doc: props.value,
      selection: place
        ? {
            anchor: Math.min(place.anchor, props.value.length),
            head: Math.min(place.head, props.value.length)
          }
        : { anchor: Math.max(0, props.value.search(/\S/)) },
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        placeholder('写下这条注释。可以充分展开，也可以只留下一个精确的区分。'),
        EditorView.contentAttributes.of({ 'aria-label': '注释正文编辑器', spellcheck: 'false' }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-z',
              run: () => {
                emit('command', 'undo')
                return true
              }
            },
            {
              key: 'Mod-Shift-z',
              run: () => {
                emit('command', 'redo')
                return true
              }
            },
            {
              key: 'Mod-y',
              run: () => {
                emit('command', 'redo')
                return true
              }
            },
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
          if (!restoring) {
            const revision = ++updateRevision
            void nextTick(() => {
              if (revision === updateRevision) positionSync.update(update)
            })
          }
          if (external || !update.docChanged) return
          const changes: SourceChange[] = []
          update.changes.iterChanges((from, to, _a, _b, insert) =>
            changes.push({ from, to, insert: insert.toString() })
          )
          emit('changes', changes)
        })
      ]
    })
  })
  editor.scrollDOM.addEventListener('wheel', positionSync.claimEditor, { passive: true })
  editor.scrollDOM.addEventListener('pointerdown', positionSync.claimEditor)
  if (place) editor.scrollDOM.scrollTop = place.scroll
  if (place?.previewScroll)
    void nextTick(() => {
      if (previewEl.value) previewEl.value.scrollTop = place.previewScroll!
    })
  editor.focus()
  void nextTick(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        restoring = false
        if (!place) positionSync.refresh()
      })
    )
  )
})
onBeforeUnmount(() => {
  previewNavigation++
  updateRevision++
  cancelAnimationFrame(positionFrame)
  positionSync.destroy()
  editor?.scrollDOM.removeEventListener('wheel', positionSync.claimEditor)
  editor?.scrollDOM.removeEventListener('pointerdown', positionSync.claimEditor)
  editor?.destroy()
})
function getPlace(): WriterPlace {
  return {
    anchor: editor?.state.selection.main.anchor ?? 0,
    head: editor?.state.selection.main.head ?? 0,
    scroll: editor?.scrollDOM.scrollTop ?? 0,
    previewScroll: previewEl.value?.scrollTop ?? 0
  }
}
function wrap(before: string, after = before): void {
  if (!editor) return
  const { from, to } = editor.state.selection.main
  editor.dispatch({
    changes: { from, to, insert: before + editor.state.sliceDoc(from, to) + after },
    selection: { anchor: from + before.length, head: to + before.length }
  })
  editor.focus()
}
function child(): void {
  if (!editor) return
  const { from, to } = editor.state.selection.main
  emit('child', to, editor.state.sliceDoc(from, to))
}
function focus(): void {
  editor?.focus()
}
function followLink(event: MouseEvent | KeyboardEvent): void {
  if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
  if (!(event.target instanceof Element) || event.defaultPrevented) return
  const anchor = event.target.closest('a[href]')
  const hash = anchor?.getAttribute('href') ?? ''
  if (!hash.startsWith('#') || anchor?.closest('.zmu-math')) return
  event.preventDefault()
  window.dispatchEvent(new CustomEvent('zhumo:preview-fragment', { detail: hash }))
}
defineExpose({ getPlace, focus, sourceOffset: positionSync.current })
</script>

<template>
  <section class="note-writing-desk" aria-label="注释写作台">
    <header class="writer-heading">
      <div>
        <span class="writer-eyebrow">ANNOTATION / 一条思路的展开</span>
        <h2>
          注释写作 <span>{{ note?.displayMark ?? label }}</span>
        </h2>
      </div>
      <div class="writer-exits">
        <button @click="emit('return')"><StudioIcon name="back" :size="14" />回到引用</button
        ><button @click="emit('close')">回到文稿源文<StudioIcon name="arrow" :size="14" /></button>
      </div>
    </header>
    <nav v-if="history.length > 1" class="writer-history" aria-label="注释写作路径">
      <button
        aria-label="写作返回"
        :disabled="position === 0"
        @click="emit('travel', position - 1)"
      >
        <StudioIcon name="back" :size="14" />
      </button>
      <ol>
        <li v-for="(step, index) in history" :key="index">
          <button
            :aria-current="index === position ? 'step' : undefined"
            :title="step"
            @click="emit('travel', index)"
          >
            {{ step }}
          </button>
        </li>
      </ol>
      <button
        aria-label="写作前进"
        :disabled="position + 1 === history.length"
        @click="emit('travel', position + 1)"
      >
        <StudioIcon name="arrow" :size="14" />
      </button>
    </nav>
    <div v-if="context" class="writer-context">
      <span>来处</span>
      <p>{{ context }}</p>
    </div>
    <div class="writer-meta">
      <form v-if="!inline" @submit.prevent="emit('rename', newLabel)">
        <label for="note-writing-label">标号</label
        ><input
          id="note-writing-label"
          v-model="newLabel"
          aria-label="注释标号"
          spellcheck="false"
        /><button :disabled="newLabel === label" type="submit">更新引用</button>
      </form>
      <div v-else class="writer-inline">
        <span>行内注 · {{ label }}</span
        ><button :disabled="!closed" @click="emit('convert')">转为独立注释</button>
      </div>
      <span>{{ words.toLocaleString() }} 字符 · {{ note?.refCount ?? 1 }} 处引用</span>
    </div>
    <div class="writer-columns">
      <section class="writer-compose" aria-label="撰写注释">
        <div class="writer-pane-head">
          <span>写作 <small>Markdown</small></span>
          <div role="toolbar" aria-label="注释格式工具">
            <button aria-label="注释撤销" @click="emit('command', 'undo')">
              <StudioIcon name="undo" :size="14" /></button
            ><button aria-label="注释重做" @click="emit('command', 'redo')">重做</button
            ><button aria-label="注释加粗" @click="wrap('**')"><b>B</b></button
            ><button aria-label="注释公式" @click="wrap('$')">公式</button
            ><button class="writer-child" @click="child">
              <StudioIcon name="branches" :size="13" />写一条子注
            </button>
          </div>
        </div>
        <div ref="mount" class="editor-mount writer-editor" />
      </section>
      <section class="writer-proof" aria-label="注释排版预览">
        <div class="writer-pane-head">
          <span>阅读 <small>此刻的旁注</small></span
          ><span class="writer-status" role="status">{{ busy ? '正在排版…' : '与文稿同步' }}</span>
        </div>
        <div
          ref="previewEl"
          class="writer-preview"
          :aria-busy="busy"
          @scroll.passive="previewPosition"
          @wheel.passive="claimPreview"
          @pointerdown="claimPreview"
          @click="followLink"
          @keydown="followLink"
        >
          <NoteCard
            v-if="note?.html"
            :note="note"
            :active="false"
            :focused="false"
            :cycle="!!note.cycle"
            in-atlas
            @navigate="emit('navigate', $event)"
          />
          <div v-else class="writer-empty">
            <span>注</span>
            <p>文字会在这里呈现。<br />让想说的话得到它需要的空间。</p>
          </div>
        </div>
      </section>
    </div>
    <footer class="writer-colophon">
      <span>修改与文稿同步 · 保存时一并写入文件</span><span>Ctrl S 保存 · Ctrl Z 撤销</span>
    </footer>
  </section>
</template>

<style src="../styles/note-writer.css"></style>
