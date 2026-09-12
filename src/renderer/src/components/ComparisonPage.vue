<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  comparisonFragment,
  COMPARISON_WINDOW,
  type ComparisonPassage,
  type ComparisonFragment
} from '../composables/readingComparison'
import { searchMatchRanges } from '../composables/searchLanding'
import { openNoteAtlas } from '../composables/useStudio'
import { bookFileUrl, bookPathFromUrl } from '../composables/bookResources'
import { bookState } from '../composables/useBook'
import StudioIcon from './StudioIcon.vue'

const props = defineProps<{ page: ComparisonPassage; side: 'left' | 'right' }>()
const emit = defineEmits<{
  read: [page: ComparisonPassage]
  hash: [hash: string]
  leave: []
  geometry: [point: { x: number; y: number } | null]
}>()
const scroll = ref<HTMLElement>(),
  prose = ref<HTMLElement>()
const fragment = shallowRef<ComparisonFragment>(),
  error = ref(''),
  copied = ref(false)
const sideName = computed(() => (props.side === 'left' ? '左页' : '右页'))
const highlightName = computed(() => 'zhumo-comparison-' + props.side)
const matchedText = computed(() =>
  props.page.entry.text.slice(props.page.hit.start, props.page.hit.end)
)
let geometryFrame = 0,
  observer: ResizeObserver | undefined,
  copyTimer: ReturnType<typeof setTimeout> | undefined
let rect: (() => DOMRect | undefined) | undefined,
  alive = true
function geometry(): void {
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    const mark = rect?.(),
      boundary = scroll.value?.getBoundingClientRect()
    if (!mark || !boundary || mark.bottom <= boundary.top || mark.top >= boundary.bottom) {
      emit('geometry', null)
      return
    }
    emit('geometry', {
      x: props.side === 'left' ? boundary.right : boundary.left,
      y: Math.max(boundary.top + 8, Math.min(boundary.bottom - 8, mark.top + mark.height / 2))
    })
  })
}
async function show(center = props.page.hit.start, returnToMark = true): Promise<void> {
  CSS.highlights?.delete(highlightName.value)
  rect = undefined
  error.value = ''
  try {
    fragment.value = comparisonFragment(props.page, center)
  } catch (cause) {
    fragment.value = undefined
    error.value = cause instanceof Error ? cause.message : '暂时无法展开此页。'
  }
  await nextTick()
  if (!alive) return
  const target = prose.value?.querySelector('[data-comparison-target]')
  const match = target && fragment.value?.match && searchMatchRanges(target, fragment.value.match)
  if (match) {
    rect = match.rect
    match.atoms.forEach((node) => node.classList.add('comparison-atomic-match'))
    if (match.ranges.length && typeof Highlight !== 'undefined' && CSS.highlights)
      CSS.highlights.set(highlightName.value, new Highlight(...match.ranges))
  }
  if (scroll.value) {
    scroll.value.scrollTop = 0
    const position = returnToMark && rect?.()
    if (position)
      scroll.value.scrollTop += position.top - scroll.value.getBoundingClientRect().top - 100
  }
  observer?.disconnect()
  if (prose.value) observer?.observe(prose.value)
  geometry()
}
function moveFragment(direction: number): void {
  const current = fragment.value
  if (!current) return
  const center =
    direction > 0 ? current.to + 1000 : Math.max(0, current.from - COMPARISON_WINDOW + 400) + 1400
  void show(center, false)
}
function click(event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    !(event.target instanceof Element) ||
    window.getSelection()?.toString()
  )
    return
  const reference = event.target.closest<HTMLElement>('.zmu-ref')
  if (reference?.dataset.noteId) {
    event.preventDefault()
    reference.focus({ preventScroll: true })
    openNoteAtlas(reference.dataset.noteId)
    return
  }
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  const href = anchor?.getAttribute('href') ?? ''
  if (href.startsWith('#') && !anchor?.closest('.zmu-math')) {
    event.preventDefault()
    emit('hash', href)
    return
  }
  const base = bookState.payload && bookFileUrl(bookState.payload.path)
  if (base && href) {
    try {
      const path = bookPathFromUrl(new URL(href, base))
      if (path && /\.(md|markdown|txt)$/i.test(path)) emit('leave')
    } catch {
      /* Preserve the reader's ordinary link handling. */
    }
  }
}
function key(event: KeyboardEvent): void {
  if (!['Enter', ' '].includes(event.key) || !(event.target instanceof HTMLElement)) return
  const reference = event.target.closest<HTMLElement>('.zmu-ref')
  if (!reference?.dataset.noteId) return
  event.preventDefault()
  event.stopPropagation()
  openNoteAtlas(reference.dataset.noteId)
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.page.entry.text)
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    error.value = '复制暂时不可用，仍可选择文字复制。'
  }
}
watch(
  () => props.page,
  () => {
    void show()
  }
)
onMounted(() => {
  observer = new ResizeObserver(geometry)
  window.addEventListener('resize', geometry)
  void show()
})
onBeforeUnmount(() => {
  alive = false
  observer?.disconnect()
  cancelAnimationFrame(geometryFrame)
  clearTimeout(copyTimer)
  CSS.highlights?.delete(highlightName.value)
  window.removeEventListener('resize', geometry)
})
</script>

