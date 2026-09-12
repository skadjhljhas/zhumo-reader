<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { createHdrField, type HdrFieldMotion } from '../effects/hdr-field'
import { hdrState } from '../effects/hdr'
const props = defineProps<{ motion: HdrFieldMotion }>()
const canvas = ref<HTMLCanvasElement>()
let renderer: Awaited<ReturnType<typeof createHdrField>> | undefined,
  disposed = false
const unsubscribe = props.motion.subscribe((value) => {
  if (!document.hidden) renderer?.draw(value)
})
onMounted(async () => {
  if (!canvas.value) return
  try {
    const next = await createHdrField(canvas.value)
    if (disposed) {
      next.dispose()
      return
    }
    renderer = next
    props.motion.setReady(true)
    if (props.motion.current) next.draw(props.motion.current)
  } catch (error) {
    hdrState.engine = 'unavailable'
    hdrState.error = String(error)
  }
})
onBeforeUnmount(() => {
  disposed = true
  props.motion.setReady(false)
  unsubscribe()
  renderer?.dispose()
})
</script>
<template><canvas ref="canvas" class="hdr-canvas" aria-hidden="true" /></template>
