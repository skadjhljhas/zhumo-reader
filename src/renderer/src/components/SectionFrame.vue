<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 章节容器（分块懒挂载的基本单元）。
 *
 * 两态：
 * - 挂载态：v-html 渲染整章 HTML；content-visibility:auto +
 *   contain-intrinsic-size:auto <估算>px 让屏外已挂载章跳过渲染且高度不塌。
 * - 占位态：min-height 估算高度的骨架（高度来自缓存的真实值或字符数估算）。
 * ResizeObserver 把真实高度持续回报给父级缓存。
 */
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import type { Section } from '../../../shared/types'

const props = defineProps<{
  section: Section
  mounted: boolean
  estimatedHeight: number
}>()

const emit = defineEmits<{
  (e: 'height', id: string, px: number): void
  (e: 'anchors-ready', id: string, el: HTMLElement): void
  (e: 'anchors-gone', id: string): void
}>()

const rootEl = ref<HTMLElement | null>(null)
let ro: ResizeObserver | null = null

onMounted(() => {
  if (!rootEl.value) return
  ro = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height
    if (h && h > 0) emit('height', props.section.id, h)
  })
  ro.observe(rootEl.value)
})

watch(
  () => props.mounted,
  async (mounted) => {
    await nextTick()
    if (!rootEl.value) return
    if (mounted) emit('anchors-ready', props.section.id, rootEl.value)
    else emit('anchors-gone', props.section.id)
  },
  { flush: 'post' }
)

onMounted(async () => {
  if (props.mounted) {
    await nextTick()
    if (rootEl.value) emit('anchors-ready', props.section.id, rootEl.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  if (props.mounted) emit('anchors-gone', props.section.id)
})
</script>

<template>
  <div ref="rootEl" class="section-frame" :data-section-id="section.id">
    <div
      v-if="mounted"
      class="section-body"
      :style="{ containIntrinsicSize: `auto ${Math.round(estimatedHeight)}px` }"
      v-html="section.html"
    ></div>
    <div
      v-else
      class="section-placeholder"
      :style="{ minHeight: `${Math.round(estimatedHeight)}px` }"
      aria-hidden="true"
    >
      <div class="sk-title"></div>
      <div class="sk-line"></div>
      <div class="sk-line"></div>
      <div class="sk-line"></div>
    </div>
  </div>
</template>

<style scoped>
.section-body {
  /* content-visibility:auto：屏外跳过渲染，contain-intrinsic-size 保住高度 */
  content-visibility: auto;
}
</style>
