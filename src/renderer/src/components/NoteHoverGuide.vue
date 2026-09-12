<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, useId } from 'vue'
import { noteHoverGuide, clearNoteHoverGuide } from '../composables/noteHoverGuide'
import { bookState } from '../composables/useBook'
import { studio } from '../composables/useStudio'
import { settings, uiState } from '../composables/useSettings'
import { documentSession } from '../composables/documentSession'
import { closeNotePeek } from '../composables/notePeek'
import HdrThreads from './HdrThreads.vue'
const line = ref('')
const lightId = `note-guide-${useId()}`
const endpoints = ref({ ax: 0, ay: 0, bx: 1, by: 0 })
let frame = 0
function over(event: PointerEvent): void {
  if (
    studio.hoverNotes ||
    event.pointerType !== 'mouse' ||
    event.buttons ||
    documentSession.mode !== 'read' ||
    bookState.status !== 'reading' ||
    uiState.settingsOpen ||
    document.querySelector('dialog[open]') ||
    window.getSelection()?.toString()
  )
    return
  const origin =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('.reader-scroll .zmu-ref')
      : null
  if (
    !origin?.dataset.noteId ||
    !bookState.book?.notes.some((note) => note.id === origin.dataset.noteId)
  )
    return
  if (noteHoverGuide.value?.origin === origin) return
  closeNotePeek()
  settings.sidebarVisible = true
  studio.focusMode = false
  noteHoverGuide.value = { noteId: origin.dataset.noteId, origin }
}
function out(event: PointerEvent): void {
  const origin = noteHoverGuide.value?.origin
  if (
    origin &&
    event.target instanceof Node &&
    origin.contains(event.target) &&
    (!(event.relatedTarget instanceof Node) || !origin.contains(event.relatedTarget))
  )
    clearNoteHoverGuide()
}
function cancel(): void {
  clearNoteHoverGuide()
}
function draw(): void {
  frame = 0
  const guide = noteHoverGuide.value
  if (!guide) {
    line.value = ''
    return
  }
  const reader = guide.origin.closest('.reader-scroll'),
    sidebar = document.querySelector('.notes-scroll')
  if (!guide.origin.isConnected || !reader || !sidebar || studio.hoverNotes || document.hidden) {
    cancel()
    return
  }
  const source = (
    guide.origin.querySelector('.zmu-ref-mark') ?? guide.origin
  ).getBoundingClientRect()
  const bounds = reader.getBoundingClientRect(),
    clip = sidebar.getBoundingClientRect()
  const ay = source.top + source.height / 2
  if (!source.height || ay < bounds.top || ay > bounds.bottom) {
    cancel()
    return
  }
  const card = sidebar.querySelector(`.note-card[data-note-id="${CSS.escape(guide.noteId)}"]`)
  const mark = card?.querySelector('.note-mark')?.getBoundingClientRect()
  const by =
    mark && mark.bottom > clip.top && mark.top < clip.bottom
      ? mark.top + mark.height / 2
      : Math.max(clip.top + 16, Math.min(clip.bottom - 16, ay))
  const ax = source.right + 5,
    bx = mark && mark.bottom > clip.top && mark.top < clip.bottom ? mark.left - 4 : clip.left + 8
  const bend = Math.max(24, Math.abs(bx - ax) * 0.45)
  endpoints.value = { ax, ay, bx, by }
  line.value = `M${ax},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx},${by}`
  frame = requestAnimationFrame(draw)
}
watch(noteHoverGuide, () => {
  cancelAnimationFrame(frame)
  if (noteHoverGuide.value) frame = requestAnimationFrame(draw)
  else line.value = ''
})
watch(
  () => [
    bookState.book,
    bookState.status,
    documentSession.mode,
    documentSession.source,
    studio.hoverNotes,
    studio.galleryOpen,
    studio.atlasOpen,
    studio.panoramaOpen,
    studio.searchOpen,
    studio.promptOpen,
    uiState.settingsOpen
  ],
  cancel
)
watch(
  () => studio.hoverNotes,
  (enabled) => {
    document.documentElement.dataset.noteGuidance = enabled ? 'inline' : 'sidebar'
    if (!enabled && bookState.status === 'reading') {
      settings.sidebarVisible = true
      studio.focusMode = false
    }
  },
  { immediate: true }
)
onMounted(() => {
  document.addEventListener('pointerover', over)
  document.addEventListener('pointerout', out)
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('wheel', cancel, { passive: true, capture: true })
  document.addEventListener('keydown', cancel, true)
  window.addEventListener('blur', cancel)
  document.addEventListener('visibilitychange', cancel)
})
onBeforeUnmount(() => {
  delete document.documentElement.dataset.noteGuidance
  cancel()
  cancelAnimationFrame(frame)
  document.removeEventListener('pointerover', over)
  document.removeEventListener('pointerout', out)
  document.removeEventListener('pointerdown', cancel, true)
  document.removeEventListener('wheel', cancel, true)
  document.removeEventListener('keydown', cancel, true)
  window.removeEventListener('blur', cancel)
  document.removeEventListener('visibilitychange', cancel)
})
</script>
<template>
  <HdrThreads :paths="[line]" />
  <Transition name="note-guide-fade">
    <svg
      v-if="line && noteHoverGuide"
      class="note-hover-guide"
      :class="studio.themeId === 'chaosheng' ? 'tidal-tether' : 'thought-thread'"
      :data-note-id="noteHoverGuide.noteId"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          :id="lightId"
          gradientUnits="userSpaceOnUse"
          :x1="endpoints.ax"
          y1="0"
          :x2="endpoints.bx"
          y2="0"
        >
          <stop stop-color="#68e9e8" />
          <stop offset=".5" stop-color="#b0a5ff" />
          <stop offset="1" stop-color="#ecbb7d" />
        </linearGradient>
      </defs>
      <path v-if="studio.themeId === 'chaosheng'" class="note-guide-line" :d="line" />
      <template v-else>
        <path
          class="note-guide-glow thought-thread-glow"
          :style="{ stroke: `url(#${lightId})` }"
          :d="line"
        />
        <path
          class="note-guide-line thought-thread-line"
          :style="{ stroke: `url(#${lightId})` }"
          :d="line"
        />
      </template>
    </svg>
  </Transition>
</template>
<style>
.note-hover-guide:is(.thought-thread, .tidal-tether) {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 33;
  pointer-events: none;
  overflow: hidden;
}
.note-guide-fade-enter-active,
.note-guide-fade-leave-active {
  transition: opacity 0.3s ease;
}
.note-guide-fade-enter-from,
.note-guide-fade-leave-to {
  opacity: 0;
}
:root:not([data-optics='full']) .note-hover-guide path {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .note-hover-guide path {
    animation: none !important;
  }
}
.note-card.is-hover-guided {
  border-color: var(--accent);
}
</style>
