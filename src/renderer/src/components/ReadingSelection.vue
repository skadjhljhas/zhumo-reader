<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import ReasoningStream from './ReasoningStream.vue'
import { bookState, applyDocumentSource } from '../composables/useBook'
import { isMockApi, savePreviewSource } from '../dev/api-mock'
import { documentSession } from '../composables/documentSession'
import { settings, uiState } from '../composables/useSettings'
import {
  captureReadingSelection,
  locateReadingSelection,
  type ReadingSelection
} from '../composables/readingSelection'
import type { ReadingInsertion } from '../parser/reading-source'
import { createSelectionNote, rawSelectionOffset } from '../composables/selectionNote'
import { saveCurrentDocument } from '../composables/useEditor'
import {
  selectionExplanation,
  explainSelection,
  cancelSelectionExplanation,
  selectionExplanationEvent
} from '../composables/selectionExplanation'
const selected = shallowRef<ReadingSelection | null>(null),
  card = ref<HTMLElement>(),
  input = ref<HTMLTextAreaElement>()
const text = ref(''),
  error = ref(''),
  saving = ref(false),
  saved = ref(false),
  displayOutput = ref(''),
  composing = ref(false)
const style = ref({ left: '16px', top: '16px' })
const canWriteNote = computed(() => settings.selectionNote && bookState.payload?.format !== 'epub')
const shown = computed(() => selected.value && (canWriteNote.value || settings.selectionExplain))
const md = new MarkdownIt({ html: false, linkify: false }).disable('image')
const explanationHtml = computed(() => md.render(displayOutput.value))
const drafts = new Map<string, string>()
let dragging = false,
  selectionGesture = false,
  keyboardSelecting = false,
  dismissed = false,
  snapshot = '',
  snapshotPath = '',
  pendingSource = '',
  draftKey = '',
  revision = 0
let timer: ReturnType<typeof setTimeout> | undefined,
  outputTimer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined
let location: Promise<ReadingInsertion> | undefined,
  unsubscribe: (() => void) | undefined,
  observer: ResizeObserver | undefined
