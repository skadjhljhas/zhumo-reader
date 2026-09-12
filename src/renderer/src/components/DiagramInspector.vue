<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import StudioIcon from './StudioIcon.vue'
import { studio } from '../composables/useStudio'
import { bookState } from '../composables/useBook'
import { readerState } from '../composables/readerStore'
import { renderDiagram, diagramName, type DiagramResult } from '../composables/diagramRenderer'
import { diagramInstance, exportDiagramSvg } from '../composables/diagramSvg'

const props = defineProps<{ source: string; origin: HTMLElement }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const dialog = ref<HTMLDialogElement>(),
  viewport = ref<HTMLElement>()
const result = shallowRef<DiagramResult>()
const rendered = ref(''),
  miniature = ref(''),
  error = ref(''),
  message = ref('')
const scale = ref(1),
  fitMode = ref(true),
  panning = ref(false),
  panReady = ref(false)
const sourceVisible = ref(false)
const dimensions = ref({ width: 1, height: 1, left: 0, top: 0, scrollWidth: 1, scrollHeight: 1 })
const context = props.origin.closest('.note-card')?.getAttribute('aria-label')
const location = context
  ? `旁注 · ${context}`
  : props.origin.closest('.panorama-reading')?.querySelector('h3')?.textContent ||
    readerState.currentHeadingTitle ||
    bookState.book?.title ||
    '正文'
const natural = computed(() => ({
  width: result.value?.width ?? 1,
  height: result.value?.height ?? 1
}))
const mapSize = computed(() => {
  const ratio = Math.min(158 / natural.value.width, 98 / natural.value.height)
  return { width: natural.value.width * ratio, height: natural.value.height * ratio }
})
const mapStyle = computed(() => ({
  width: `${Math.max(66, mapSize.value.width + 12)}px`,
  height: `${Math.max(48, mapSize.value.height + 12)}px`
}))
const mapArtStyle = computed(() => ({
  width: `${mapSize.value.width}px`,
  height: `${mapSize.value.height}px`
}))
const planeStyle = computed(() => ({
  width: `max(100%, ${Math.ceil(natural.value.width * scale.value + 80)}px)`,
  height: `max(100%, ${Math.ceil(natural.value.height * scale.value + 80)}px)`
}))
const visibleMap = computed(() => {
  const box = dimensions.value,
    width = natural.value.width * scale.value,
    height = natural.value.height * scale.value
  const x = (box.scrollWidth - width) / 2,
    y = (box.scrollHeight - height) / 2
  const left = Math.min(width, Math.max(0, box.left - x)),
    top = Math.min(height, Math.max(0, box.top - y))
  return {
    left: `${(left / width) * 100}%`,
    top: `${(top / height) * 100}%`,
    width: `${(Math.max(0, Math.min(width, box.left + box.width - x) - left) / width) * 100}%`,
    height: `${(Math.max(0, Math.min(height, box.top + box.height - y) - top) / height) * 100}%`
  }
})
let alive = true,
  sequence = 0,
  observer: ResizeObserver | undefined