<template>
  <section class="comparison-page" :data-side="side" :aria-label="sideName + '原文'">
    <header class="comparison-page-heading">
      <div class="comparison-source">
        <span>{{ sideName }}</span
        ><span>{{ page.entry.kind === 'note' ? '旁注' : '正文' }}</span>
      </div>
      <h3>{{ page.entry.title }}</h3>
      <div class="comparison-word">
        <span>{{ matchedText }}</span
        ><button :aria-label="sideName + '回到标记'" @click="show()">回到标记</button>
      </div>
      <div class="comparison-location" :aria-label="sideName + '在文字序列中的位置'">
        <i :style="{ left: page.location * 100 + '%' }"></i>
      </div>
    </header>
    <div
      ref="scroll"
      class="comparison-reading"
      tabindex="0"
      :aria-label="sideName + '阅读区'"
      @scroll.passive="geometry"
      @click="click"
      @keydown="key"
    >
      <p v-if="page.before && !fragment?.from" class="comparison-neighbor">{{ page.before }}</p>
      <p v-if="fragment?.from" class="comparison-cut">前文仍在这一段中</p>
      <div
        v-if="fragment"
        ref="prose"
        class="comparison-prose"
        :class="page.entry.kind === 'note' ? 'zmu-note-body' : 'section-body'"
        v-html="fragment.html"
      ></div>
      <p v-if="fragment && fragment.to < fragment.total" class="comparison-cut">这一段尚未读完</p>
      <p v-if="page.after && fragment?.to === fragment?.total" class="comparison-neighbor">
        {{ page.after }}
      </p>
      <p v-if="error" class="comparison-error" role="alert">{{ error }}</p>
    </div>
    <nav
      v-if="fragment && (fragment.from || fragment.to < fragment.total)"
      class="comparison-fragments"
      :aria-label="sideName + '长段阅读'"
    >
      <button
        :disabled="!fragment.from"
        :aria-label="sideName + '往前读'"
        @click="moveFragment(-1)"
      >
        往前读
      </button>
      <span
        >{{ Math.floor((fragment.from / fragment.total) * 100) }}–{{
          Math.ceil((fragment.to / fragment.total) * 100)
        }}% · 本段</span
      >
      <button
        :disabled="fragment.to >= fragment.total"
        :aria-label="sideName + '往后读'"
        @click="moveFragment(1)"
      >
        往后读
      </button>
    </nav>
    <footer class="comparison-page-actions">
      <button :aria-label="'复制' + sideName + '完整段落'" @click="copy">
        <StudioIcon name="copy" :size="14" />{{ copied ? '已复制' : '复制此段' }}
      </button>
      <button
        class="studio-primary"
        :aria-label="'回到' + sideName + '原文'"
        @click="emit('read', page)"
      >
        回到原文<StudioIcon name="arrow" :size="14" />
      </button>
    </footer>
  </section>
</template>
