<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import NoteCard from './NoteCard.vue'
import StudioIcon from './StudioIcon.vue'
import { bookState } from '../composables/useBook'
import { studio, openNoteAtlas, togglePin } from '../composables/useStudio'
import { settings, uiState } from '../composables/useSettings'
import { requestSidebarLocate } from '../composables/readerStore'
import { searchBlocks, searchableText } from '../composables/searchText'
import {
  notePeekRequest,
  openNotePeek,
  closeNotePeek,
  placeNotePeek,
  type NotePeekRequest
} from '../composables/notePeek'

const sheet = ref<HTMLElement>(),
  reading = ref<HTMLElement>(),
  trail = ref<HTMLElement>()
const origin = shallowRef<HTMLElement>()
const expanded = ref(false),
  engaged = ref(false),
  sourceText = ref(''),
  connection = ref('')
const style = ref({ left: '16px', top: '16px' })
const sourcePoint = ref({ x: 0, y: 0 })
const byId = computed(() => new Map((bookState.book?.notes ?? []).map((note) => [note.id, note])))
const byLabel = computed(
  () => new Map((bookState.book?.notes ?? []).map((note) => [note.label, note]))
)
interface Visit {
  label: string
  place?: { block: number; offset: number; height: number }
}
const history = ref<Visit[]>([]),
  position = ref(0)
const current = computed(() => byLabel.value.get(history.value[position.value]?.label ?? ''))
let openTimer: ReturnType<typeof setTimeout> | undefined,
  closeTimer: ReturnType<typeof setTimeout> | undefined
let geometryFrame = 0,
  restoreToken = 0,
  alive = false,
  observer: ResizeObserver | undefined