let drag: { x: number; y: number; left: number; top: number } | undefined
function measure(): void {
  const area = viewport.value
  if (area)
    dimensions.value = {
      width: area.clientWidth,
      height: area.clientHeight,
      left: area.scrollLeft,
      top: area.scrollTop,
      scrollWidth: area.scrollWidth,
      scrollHeight: area.scrollHeight
    }
}
async function fit(): Promise<void> {
  const area = viewport.value
  if (!area || !result.value) return
  fitMode.value = true
  scale.value = Math.min(
    1,
    Math.max(1, area.clientWidth - 80) / natural.value.width,
    Math.max(1, area.clientHeight - 80) / natural.value.height
  )
  await nextTick()
  area.scrollTo(
    (area.scrollWidth - area.clientWidth) / 2,
    (area.scrollHeight - area.clientHeight) / 2
  )
  measure()
}
async function zoom(value: number, point?: { x: number; y: number }): Promise<void> {
  const area = viewport.value
  if (!area || !result.value) return
  const x = point?.x ?? area.clientWidth / 2,
    y = point?.y ?? area.clientHeight / 2
  const worldX =
    (area.scrollLeft + x - (area.scrollWidth - natural.value.width * scale.value) / 2) / scale.value
  const worldY =
    (area.scrollTop + y - (area.scrollHeight - natural.value.height * scale.value) / 2) /
    scale.value
  fitMode.value = false
  scale.value = Math.max(0.01, Math.min(8, value))
  await nextTick()
  area.scrollTo(
    worldX * scale.value + (area.scrollWidth - natural.value.width * scale.value) / 2 - x,
    worldY * scale.value + (area.scrollHeight - natural.value.height * scale.value) / 2 - y
  )
  measure()
}
function wheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const rect = viewport.value!.getBoundingClientRect()
  void zoom(scale.value * Math.exp(-event.deltaY * 0.0015), {
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
    top: viewport.value.scrollTop
  }
  viewport.value.setPointerCapture(event.pointerId)
  panning.value = true
}
function pan(event: PointerEvent): void {
  if (drag)
    viewport.value?.scrollTo(drag.left - event.clientX + drag.x, drag.top - event.clientY + drag.y)
}
function endPan(): void {
  drag = undefined
  panning.value = false
}
function close(): void {
  dialog.value?.close()
  if (alive) emit('close')
}
function closed(): void {
  if (alive) emit('close')
}
function key(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if ((event.target as Element).closest('button,input,pre')) return
  if (event.key === ' ') {
    event.preventDefault()
    panReady.value = true
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    void zoom(scale.value * 1.25)
  } else if (event.key === '-') {
    event.preventDefault()
    void zoom(scale.value / 1.25)
  } else if (event.key === '0') {
    event.preventDefault()
    void zoom(1)
  } else if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    void fit()
  }
  if (event.defaultPrevented) event.stopPropagation()
}
function mapClick(event: MouseEvent): void {
  const area = viewport.value
  if (!area || !(event.currentTarget instanceof HTMLElement)) return
  const rect = event.currentTarget.querySelector('.diagram-map-art')!.getBoundingClientRect()
  const width = natural.value.width * scale.value,
    height = natural.value.height * scale.value
  if (event.detail === 0) {
    area.scrollTo(
      (area.scrollWidth - area.clientWidth) / 2,
      (area.scrollHeight - area.clientHeight) / 2
    )
    measure()
    return
  }
  area.scrollTo(
    ((event.clientX - rect.left) / rect.width) * width +
      (area.scrollWidth - width) / 2 -
      area.clientWidth / 2,
    ((event.clientY - rect.top) / rect.height) * height +
      (area.scrollHeight - height) / 2 -
      area.clientHeight / 2
  )
  measure()
}
async function toggleSource(): Promise<void> {
  sourceVisible.value = !sourceVisible.value
  await nextTick()
  if (fitMode.value) void fit()
}
async function copy(svg = false): Promise<void> {
  try {
    await navigator.clipboard.writeText(
      svg && result.value ? exportDiagramSvg(result.value.svg) : props.source
    )
    message.value = svg ? 'SVG 已复制' : 'Mermaid 源文已复制'
  } catch {
    message.value = '复制失败，可在源文中选字复制。'
    sourceVisible.value = true
  }
}
async function draw(): Promise<void> {
  const token = ++sequence
  error.value = ''
  try {
    const value = await renderDiagram(props.source, studio.themeId)
    if (!alive || token !== sequence) return
    result.value = value
    rendered.value = diagramInstance(value.svg)
    miniature.value = diagramInstance(value.svg)
    await nextTick()
    if (fitMode.value) await fit()
    measure()
  } catch (reason) {
    if (!alive || token !== sequence) return
    error.value = reason instanceof Error ? reason.message : String(reason)
    sourceVisible.value = true
  }
}
onMounted(() => {
  dialog.value?.showModal()
  viewport.value?.focus({ preventScroll: true })
  observer = new ResizeObserver(() => {
    measure()
    if (fitMode.value) void fit()
  })
  if (viewport.value) observer.observe(viewport.value)
  void draw()
})
watch(
  () => studio.themeId,
  () => {
    void draw()
  }
)
onBeforeUnmount(() => {
  alive = false
  sequence++
  observer?.disconnect()
  dialog.value?.close()
  if (props.origin.isConnected) props.origin.focus({ preventScroll: true })
})
</script>

