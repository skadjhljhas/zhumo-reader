<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { studio } from '../composables/useStudio'
import { bookState } from '../composables/useBook'
import { documentSession } from '../composables/documentSession'
import { renderDiagram, diagramName } from '../composables/diagramRenderer'
import { diagramInstance } from '../composables/diagramSvg'

const DiagramInspector = defineAsyncComponent(() => import('./DiagramInspector.vue'))
const inspection = shallowRef<{ source: string; origin: HTMLElement }>()
const tracked = new Set<HTMLElement>()
const active = new Set<HTMLElement>()
const versions = new WeakMap<HTMLElement, number>()
let observer: MutationObserver | undefined,
  intersection: IntersectionObserver | undefined,
  alive = true
function sourceFor(root: HTMLElement): string {
  return root.querySelector('.diagram-source code')?.textContent ?? ''
}
function collect(element: Element): void {
  const nodes = element.matches('.zmu-diagram')
    ? [element]
    : element.querySelectorAll('.zmu-diagram')
  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || tracked.has(node)) continue
    tracked.add(node)
    intersection?.observe(node)
  }
}
async function draw(root: HTMLElement): Promise<void> {
  const token = (versions.get(root) ?? 0) + 1
  versions.set(root, token)
  const theme = studio.themeId
  const source = sourceFor(root)
  const canvas = root.querySelector<HTMLElement>('.diagram-canvas')!
  const status = root.querySelector<HTMLElement>('.diagram-status')!
  root.dataset.diagramState = 'rendering'
  try {
    const result = await renderDiagram(source, theme)
    if (!alive || !root.isConnected || versions.get(root) !== token || theme !== studio.themeId)
      return
    canvas.innerHTML = diagramInstance(result.svg)
    root.dataset.diagramState = 'ready'
    root.querySelector('.diagram-kind')!.textContent = diagramName(result.type)
    status.textContent = ''
  } catch (error) {
    if (!alive || !root.isConnected || versions.get(root) !== token) return
    root.dataset.diagramState = 'error'
    canvas.innerHTML = ''
    canvas.hidden = true
    root.querySelector<HTMLElement>('.diagram-source')!.hidden = false
    const toggle = root.querySelector<HTMLElement>('[data-diagram-action="source"]')!
    toggle.setAttribute('aria-expanded', 'true')
    toggle.textContent = '查看图解'
    status.textContent = '暂未排版，源文完整保留。展开可查看原因。'
    status.title = error instanceof Error ? error.message : String(error)
  }
}
function toggleSource(root: HTMLElement): void {
  const pre = root.querySelector<HTMLElement>('.diagram-source')!
  const canvas = root.querySelector<HTMLElement>('.diagram-canvas')!
  pre.hidden = !pre.hidden
  canvas.hidden = !pre.hidden
  const button = root.querySelector('[data-diagram-action="source"]')!
  button.textContent = pre.hidden ? '查看源文' : '查看图解'
  button.setAttribute('aria-expanded', String(!pre.hidden))
  if (pre.hidden && root.dataset.diagramState === 'error') {
    canvas.innerHTML = '<span class="diagram-wait">图解尚未排版，请展开查看源文与原因。</span>'
  }
}
function open(root: HTMLElement, target: HTMLElement): void {
  inspection.value = { source: sourceFor(root), origin: target }
}
function click(event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    !(event.target instanceof Element) ||
    window.getSelection()?.toString()
  )
    return
  const root = event.target.closest<HTMLElement>('.zmu-diagram')
  if (!root) return
  const button = event.target.closest<HTMLElement>('[data-diagram-action]')
  const canvas = event.target.closest<HTMLElement>('.diagram-canvas')
  if (!button && !canvas) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (button?.dataset.diagramAction === 'source') toggleSource(root)
  else open(root, button ?? canvas!)
}
function key(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    !['Enter', ' '].includes(event.key) ||
    !(event.target instanceof HTMLElement) ||
    !event.target.matches('.diagram-canvas')
  )
    return
  const root = event.target.closest<HTMLElement>('.zmu-diagram')
  if (!root) return
  event.preventDefault()
  event.stopImmediatePropagation()
  open(root, event.target)
}
onMounted(() => {
  intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const root = entry.target as HTMLElement
        if (entry.isIntersecting) {
          active.add(root)
          if (root.dataset.diagramState === 'pending') void draw(root)
        } else active.delete(root)
      }
    },
    { rootMargin: '160px' }
  )
  collect(document.body)
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.target instanceof Element &&
        record.target.closest('.zmu-diagram,.diagram-layout-scratch,.diagram-dialog')
      )
        continue
      for (const node of record.addedNodes) if (node instanceof Element) collect(node)
    }
    for (const root of tracked)
      if (!root.isConnected) {
        tracked.delete(root)
        active.delete(root)
        intersection?.unobserve(root)
        versions.set(root, (versions.get(root) ?? 0) + 1)
      }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', click, true)
  document.addEventListener('keydown', key, true)
})
watch(
  () => studio.themeId,
  () => {
    for (const root of tracked) {
      versions.set(root, (versions.get(root) ?? 0) + 1)
      root.dataset.diagramState = 'pending'
      if (active.has(root)) void draw(root)
    }
  }
)
watch(
  () => [bookState.payload?.path, documentSession.mode],
  () => {
    inspection.value = undefined
  }
)
onBeforeUnmount(() => {
  alive = false
  observer?.disconnect()
  intersection?.disconnect()
  document.removeEventListener('click', click, true)
  document.removeEventListener('keydown', key, true)
})
</script>

<template>
  <DiagramInspector
    v-if="inspection"
    :source="inspection.source"
    :origin="inspection.origin"
    @close="inspection = undefined"
  />
</template>

<style src="../styles/diagrams.css"></style>