function clearOpen(): void {
  clearTimeout(openTimer)
  openTimer = undefined
}
function clearDismiss(): void {
  clearTimeout(closeTimer)
  closeTimer = undefined
}
function engageReading(): void {
  engaged.value = true
  restoreToken++
  clearDismiss()
}
function dismissSoon(): void {
  clearDismiss()
  if (!engaged.value)
    closeTimer = setTimeout(() => {
      if (!engaged.value) closeNotePeek()
    }, 340)
}
function sourceAnchor(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.reader-scroll .zmu-ref') : null
}
function over(event: PointerEvent): void {
  const anchor = sourceAnchor(event.target)
  if (
    !anchor ||
    !studio.hoverNotes ||
    (notePeekRequest.value && engaged.value) ||
    event.pointerType !== 'mouse' ||
    document.querySelector('dialog[open]') ||
    uiState.settingsOpen
  )
    return
  if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
  clearOpen()
  clearDismiss()
  if (notePeekRequest.value?.origin === anchor) return
  openTimer = setTimeout(() => {
    if (
      anchor.isConnected &&
      anchor.dataset.noteId &&
      !document.querySelector('dialog[open]') &&
      !window.getSelection()?.toString()
    )
      openNotePeek(anchor.dataset.noteId, anchor)
  }, 430)
}
function out(event: PointerEvent): void {
  const anchor = sourceAnchor(event.target)
  if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)))
    return
  clearOpen()
  if (event.relatedTarget instanceof Node && sheet.value?.contains(event.relatedTarget)) return
  if (anchor === origin.value) dismissSoon()
}
function down(event: PointerEvent): void {
  clearOpen()
  if (!notePeekRequest.value) return
  if (event.target instanceof Element && event.target.closest('.reading-selection')) {
    engaged.value = true
    clearDismiss()
    return
  }
  if (event.target instanceof Node && sheet.value?.contains(event.target)) {
    engaged.value = true
    clearDismiss()
  } else if (!document.querySelector('dialog[open]')) closeNotePeek()
}
function reposition(): void {
  geometryFrame = 0
  const root = sheet.value,
    anchor = origin.value
  if (!root?.matches(':popover-open') || !anchor) return
  const mark = anchor.querySelector('.zmu-ref-mark') ?? anchor
  const rect = mark.getBoundingClientRect()
  sourcePoint.value = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  const boundary = anchor.closest('.reader-scroll')?.getBoundingClientRect()
  const visible =
    anchor.isConnected && boundary && rect.bottom > boundary.top && rect.top < boundary.bottom
  if (!visible && !engaged.value) {
    closeNotePeek()
    return
  }
  const placed = placeNotePeek(
    rect,
    { width: root.offsetWidth, height: root.offsetHeight },
    { width: innerWidth, height: innerHeight },
    expanded.value || !visible
  )
  style.value = { left: `${Math.round(placed.left)}px`, top: `${Math.round(placed.top)}px` }
  connection.value = visible ? placed.connection : ''
}
function schedulePosition(event?: Event): void {
  if (event?.target instanceof Element && event.target.closest('.note-peek, .reading-selection'))
    return
  if (notePeekRequest.value && !geometryFrame) geometryFrame = requestAnimationFrame(reposition)
}
async function show(request: NotePeekRequest): Promise<void> {
  if (!studio.hoverNotes) {
    closeNotePeek()
    return
  }
  const note = byId.value.get(request.noteId)
  if (!note || !request.origin.isConnected) {
    closeNotePeek()
    return
  }
  clearOpen()
  clearDismiss()
  restoreToken++
  origin.value?.classList.remove('is-peek-origin')
  origin.value = request.origin
  expanded.value = engaged.value = request.expand
  history.value = [{ label: note.label }]
  position.value = 0
  const paragraph = request.origin.closest('p,li,h1,h2,h3,blockquote')?.cloneNode(true) as
    Element | undefined
  paragraph?.querySelectorAll('.zmu-ref').forEach((ref) => ref.remove())
  const text = paragraph ? searchableText(paragraph).replace(/\s+/g, ' ').trim() : ''
  sourceText.value = text.length > 500 ? text.slice(0, 500) + '…' : text
  await nextTick()
  if (!alive || notePeekRequest.value !== request || !sheet.value) return
  if (!sheet.value.matches(':popover-open')) sheet.value.showPopover()
  if (reading.value) reading.value.scrollTop = 0
  request.origin.classList.add('is-peek-origin')
  reposition()
  if (request.expand) reading.value?.focus({ preventScroll: true })
}
function hide(): void {
  clearOpen()
  clearDismiss()
  restoreToken++
  const activeInside = sheet.value?.contains(document.activeElement)
  origin.value?.classList.remove('is-peek-origin')
  if (sheet.value?.matches(':popover-open')) sheet.value.hidePopover()
  if (activeInside && origin.value?.isConnected) origin.value.focus({ preventScroll: true })
  history.value = []
  origin.value = undefined
  connection.value = ''
  sourceText.value = ''
}
function remember(): void {
  const root = reading.value,
    visit = history.value[position.value]
  if (!root || !visit) return
  const boundary = root.getBoundingClientRect().top
  const blocks = searchBlocks(root.querySelector('.zmu-note-body') ?? root)
  const block = blocks.findIndex((el) => el.getBoundingClientRect().bottom > boundary + 12)
  if (block < 0) return
  const rect = blocks[block].getBoundingClientRect()
  visit.place = { block, offset: rect.top - boundary, height: rect.height }
}
async function reveal(): Promise<void> {
  const token = ++restoreToken
  await nextTick()
  await document.fonts.ready
  const root = reading.value,
    place = history.value[position.value]?.place
  if (!root || token !== restoreToken || !notePeekRequest.value) return
  const target = place && searchBlocks(root.querySelector('.zmu-note-body') ?? root)[place.block]
  if (target && place) {
    const rect = target.getBoundingClientRect()
    const offset =
      place.offset < 0 && place.height > 0
        ? (place.offset * rect.height) / place.height
        : place.offset
    root.scrollTop += rect.top - root.getBoundingClientRect().top - offset
  } else root.scrollTop = 0
  reposition()
  root.focus({ preventScroll: true })
  trail.value
    ?.querySelector('[aria-current="step"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
function choose(id: string): void {
  const note = byId.value.get(id)
  if (!note || current.value?.id === id) return
  engaged.value = true
  clearDismiss()
  remember()
  history.value = [...history.value.slice(0, position.value + 1), { label: note.label }].slice(-40)
  position.value = history.value.length - 1
  void reveal()
}
function visit(index: number): void {
  if (index < 0 || index >= history.value.length || index === position.value) return
  engaged.value = true
  clearDismiss()
  remember()
  position.value = index
  void reveal()
}
async function toggleExpanded(): Promise<void> {
  engaged.value = true
  remember()
  expanded.value = !expanded.value
  await reveal()
}
function key(event: KeyboardEvent): void {
  if (!notePeekRequest.value || event.defaultPrevented || document.querySelector('dialog[open]'))
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeNotePeek()
    return
  }
  if (!(event.target instanceof Node) || !sheet.value?.contains(event.target)) return
  if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault()
    visit(position.value + (event.key === 'ArrowLeft' ? -1 : 1))
  } else if (
    ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
  ) {
    engaged.value = true
    restoreToken++
  }
}
async function readInSidebar(): Promise<void> {
  const id = current.value?.id
  if (!id) return
  closeNotePeek()
  settings.sidebarVisible = true
  studio.focusMode = false
  await nextTick()
  requestSidebarLocate(id)
}
function atlas(): void {
  const id = current.value?.id
  if (!id) return
  closeNotePeek()
  openNoteAtlas(id)
}
function contentLink(event: MouseEvent): void {
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('a[href]')?.getAttribute('href')?.startsWith('#') &&
    !target.closest('.zmu-math')
  )
    closeNotePeek()
}
watch(
  notePeekRequest,
  (request) => {
    if (request) void show(request)
    else hide()
  },
  { flush: 'post' }
)
watch(() => bookState.book, closeNotePeek)
watch(
  () => [
    studio.atlasOpen,
    studio.galleryOpen,
    studio.searchOpen,
    studio.promptOpen,
    uiState.settingsOpen
  ],
  (values) => {
    if (values.some(Boolean)) closeNotePeek()
  }
)
watch(
  () => studio.hoverNotes,
  (enabled) => {
    clearOpen()
    if (!enabled) closeNotePeek()
  }
)
onMounted(() => {
  alive = true
  observer = new ResizeObserver(() => schedulePosition())
  if (sheet.value) observer.observe(sheet.value)
  document.addEventListener('pointerover', over)
  document.addEventListener('pointerout', out)
  document.addEventListener('pointerdown', down, true)
  document.addEventListener('scroll', schedulePosition, true)
  window.addEventListener('resize', schedulePosition)
  window.addEventListener('keydown', key)
  if (notePeekRequest.value) void show(notePeekRequest.value)
})
onBeforeUnmount(() => {
  alive = false
  hide()
  closeNotePeek()
  observer?.disconnect()
  cancelAnimationFrame(geometryFrame)
  document.removeEventListener('pointerover', over)
  document.removeEventListener('pointerout', out)
  document.removeEventListener('pointerdown', down, true)
  document.removeEventListener('scroll', schedulePosition, true)
  window.removeEventListener('resize', schedulePosition)
  window.removeEventListener('keydown', key)
})
</script>