<template>
  <dialog
    ref="dialog"
    class="diagram-dialog"
    aria-labelledby="diagram-title"
    @close="closed"
    @cancel.prevent="close"
    @keydown="key"
    @keyup.space="panReady = false"
  >
    <header class="diagram-head">
      <div>
        <span>{{ location }}</span>
        <h2 id="diagram-title">
          图解细读 <small>{{ result ? diagramName(result.type) : 'Mermaid' }}</small>
        </h2>
      </div>
      <div>
        <button class="diagram-source-toggle" :aria-pressed="sourceVisible" @click="toggleSource">
          <StudioIcon name="edit" :size="15" />源文</button
        ><button class="studio-icon-button" aria-label="关闭图解" @click="close">
          <StudioIcon name="close" />
        </button>
      </div>
    </header>
    <div class="diagram-workspace" :class="{ 'with-source': sourceVisible }">
      <section class="diagram-stage">
        <div
          ref="viewport"
          class="diagram-viewport"
          tabindex="0"
          role="region"
          aria-label="图解画布，可双向滚动与缩放"
          :class="{ 'can-pan': panReady, 'is-panning': panning }"
          @wheel="wheel"
          @pointerdown="startPan"
          @pointermove="pan"
          @pointerup="endPan"
          @pointercancel="endPan"
          @lostpointercapture="endPan"
          @scroll="measure"
          @blur="panReady = false"
        >
          <div v-if="result" class="diagram-plane" :style="planeStyle">
            <div
              class="diagram-enlarged"
              :style="{
                width: `${natural.width}px`,
                height: `${natural.height}px`,
                transform: `translate(-50%, -50%) scale(${scale})`
              }"
              v-html="rendered"
            ></div>
          </div>
          <p v-else class="diagram-stage-message">
            {{ error ? '图解暂未排版，源文完整保留。' : '正在展开图解…' }}
          </p>
        </div>
        <button
          v-if="result"
          class="diagram-map"
          title="点击定位图中位置"
          aria-label="图解全览，点击可定位"
          :style="mapStyle"
          @click="mapClick"
        >
          <span class="diagram-map-art" aria-hidden="true" :style="mapArtStyle"
            ><span class="diagram-map-image" v-html="miniature"></span
            ><span class="diagram-map-window" :style="visibleMap"></span
          ></span>
        </button>
        <div class="diagram-stage-caption">
          <span>{{ result?.title || '在结构之间，逐步读近。' }}</span
          ><span>空格 + 拖动 · Ctrl + 滚轮缩放</span>
        </div>
      </section>
      <aside v-if="sourceVisible" class="diagram-source-panel" aria-label="图解源文">
        <div>
          <span>Mermaid 源文</span
          ><button aria-label="收起图解源文" @click="toggleSource">
            <StudioIcon name="close" :size="14" />
          </button>
        </div>
        <pre tabindex="0" aria-label="图解 Mermaid 源文">{{ source }}</pre>
        <p v-if="error" class="diagram-error" role="status">{{ error }}</p>
      </aside>
    </div>
    <footer class="diagram-controls">
      <div>
        <button :aria-pressed="fitMode" :disabled="!result" @click="fit">
          <StudioIcon name="focus" :size="15" />适合图解</button
        ><button :disabled="!result" @click="zoom(1)">实际大小</button>
      </div>
      <div>
        <button aria-label="缩小图解" :disabled="!result" @click="zoom(scale / 1.25)">−</button
        ><input
          type="range"
          aria-label="图解缩放"
          min=".01"
          max="8"
          step=".01"
          :value="scale"
          :disabled="!result"
          @input="zoom(Number(($event.target as HTMLInputElement).value))"
        /><button aria-label="放大图解" :disabled="!result" @click="zoom(scale * 1.25)">+</button
        ><output>{{ scale < 0.01 ? '<1' : Math.round(scale * 100) }}%</output>
      </div>
      <div>
        <button @click="copy(false)">复制源文</button
        ><button :disabled="!result" @click="copy(true)">复制 SVG</button>
      </div>
    </footer>
    <span class="diagram-copy-status" role="status">{{ message }}</span>
  </dialog>
</template>
