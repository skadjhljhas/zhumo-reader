<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StudioIcon from './StudioIcon.vue'
import { bookState } from '../composables/useBook'
import { readerState, requestSearchLanding, requestSidebarLocate } from '../composables/readerStore'
import { settings } from '../composables/useSettings'
import { studio } from '../composables/useStudio'
import { findEquation } from '../composables/formulaLocation'
import { closeNotePeek } from '../composables/notePeek'
const dialog = ref<HTMLDialogElement>()
const viewport = ref<HTMLElement>(),
  content = ref<HTMLElement>()
const source = ref(''),
  rendered = ref(''),
  message = ref(''),
  engine = ref('')
const context = ref(''),
  passage = ref('')
const scale = ref(1)
const natural = ref({ width: 1, height: 1 })
const fitMode = ref(true),
  open = ref(false),
  panReady = ref(false),
  panning = ref(false)
const planeStyle = computed(() => ({
  width: `max(100%, ${Math.ceil(natural.value.width * scale.value + 96)}px)`,
  height: `max(100%, ${Math.ceil(natural.value.height * scale.value + 96)}px)`
}))
let opener: HTMLElement | null = null,
  fromPreview = false,
  sequence = 0
let resizeObserver: ResizeObserver | undefined
let drag: { x: number; y: number; left: number; top: number; moved: boolean } | undefined
let suppressClick = false
async function fit(): Promise<void> {
  const area = viewport.value
  if (!area || !open.value) return
  fitMode.value = true
  scale.value = Math.max(
    0.1,
    Math.min(
      1,
      (area.clientWidth - 96) / natural.value.width,
      (area.clientHeight - 96) / natural.value.height
    )
  )
  await nextTick()
  area.scrollTo(
    (area.scrollWidth - area.clientWidth) / 2,
    (area.scrollHeight - area.clientHeight) / 2
  )
}
function measure(): void {
  if (!content.value || !open.value) return
  natural.value = {
    width: Math.max(1, content.value.offsetWidth),
    height: Math.max(1, content.value.offsetHeight)
  }
  if (fitMode.value) void fit()
}
async function zoomTo(value: number, point?: { x: number; y: number }): Promise<void> {
  const area = viewport.value
  if (!area) return
  const x = point?.x ?? area.clientWidth / 2,
    y = point?.y ?? area.clientHeight / 2
  const dimensions = natural.value
  const left =
    (Math.max(area.clientWidth, dimensions.width * scale.value + 96) -
      dimensions.width * scale.value) /
    2
  const top =
    (Math.max(area.clientHeight, dimensions.height * scale.value + 96) -
      dimensions.height * scale.value) /
    2
  const sourceX = (area.scrollLeft + x - left) / scale.value
  const sourceY = (area.scrollTop + y - top) / scale.value
  fitMode.value = false
  scale.value = Math.max(0.1, Math.min(4, value))
  await nextTick()
  const newLeft = (area.scrollWidth - dimensions.width * scale.value) / 2
  const newTop = (area.scrollHeight - dimensions.height * scale.value) / 2
  area.scrollTo(newLeft + sourceX * scale.value - x, newTop + sourceY * scale.value - y)
}
async function inspect(target: Element): Promise<void> {
  const formula = target.closest<HTMLElement>('.zmu-math')
  if (!formula || dialog.value?.contains(formula)) return
  const token = ++sequence
  opener = formula
  fromPreview = !!formula.closest('.draft-preview,.note-writing-desk')
  source.value = formula.dataset.mathSource ?? ''
  // Equation labels belong to the reading projection; the enlarged copy must not duplicate IDs.
  rendered.value = formula.innerHTML.replace(/\sid="mjx-eqn:[^"]*"/g, '')
  engine.value = formula.dataset.mathEngine ?? ''
  const note = formula.closest('.note-card')?.getAttribute('aria-label')
  context.value = fromPreview
    ? '排版预览'
    : note
      ? `旁注 · ${note}`
      : formula.closest('.panorama-reading')?.querySelector('h3')?.textContent ||
        readerState.currentHeadingTitle ||
        bookState.book?.title ||
        '正文'
  const parent = formula.closest('p,li')?.cloneNode(true) as Element | undefined
  parent?.querySelectorAll('.zmu-math').forEach((math) => {
    math.textContent = (math as HTMLElement).dataset.mathSource ?? ''
  })
  parent?.querySelectorAll('.zmu-ref').forEach((ref) => ref.remove())
  passage.value = (parent?.textContent ?? '').trim().slice(0, 180)
  scale.value = 1
  fitMode.value = true
  message.value = ''
  open.value = true
  dialog.value?.showModal()
  await nextTick()
  await document.fonts.ready
  if (token !== sequence || !open.value) return
  measure()
  viewport.value?.focus({ preventScroll: true })
}
async function followEquation(hash: string, preview: boolean): Promise<void> {
  dialog.value?.close()
  closeNotePeek()
  studio.atlasOpen = false
  studio.panoramaOpen = false
  studio.searchOpen = false
  if (preview) {
    window.dispatchEvent(new CustomEvent('zhumo:preview-fragment', { detail: hash }))
    return
  }
  const target = bookState.book && findEquation(bookState.book, hash)
  if (!target) return
  if (target.kind === 'note') {
    settings.sidebarVisible = true
    studio.focusMode = false
    await nextTick()
    requestSidebarLocate(target.id, target.blockIndex)
  } else requestSearchLanding(target.id, target.blockIndex)
}
function click(event: MouseEvent): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return
  if (window.getSelection()?.toString()) return
  const anchor = event.target.closest('a[href]')
  const hash = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href') ?? ''
  if (hash.startsWith('#mjx-eqn') && anchor?.closest('.zmu-math,.math-content')) {
    event.preventDefault()
    event.stopImmediatePropagation()
    void followEquation(
      hash,
      dialog.value?.contains(anchor)
        ? fromPreview
        : !!anchor.closest('.draft-preview,.note-writing-desk')
    )
    return
  }
  void inspect(event.target)
}
function keydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (event.target instanceof Element && event.target.matches('.zmu-math')) {
    event.preventDefault()
    void inspect(event.target)
  }
}
function onDialogKey(event: KeyboardEvent): void {
  if ((event.target as Element).closest('input,pre,button')) return
  if (event.key === ' ') {
    event.preventDefault()
    panReady.value = true
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    void zoomTo(scale.value * 1.2)
  } else if (event.key === '-') {
    event.preventDefault()
    void zoomTo(scale.value / 1.2)
  } else if (event.key === '0') {
    event.preventDefault()
    void zoomTo(1)
  } else if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    void fit()
  }
  if (event.defaultPrevented) event.stopPropagation()
}
function wheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const rect = viewport.value!.getBoundingClientRect()
  void zoomTo(scale.value * Math.exp(-event.deltaY * 0.0015), {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  })
}
function startPan(event: PointerEvent): void {
  if (!panReady.value || event.button !== 0 || !viewport.value) return
  event.preventDefault()
  drag = {
    x: event.clientX,
    y: event.clientY,
    left: viewport.value.scrollLeft,
    top: viewport.value.scrollTop,
    moved: false
  }
  viewport.value.setPointerCapture(event.pointerId)
  panning.value = true
}
function pan(event: PointerEvent): void {
  if (!drag || !viewport.value) return
  const dx = event.clientX - drag.x,
    dy = event.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  viewport.value.scrollTo(drag.left - dx, drag.top - dy)
}
function endPan(): void {
  if (drag) suppressClick = drag.moved
  drag = undefined
  panning.value = false
}
function stageClick(event: MouseEvent): void {
  if (suppressClick) {
    event.preventDefault()
    event.stopPropagation()
    suppressClick = false
  }
}
function closed(): void {
  sequence++
  open.value = false
  rendered.value = ''
  panReady.value = false
  endPan()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(source.value)
    message.value = 'LaTeX 已复制'
  } catch {
    message.value = '复制失败，请选中下方源文复制'
  }
}
onMounted(() => {
  document.addEventListener('click', click)
  document.addEventListener('keydown', keydown)
  resizeObserver = new ResizeObserver(measure)
  if (content.value) resizeObserver.observe(content.value)
  if (viewport.value) resizeObserver.observe(viewport.value)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', click)
  document.removeEventListener('keydown', keydown)
  resizeObserver?.disconnect()
})
watch(
  () => bookState.payload?.path,
  () => dialog.value?.close()
)
</script>
<template>
  <dialog
    ref="dialog"
    class="math-dialog"
    aria-labelledby="formula-title"
    @click="$event.target === dialog && dialog?.close()"
    @close="closed"
    @keydown="onDialogKey"
    @keyup.space="panReady = false"
  >
    <header class="math-dialog-head">
      <div class="math-heading">
        <span class="math-eyebrow">{{ context }}</span>
        <h2 id="formula-title">公式细读</h2>
      </div>
      <button class="studio-icon-button" aria-label="关闭公式" @click="dialog?.close()">
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="math-workspace">
      <div class="math-stage">
        <div
          ref="viewport"
          class="math-viewport"
          tabindex="0"
          role="region"
          aria-label="放大的公式，可横向和纵向滚动"
          :class="{ 'can-pan': panReady, 'is-panning': panning }"
          @wheel="wheel"
          @pointerdown="startPan"
          @pointermove="pan"
          @pointerup="endPan"
          @pointercancel="endPan"
          @lostpointercapture="endPan"
          @click="stageClick"
          @blur="panReady = false"
        >
          <div class="math-plane" :style="planeStyle">
            <div
              ref="content"
              class="math-content"
              :style="{ transform: `translate(-50%, -50%) scale(${scale})` }"
              v-html="rendered"
            />
          </div>
        </div>
        <div class="math-stage-caption">
          <span>{{ engine === 'source' ? '保留原式' : '循着每一个符号，展开。' }}</span
          ><span>空格 + 拖动 · Ctrl + 滚轮缩放</span>
        </div>
      </div>
      <aside class="math-source-panel" aria-label="公式源文与上下文">
        <div class="math-source-label">LaTeX 源文</div>
        <pre class="math-source" tabindex="0" aria-label="LaTeX 源文">{{ source }}</pre>
        <p v-if="passage" class="math-passage">{{ passage }}</p>
        <p v-if="engine === 'source'" class="math-render-message" role="status">
          暂时无法排版此语法，原式完整保留。
        </p>
        <button class="studio-primary math-copy" @click="copy">
          <StudioIcon name="copy" :size="15" />复制 LaTeX
        </button>
        <span class="math-copy-status" role="status">{{ message }}</span>
      </aside>
    </div>
    <div class="math-controls">
      <div class="math-fit-controls">
        <button :aria-pressed="fitMode" @click="fit">
          <StudioIcon name="focus" :size="15" />适合窗口</button
        ><button :aria-pressed="!fitMode && scale === 1" @click="zoomTo(1)">实际大小</button>
      </div>
      <div class="math-zoom-controls">
        <button aria-label="缩小公式" @click="zoomTo(scale / 1.2)">−</button
        ><label
          >缩放<input
            :value="scale"
            type="range"
            min="0.1"
            max="4"
            step="0.05"
            aria-label="公式缩放"
            @input="zoomTo(Number(($event.target as HTMLInputElement).value))" /></label
        ><button aria-label="放大公式" @click="zoomTo(scale * 1.2)">+</button
        ><output class="math-scale">{{ Math.round(scale * 100) }}%</output>
      </div>
    </div>
  </dialog>
</template>