<template>
  <section
    ref="sheet"
    popover="manual"
    role="dialog"
    aria-labelledby="peek-title"
    class="note-peek"
    :class="{ 'is-expanded': expanded, 'is-transparent': studio.peekTransparency > 0 }"
    :style="style"
    @pointerenter="clearDismiss"
    @pointerleave="dismissSoon"
    @focusin="engaged = true"
  >
    <svg v-if="connection" class="peek-tether" aria-hidden="true">
      <path :d="connection" />
      <circle v-if="origin" :cx="sourcePoint.x" :cy="sourcePoint.y" r="3" />
    </svg>
    <div
      v-if="current"
      class="peek-shell"
      :data-depth="Math.min(2, position)"
      :data-note-level="current.level"
    >
      <header class="peek-head">
        <div>
          <span class="peek-eyebrow">就地注页 · 第 {{ current.level }} 层</span>
          <h2 id="peek-title">
            <span v-if="current.typeLabel">{{ current.typeLabel }}</span
            >{{ current.displayMark }}
          </h2>
        </div>
        <div class="peek-actions">
          <button
            class="studio-icon-button"
            :aria-label="
              studio.pinnedLabels.has(current.label)
                ? `取消固定注释 ${current.displayMark}`
                : `固定注释 ${current.displayMark}`
            "
            :aria-pressed="studio.pinnedLabels.has(current.label)"
            title="固定，稍后再读"
            @click="togglePin(current.label)"
          >
            <StudioIcon name="pin" :size="15" /></button
          ><button
            class="studio-icon-button"
            :aria-label="expanded ? '收回悬浮注页' : '展开为注页'"
            :aria-pressed="expanded"
            title="改变注页大小"
            @click="toggleExpanded"
          >
            <StudioIcon name="focus" :size="17" /></button
          ><button
            class="studio-icon-button"
            aria-label="关闭就地注页"
            title="关闭 · Esc"
            @click="closeNotePeek"
          >
            <StudioIcon name="close" :size="17" />
          </button>
        </div>
      </header>
      <nav v-if="history.length > 1" class="peek-trail" aria-label="就地注页阅读路径">
        <button
          class="studio-icon-button"
          aria-label="注页返回"
          :disabled="position === 0"
          @click="visit(position - 1)"
        >
          <StudioIcon name="back" :size="14" />
        </button>
        <ol ref="trail">
          <li v-for="(step, i) in history" :key="i">
            <button
              :aria-current="i === position ? 'step' : undefined"
              :title="step.label"
              @click="visit(i)"
            >
              {{ byLabel.get(step.label)?.displayMark ?? step.label }}
            </button>
          </li>
        </ol>
        <button
          class="studio-icon-button"
          aria-label="注页前进"
          :disabled="position + 1 === history.length"
          @click="visit(position + 1)"
        >
          <StudioIcon name="arrow" :size="14" />
        </button>
      </nav>
      <div v-if="sourceText" class="peek-source">
        <span>来处</span>
        <p>{{ sourceText }}</p>
      </div>
      <div
        ref="reading"
        class="peek-reading"
        tabindex="0"
        aria-label="就地注释全文"
        @wheel="engageReading"
        @pointerdown="restoreToken++"
        @click="contentLink"
      >
        <NoteCard
          :key="current.id"
          :note="current"
          :active="false"
          :focused="false"
          :cycle="!!current.cycle"
          in-atlas
          @navigate="choose($event)"
        />
      </div>
      <footer class="peek-footer">
        <button class="peek-map-link" @click="atlas">
          <StudioIcon name="branches" :size="15" />查看脉络</button
        ><button class="studio-primary" @click="readInSidebar">
          在旁注中阅读<StudioIcon name="arrow" :size="15" />
        </button>
      </footer>
      <div v-if="expanded" class="peek-colophon">
        <span>原句仍在，思路继续。</span
        ><span>{{ position + 1 }} / {{ history.length }} · {{ current.refCount }} 处引用</span>
      </div>
    </div>
  </section>
</template>

<style src="../styles/note-peek.css"></style>
