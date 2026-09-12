<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import ComparisonPage from './ComparisonPage.vue'
import StudioIcon from './StudioIcon.vue'
import { comparisonText, type ComparisonPassage } from '../composables/readingComparison'
import { settings } from '../composables/useSettings'

const props = defineProps<{ left: ComparisonPassage; right: ComparisonPassage }>()
const emit = defineEmits<{
  close: []
  read: [page: ComparisonPassage]
  hash: [hash: string]
  leave: []
}>()
const dialog = ref<HTMLDialogElement>(),
  gutter = ref<HTMLElement>()
const ready = ref(false),
  swapped = ref(false),
  copied = ref('')
const a = computed(() => (swapped.value ? props.right : props.left))
const b = computed(() => (swapped.value ? props.left : props.right))
const first = shallowRef<{ x: number; y: number } | null>(null),
  second = shallowRef<{ x: number; y: number } | null>(null)
const connection = ref('')
let frame = 0,
  origin: HTMLElement | null = null,
  timer: ReturnType<typeof setTimeout> | undefined
function connect(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const boundary = gutter.value?.getBoundingClientRect(),
      left = first.value,
      right = second.value
    if (!boundary || !left || !right) {
      connection.value = ''
      return
    }
    const ay = left.y - boundary.top,
      by = right.y - boundary.top
    const middle = boundary.width / 2
    connection.value =
      'M0 ' +
      ay +
      ' C' +
      middle +
      ' ' +
      ay +
      ' ' +
      middle +
      ' ' +
      by +
      ' ' +
      boundary.width +
      ' ' +
      by
  })
}
function geometry(side: 'left' | 'right', point: { x: number; y: number } | null): void {
  if (side === 'left') first.value = point
  else second.value = point
  connect()
}
function swap(): void {
  first.value = second.value = null
  connection.value = ''
  swapped.value = !swapped.value
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(comparisonText(a.value, b.value))
    copied.value = '已复制两段及出处'
  } catch {
    copied.value = '复制暂时不可用'
  }
  clearTimeout(timer)
  timer = setTimeout(() => {
    copied.value = ''
  }, 2400)
}
function close(): void {
  emit('close')
}
onMounted(async () => {
  origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  dialog.value?.showModal()
  ready.value = true
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('.comparison-reading')?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  clearTimeout(timer)
  const ownedFocus = !!dialog.value?.contains(document.activeElement)
  dialog.value?.close()
  if (ownedFocus && origin?.isConnected) origin.focus({ preventScroll: true })
})
</script>

<template>
  <dialog
    ref="dialog"
    class="comparison-dialog"
    aria-label="两处原文对读"
    :style="{ '--comparison-font-size': settings.fontSize + 'px' }"
    @cancel.prevent="close"
    @close="!dialog?.open && close()"
    @click="$event.target === dialog && close()"
  >
    <header class="comparison-heading">
      <div>
        <span class="eyebrow">WORDS / IN RELATION</span>
        <h2>两处原文，对照着读。</h2>
      </div>
      <p>让相同的字，保留不同的来处。</p>
      <button class="studio-icon-button" aria-label="回到检索" @click="close">
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="comparison-tools">
      <span>{{ left.book.title || '当前文稿' }}</span>
      <button @click="swap">交换左右</button>
      <button @click="copy">复制两段及出处</button>
      <span role="status">{{ copied }}</span>
    </div>
    <div class="comparison-pages">
      <ComparisonPage
        v-if="ready"
        :page="a"
        side="left"
        @read="emit('read', $event)"
        @hash="emit('hash', $event)"
        @leave="emit('leave')"
        @geometry="geometry('left', $event)"
      />
      <div ref="gutter" class="comparison-gutter" aria-hidden="true">
        <span>之间</span>
        <svg>
          <path v-if="connection" :d="connection" class="comparison-thread-glow" />
          <path v-if="connection" :d="connection" class="comparison-thread" />
        </svg>
      </div>
      <ComparisonPage
        v-if="ready"
        :page="b"
        side="right"
        @read="emit('read', $event)"
        @hash="emit('hash', $event)"
        @leave="emit('leave')"
        @geometry="geometry('right', $event)"
      />
    </div>
    <footer class="comparison-footer">
      <span>两页独立阅读 · 选字与复制保持原文</span
      ><span>细线连接当前标记位置，含义由阅读展开。</span>
    </footer>
  </dialog>
</template>

<style src="../styles/comparison.css"></style>
