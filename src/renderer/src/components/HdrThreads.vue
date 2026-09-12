<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { hdrEnabled, markHdrSourceDirty } from '../effects/hdr'
import HdrCanvas from './HdrCanvas.vue'
const props = defineProps<{ paths: string[] }>()
const source = document.createElement('canvas')
function paint(): void {
  if (!hdrEnabled.value) return
  const scale = Math.min(devicePixelRatio, 1.5)
  const width = Math.ceil(innerWidth * scale),
    height = Math.ceil(innerHeight * scale)
  if (source.width !== width) source.width = width
  if (source.height !== height) source.height = height
  const c = source.getContext('2d')!
  c.setTransform(scale, 0, 0, scale, 0, 0)
  c.clearRect(0, 0, innerWidth, innerHeight)
  const g = c.createLinearGradient(innerWidth * 0.35, 0, innerWidth * 0.85, 0)
  g.addColorStop(0, '#8be6e6')
  g.addColorStop(0.5, '#c1b6ff')
  g.addColorStop(1, '#f1cd9b')
  c.strokeStyle = g
  c.lineCap = 'round'
  for (const d of props.paths.filter(Boolean)) {
    const path = new Path2D(d)
    c.filter = 'blur(4px)'
    c.globalAlpha = 0.2
    c.lineWidth = 7
    c.stroke(path)
    c.filter = 'blur(.55px)'
    c.globalAlpha = 0.85
    c.lineWidth = 1.1
    c.stroke(path)
  }
  markHdrSourceDirty(source)
}
watch(() => [props.paths, hdrEnabled.value], paint, { deep: true })
onMounted(() => {
  window.addEventListener('resize', paint)
  paint()
})
onBeforeUnmount(() => window.removeEventListener('resize', paint))
</script>
<template>
  <div v-if="hdrEnabled && paths.some(Boolean)" class="hdr-threads" aria-hidden="true">
    <HdrCanvas :source="source" />
  </div>
</template>
<style>
.hdr-threads {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 33;
}
</style>
