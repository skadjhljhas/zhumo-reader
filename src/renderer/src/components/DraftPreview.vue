<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { ParsedBook } from '../../../shared/types'
import { findBookHash } from '../composables/bookResources'
import { findEquation } from '../composables/formulaLocation'
import {
  SourcePositionIndex,
  visibleSourcePlace,
  type SourcePlace
} from '../composables/sourcePosition'

const props = defineProps<{ book: ParsedBook | null; busy: boolean }>()
const emit = defineEmits<{
  'edit-note': [label: string]
  position: [place: SourcePlace]
  interact: []
}>()
const scrollEl = ref<HTMLElement | null>(null)
const sourceIndex = computed(() => new SourcePositionIndex(props.book?.sourceBlocks))
let userDriving = false,
  positionFrame = 0
function getSourcePlace(): SourcePlace | undefined {
  return scrollEl.value ? visibleSourcePlace(scrollEl.value, sourceIndex.value) : undefined
}
function scrollPosition(): void {
  if (!userDriving || props.busy) return
  cancelAnimationFrame(positionFrame)
  positionFrame = requestAnimationFrame(() => {
    if (!userDriving || props.busy) return
    const place = getSourcePlace()
    if (place) emit('position', place)
  })
}
function userPosition(): void {
  emit('interact')
  navigation++
  userDriving = true
  scrollPosition()
}
const rows = computed(() => [
  ...(props.book?.sections.map((section) => ({
    id: section.id,
    html: section.html,
    mark: '',
    label: '',
    note: false
  })) ?? []),
  ...(props.book?.notes.map((note) => ({
    id: note.id,
    html: note.html,
    mark: note.displayMark,
    label: note.label,
    note: true
  })) ?? [])
])
const virtualized = computed(
  () => rows.value.length > 60 || (props.book?.stats.chars ?? 0) > 100000
)
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: rows.value.length,
    enabled: virtualized.value,
    getScrollElement: () => scrollEl.value,
    getItemKey: (index: number) => rows.value[index].id,
    estimateSize: (index: number) => (rows.value[index].note ? 160 : 1800),
    overscan: 2,
    paddingStart: 20,
    paddingEnd: 100
  }))
)
const visibleRows = computed(() =>
  virtualized.value
    ? virtualizer.value
        .getVirtualItems()
        .map((item) => ({ index: item.index, start: item.start, row: rows.value[item.index] }))
    : rows.value.map((row, index) => ({ index, start: 0, row }))
)
function measure(node: unknown): void {
  if (virtualized.value && node instanceof HTMLElement) virtualizer.value.measureElement(node)
}
let navigation = 0
async function locateRow(id: string, selector?: string, place?: SourcePlace): Promise<void> {
  const index = rows.value.findIndex((row) => row.id === id)
  if (index < 0) return
  const token = ++navigation
  for (let round = 0; round < 8 && token === navigation; round++) {
    let row = scrollEl.value?.querySelector(`[data-preview-id="${CSS.escape(id)}"]`)
    if (!row && virtualized.value && scrollEl.value) {
      // This loop owns refinement and cancellation; a second library seek would outlive it.
      const offset = virtualizer.value.getOffsetForIndex(index, 'start')?.[0]
      if (offset !== undefined) scrollEl.value.scrollTop = offset
    }
    await nextTick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (token !== navigation) return
    row = scrollEl.value?.querySelector(`[data-preview-id="${CSS.escape(id)}"]`)
    const target = selector ? row?.querySelector(selector) : row
    const root = scrollEl.value
    if (!target || !root) continue
    const rect = target.getBoundingClientRect()
    const delta =
      rect.top +
      (place ? rect.height * place.ratio : 0) -
      root.getBoundingClientRect().top -
      (place ? root.clientHeight * place.viewport : 24)
    if (round > 0 && Math.abs(delta) < 1) break
    root.scrollTop += delta
  }
}
async function locateSource(place: SourcePlace): Promise<void> {
  userDriving = false
  cancelAnimationFrame(positionFrame)
  await locateRow(
    place.block.id,
    place.block.key === 'row'
      ? undefined
      : '[data-source-block="' + CSS.escape(place.block.key) + '"]',
    place
  )
}
defineExpose({ locateSource, getSourcePlace })
async function locateHash(hash: string): Promise<void> {
  if (!props.book) return
  userDriving = true
  emit('interact')
  const equation = findEquation(props.book, hash)
  const heading = equation ? undefined : findBookHash(props.book, hash)
  const id = equation?.id ?? heading?.sectionId
  if (!id) return
  let decoded = hash.slice(1)
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    /* Keep literal malformed percent marks. */
  }
  await locateRow(
    id,
    equation ? `[id="${CSS.escape(decoded)}"]` : `[data-heading-hash="${CSS.escape(decoded)}"]`
  )
  scrollPosition()
}
function fragmentRequested(event: Event): void {
  const hash = (event as CustomEvent<unknown>).detail
  if (typeof hash === 'string' && hash.startsWith('#')) void locateHash(hash)
}
onMounted(() => window.addEventListener('zhumo:preview-fragment', fragmentRequested))
onBeforeUnmount(() => {
  navigation++
  cancelAnimationFrame(positionFrame)
  window.removeEventListener('zhumo:preview-fragment', fragmentRequested)
})
async function locate(event: MouseEvent | KeyboardEvent): Promise<void> {
  const target = event.target
  if (!(target instanceof Element)) return
  if (event instanceof KeyboardEvent) {
    const scrollKey =
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) ||
      (event.key === ' ' && !target.closest('a,.zmu-ref,.zmu-math'))
    if (scrollKey && !event.defaultPrevented) userPosition()
    if (!['Enter', ' '].includes(event.key)) return
  }
  const anchor = target.closest('a')
  const hash = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href')
  if (hash?.startsWith('#') && props.book) {
    event.preventDefault()
    userDriving = true
    await locateHash(hash)
    return
  }
  const note = target.closest<HTMLElement>('.zmu-ref')?.dataset.noteId
  if (!note) return
  event.preventDefault()
  userDriving = true
  emit('interact')
  await locateRow(note)
  scrollPosition()
}
watch(
  () => props.book,
  async () => {
    navigation++
    await nextTick()
    if (
      virtualized.value &&
      scrollEl.value &&
      scrollEl.value.scrollTop > scrollEl.value.scrollHeight
    )
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  }
)
</script>
<template>
  <section class="draft-preview" aria-label="编辑排版预览">
    <div class="preview-label">
      排版预览 <span>{{ busy ? '排版中…' : '与源文同步' }}</span>
    </div>
    <div
      ref="scrollEl"
      class="preview-scroll"
      tabindex="0"
      @click="locate"
      @keydown="locate"
      @scroll.passive="scrollPosition"
      @wheel="userPosition"
      @pointerdown="userPosition"
    >
      <div
        class="preview-reading"
        :class="{ 'is-virtual': virtualized }"
        :style="virtualized ? { height: `${virtualizer.getTotalSize()}px` } : undefined"
      >
        <div
          v-for="item in visibleRows"
          :key="item.row.id"
          :ref="measure"
          :data-index="item.index"
          :data-preview-id="item.row.id"
          class="preview-row"
          :style="
            virtualized
              ? {
                  position: 'absolute',
                  top: 0,
                  left: '36px',
                  right: '36px',
                  transform: `translateY(${item.start}px)`
                }
              : undefined
          "
        >
          <article v-if="item.row.note" class="preview-note" :data-preview-note="item.row.id">
            <div class="preview-note-heading">
              <strong>{{ item.row.mark }}</strong>
              <button
                :aria-label="'修改注释 ' + item.row.label"
                @click.stop="emit('edit-note', item.row.label)"
              >
                修改注释
              </button>
            </div>
            <div class="zmu-note-body" v-html="item.row.html" />
          </article>
          <div v-else class="section-body" v-html="item.row.html" />
        </div>
      </div>
    </div>
  </section>
</template>
