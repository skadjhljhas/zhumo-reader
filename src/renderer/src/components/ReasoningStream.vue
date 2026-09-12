<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ text: string; running: boolean }>()
const view = ref<HTMLElement>(),
  shown = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.text,
  () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const el = view.value
      const following = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 32
      shown.value = props.text
      if (following) void nextTick(() => view.value?.scrollTo({ top: view.value.scrollHeight }))
    }, 80)
  },
  { immediate: true }
)
onBeforeUnmount(() => clearTimeout(timer))
</script>
<template>
  <details v-if="text" class="model-reasoning" open>
    <summary>
      思考<span>{{ running ? '正在抵达' : '已接收' }}</span>
    </summary>
    <div ref="view" class="model-reasoning-text" tabindex="0" aria-label="模型返回的思考内容">
      {{ shown }}
    </div>
  </details>
</template>
<style scoped>
.model-reasoning {
  margin: 12px 0;
  font-size: 0.86em;
  color: var(--text-secondary, inherit);
}
summary {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 4px 0;
  cursor: inherit;
}
summary span {
  font-size: 0.85em;
  opacity: 0.65;
}
.model-reasoning-text {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  padding: 8px 10px;
  border-left: 1px solid currentColor;
  scrollbar-width: thin;
}
</style>