let dismissedRange: Range | undefined
let passageRange: Range | undefined
function remember(): void {
  if (draftKey && text.value.trim()) drafts.set(draftKey, text.value)
  while (drafts.size > 24) drafts.delete(drafts.keys().next().value!)
}
function clear(): void {
  if (saving.value) return
  remember()
  clearTimeout(timer)
  revision++
  controller?.abort()
  controller = undefined
  location = undefined
  cancelSelectionExplanation()
  CSS.highlights?.delete('zhumo-selected-passage')
  passageRange = undefined
  selected.value = null
  text.value = ''
  error.value = ''
  saved.value = false
  pendingSource = ''
  displayOutput.value = ''
  composing.value = false
  clearTimeout(outputTimer)
  outputTimer = undefined
}
function place(): void {
  if (!selected.value || !card.value) return
  const rect = selected.value.rect,
    w = card.value.offsetWidth,
    h = card.value.offsetHeight
  const top = rect.bottom + h + 16 < innerHeight ? rect.bottom + 10 : rect.top - h - 10
  style.value = {
    left: Math.max(12, Math.min(innerWidth - w - 12, rect.left)) + 'px',
    top: Math.max(12, Math.min(innerHeight - h - 12, top)) + 'px'
  }
}
function dismiss(): void {
  dismissed = true
  const s = window.getSelection()
  dismissedRange = s?.rangeCount ? s.getRangeAt(0).cloneRange() : undefined
  clear()
}
async function capture(): Promise<void> {
  if (
    dragging ||
    saving.value ||
    documentSession.mode !== 'read' ||
    bookState.status !== 'reading' ||
    uiState.settingsOpen
  )
    return
  if (card.value?.contains(document.activeElement)) return
  if (!(canWriteNote.value || settings.selectionExplain || settings.selectionCopy)) {
    clear()
    return
  }
  const native = window.getSelection()
  if (dismissed && native?.rangeCount && dismissedRange) {
    const r = native.getRangeAt(0)
    if (
      r.startContainer === dismissedRange.startContainer &&
      r.startOffset === dismissedRange.startOffset &&
      r.endContainer === dismissedRange.endContainer &&
      r.endOffset === dismissedRange.endOffset
    )
      return
  }
  dismissed = false
  const value = captureReadingSelection(bookState.book?.notes ?? [])
  if (!value) {
    // A captured passage remains valid when virtualization collapses the native range.
    // An explicit click, new selection, Escape or document change owns dismissal.
    if (!selected.value) clear()
    return
  }
  if (
    selected.value?.quote === value.quote &&
    selected.value.owner === value.owner &&
    selected.value.address.inline === value.address.inline &&
    selected.value.address.end === value.address.end
  )
    return
  clear()
  const own = revision
  selected.value = value
  passageRange = native?.rangeCount ? native.getRangeAt(0).cloneRange() : undefined
  if (
    (canWriteNote.value || settings.selectionExplain) &&
    native?.rangeCount &&
    typeof Highlight !== 'undefined'
  )
    CSS.highlights.set('zhumo-selected-passage', new Highlight(native.getRangeAt(0).cloneRange()))
  snapshot = documentSession.source
  snapshotPath = documentSession.path
  draftKey = JSON.stringify([snapshotPath, value.address, value.quote])
  text.value = drafts.get(draftKey) ?? ''
  if (settings.selectionCopy) {
    try {
      await navigator.clipboard.writeText(value.quote)
    } catch {
      bookState.statusMessage = '自动复制未完成，可使用 Ctrl+C。'
    }
  }
  if (own !== revision) return
  if (shown.value) {
    await nextTick()
    card.value?.showPopover()
    place()
    observer?.disconnect()
    if (card.value) observer?.observe(card.value)
    if (canWriteNote.value) input.value?.focus({ preventScroll: true })
  }
  if (!shown.value) return
  controller = new AbortController()
  location = locateReadingSelection(
    {
      source: snapshot,
      address: value.address,
      ...(settings.selectionExplain ? { startAddress: value.startAddress } : {}),
      levelCap: settings.noteLevelCap
    },
    controller.signal
  )
  try {
    const result = await location
    if (own !== revision || selected.value !== value) return
    if (settings.selectionExplain) {
      if (result.start === undefined) throw Error('这处选区的起点暂时无法精确定位。')
      void explainSelection(
        snapshot,
        rawSelectionOffset(snapshot, result.start),
        rawSelectionOffset(snapshot, result.position),
        value.quote
      )
    }
  } catch (cause) {
    if (own === revision) {
      error.value = cause instanceof Error ? cause.message : '暂时无法定位选区。'
      place()
    }
  }
}
function schedule(delay = 240): void {
  clearTimeout(timer)
  timer = setTimeout(() => void capture(), delay)
}
function down(event: PointerEvent): void {
  if (event.target instanceof Element && event.target.closest('.reading-selection')) return
  selectionGesture =
    event.target instanceof Element &&
    Boolean(event.target.closest('.section-body,.zmu-note-body')) &&
    !event.target.closest('.zmu-ref,button,input,textarea')
  dragging = selectionGesture
  keyboardSelecting = false
  dismissed = false
  clear()
}
function up(): void {
  dragging = false
  if (!selectionGesture) return
  selectionGesture = false
  void capture()
}
function cancelledPointer(): void {
  dragging = false
  selectionGesture = false
  clear()
}
async function save(): Promise<void> {
  if (!selected.value || !text.value.trim() || saving.value || documentSession.saving) return
  saving.value = true
  error.value = ''
  try {
    if (!pendingSource) {
      const located = await location
      if (
        !located ||
        snapshot !== documentSession.source ||
        snapshotPath !== documentSession.path ||
        documentSession.mode !== 'read'
      )
        throw Error('文稿或选区已变化，请重新选中后保存。')
      pendingSource = createSelectionNote(
        snapshot,
        located.position,
        selected.value.quote,
        text.value
      ).source
      documentSession.source = pendingSource
    } else if (documentSession.source !== pendingSource)
      throw Error('文稿已另有修改，当前注释文字仍在，请先保存文稿。')
    if (isMockApi) {
      savePreviewSource(snapshotPath, documentSession.savedSource, pendingSource)
      documentSession.savedSource = pendingSource
      await applyDocumentSource(pendingSource)
      bookState.statusMessage = '网页暂存'
    } else if (!(await saveCurrentDocument()))
      throw Error(documentSession.error || '尚未保存，注释文字已保留。')
    snapshot = documentSession.source
    snapshotPath = documentSession.path
    pendingSource = ''
    saved.value = true
    drafts.delete(draftKey)
    text.value = ''
    if (!settings.selectionExplain) {
      saving.value = false
      dismiss()
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存未完成，文字已保留。'
  } finally {
    saving.value = false
    void nextTick(place)
  }
}
function inputKey(event: KeyboardEvent): void {
  event.stopPropagation()
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing.value &&
    event.keyCode !== 229
  ) {
    event.preventDefault()
    void save()
  }
}
function key(event: KeyboardEvent): void {
  if (event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'))
    keyboardSelecting = true
  if (event.key === 'Escape' && shown.value && !saving.value) {
    event.preventDefault()
    event.stopPropagation()
    dismiss()
  }
}
function scroll(event: Event): void {
  if (event.target instanceof Node && card.value?.contains(event.target)) return
  if (selected.value && passageRange?.startContainer.isConnected) {
    const rect = passageRange.getBoundingClientRect()
    if (rect.width && rect.height) selected.value.rect = rect
  }
  place()
}
watch(
  () => [documentSession.path, documentSession.source, documentSession.mode, bookState.status],
  () => {
    if (!saving.value) clear()
  }
)
watch(
  () => [canWriteNote.value, settings.selectionExplain, settings.selectionCopy],
  () => {
    dismiss()
  }
)
watch(text, (value) => {
  if (value.trim()) saved.value = false
})
watch(
  () => [selectionExplanation.output, selectionExplanation.status],
  () => {
    if (selectionExplanation.status === 'running' && outputTimer) return
    clearTimeout(outputTimer)
    outputTimer = setTimeout(
      () => {
        outputTimer = undefined
        displayOutput.value = selectionExplanation.output
        void nextTick(place)
      },
      selectionExplanation.status === 'running' ? 100 : 0
    )
  }
)
onMounted(() => {
  observer = new ResizeObserver(place)
  unsubscribe = window.ai?.onEvent(selectionExplanationEvent)
  document.addEventListener('selectionchange', changed)
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('pointercancel', cancelledPointer, true)
  window.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', place)
  window.addEventListener('keydown', key, true)
})
function changed(): void {
  schedule(keyboardSelecting ? 240 : 0)
}
onBeforeUnmount(() => {
  clear()
  observer?.disconnect()
  unsubscribe?.()
  clearTimeout(timer)
  clearTimeout(outputTimer)
  document.removeEventListener('selectionchange', changed)
  document.removeEventListener('pointerdown', down, true)
  document.removeEventListener('pointerup', up, true)
  document.removeEventListener('pointercancel', cancelledPointer, true)
  window.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', place)
  window.removeEventListener('keydown', key, true)
})
</script>
<template>
  <Teleport to="body">
    <aside
      v-if="shown"
      ref="card"
      class="reading-selection selection-workflow"
      popover="manual"
      :style="style"
      aria-label="选段注释与解释"
    >
      <button class="selection-dismiss" aria-label="收起选段操作" @click="dismiss">×</button>
      <section v-if="canWriteNote" class="quick-note-section">
        <label for="quick-user-note">用户注释</label>
        <textarea
          id="quick-user-note"
          ref="input"
          v-model="text"
          rows="3"
          aria-label="用户注释"
          placeholder="写下你的想法…"
          :disabled="saving"
          @keydown="inputKey"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        />
        <small>{{
          saving ? '正在保存…' : saved ? '已保存' : 'Enter 保存 · Shift+Enter 换行'
        }}</small>
      </section>
      <section v-if="settings.selectionExplain" class="automatic-explanation" aria-label="自动解释">
        <span class="selection-section-label">解释</span>
        <ReasoningStream
          :key="selectionExplanation.id"
          :text="selectionExplanation.reasoning"
          :running="selectionExplanation.status === 'running'"
        />
        <div v-if="displayOutput" class="auto-explanation-content" v-html="explanationHtml" />
        <p v-else-if="selectionExplanation.status === 'running'" class="selection-waiting">
          正在理解这段文字…
        </p>
        <p v-if="selectionExplanation.error" class="selection-error" role="status">
          {{ selectionExplanation.error }}
        </p>
      </section>
      <p v-if="error" class="selection-error" role="alert">{{ error }}</p>
    </aside>
  </Teleport>
</template>
<style src="../styles/reading-selection.css"></style>
<style src="../styles/selection-workflow.css"></style>
