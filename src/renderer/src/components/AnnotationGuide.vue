<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { studio } from '../composables/useStudio'
import { openAnnotationExample } from '../composables/useBook'
import StudioIcon from './StudioIcon.vue'
import protocol from '../../../../docs/ai-annotation-protocol.md?raw'
import contract from '../../../../docs/renderer-contract.md?raw'
const dialog = ref<HTMLDialogElement>()
const tab = ref<'protocol' | 'contract'>('protocol')
const message = ref('')
const content = computed(() => (tab.value === 'protocol' ? protocol : contract))
function chooseTab(value: 'protocol' | 'contract'): void {
  tab.value = value
  message.value = ''
}
watch(
  () => studio.promptOpen,
  async (open) => {
    await nextTick()
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
  { immediate: true }
)
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(content.value)
    message.value = '已复制，可以粘贴给 AI'
  } catch {
    message.value = '请选择下方正文复制'
  }
}
function example(): void {
  studio.promptOpen = false
  openAnnotationExample()
}
</script>
<template>
  <dialog
    ref="dialog"
    class="annotation-dialog"
    @close="studio.promptOpen = false"
    @cancel="studio.promptOpen = false"
    @click="$event.target === dialog && (studio.promptOpen = false)"
  >
    <header class="annotation-head">
      <div>
        <span class="eyebrow">THE ART OF ANNOTATION</span>
        <h2>让正文向前，让旁注向深处。</h2>
        <p>把这份协议交给 AI，再给它你的材料与写作任务。</p>
      </div>
      <button
        class="studio-icon-button"
        aria-label="关闭写作协议"
        @click="studio.promptOpen = false"
      >
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="annotation-tabs">
      <button :aria-pressed="tab === 'protocol'" @click="chooseTab('protocol')">注释写作协议</button
      ><button :aria-pressed="tab === 'contract'" @click="chooseTab('contract')">纯渲染约定</button
      ><button class="annotation-example-button" @click="example">
        在朱墨中读范例 <StudioIcon name="arrow" :size="14" />
      </button>
    </div>
    <pre class="annotation-content" tabindex="0">{{ content }}</pre>
    <footer class="annotation-footer">
      <span role="status">{{ message || '名称、密度、长短与文风，都由作品决定。' }}</span
      ><button class="studio-primary" @click="copy">
        <StudioIcon name="copy" :size="16" />{{
          tab === 'protocol' ? '复制写作协议' : '复制渲染约定'
        }}
      </button>
    </footer>
  </dialog>
</template>
