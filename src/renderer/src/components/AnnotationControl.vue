<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { settings } from '../composables/useSettings'
import { openAiSettings } from '../composables/aiReading'
import {
  chooseAnnotationMode,
  documentAnnotations,
  stopDocumentAnnotations,
  retryDocumentAnnotations
} from '../composables/documentAnnotations'
const open = ref(false),
  root = ref<HTMLElement>(),
  menu = ref<HTMLElement>()
function outside(event: PointerEvent): void {
  if (
    event.target instanceof Node &&
    !root.value?.contains(event.target) &&
    !menu.value?.contains(event.target)
  )
    open.value = false
}
function key(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}
function configure(): void {
  openAiSettings('syntax')
  open.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', key)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', key)
})
</script>
<template>
  <div ref="root" class="annotation-control">
    <button
      class="rail-button"
      aria-label="文本标注方式"
      title="文本标注 · 跟随阅读 / 全文"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="annotation-letter">字</span>
    </button>
    <Teleport to="body"
      ><aside
        v-if="open"
        ref="menu"
        class="annotation-menu"
        role="dialog"
        aria-label="文本标注方式"
      >
        <header>
          <strong>文本标注</strong
          ><button aria-label="关闭标注选项" @click="open = false">×</button>
        </header>
        <div class="annotation-modes" role="radiogroup" aria-label="标注范围">
          <label :class="{ selected: settings.annotationMode === 'follow' }">
            <input
              type="radio"
              name="annotation-mode"
              value="follow"
              :checked="settings.annotationMode === 'follow'"
              @change="chooseAnnotationMode('follow')"
            />
            <span><b>跟随阅读</b><small>随阅读位置，逐段细读</small></span>
          </label>
          <label :class="{ selected: settings.annotationMode === 'document' }">
            <input
              type="radio"
              name="annotation-mode"
              value="document"
              :checked="settings.annotationMode === 'document'"
              @change="chooseAnnotationMode('document')"
            />
            <span><b>全文标注</b><small>通读全文，贯通句段</small></span>
          </label>
        </div>
        <p class="annotation-channels">字色 · 荧光 · 光华</p>
        <template v-if="settings.annotationMode === 'document'">
          <p class="annotation-phase" role="status">{{ documentAnnotations.phase }}</p>
          <p v-if="documentAnnotations.error" class="annotation-error">
            {{ documentAnnotations.error }}
          </p>
          <p v-if="documentAnnotations.warning" class="annotation-error">
            {{ documentAnnotations.warning }}
          </p>
          <p v-if="documentAnnotations.summary" class="annotation-summary">
            {{ documentAnnotations.summary }}
          </p>
          <details v-if="documentAnnotations.reasoning">
            <summary>思考过程</summary>
            <pre>{{ documentAnnotations.reasoning }}</pre>
          </details>
          <button
            v-if="['preparing', 'running'].includes(documentAnnotations.status)"
            class="annotation-action"
            @click="stopDocumentAnnotations"
          >
            停止本次分析
          </button>
          <button
            v-else-if="['error', 'cancelled'].includes(documentAnnotations.status)"
            class="annotation-action"
            @click="retryDocumentAnnotations"
          >
            重新分析全文
          </button>
        </template>
        <button class="annotation-action" @click="configure">模型与独立提示词</button>
        <small class="annotation-hint">两种模式共用模型，各自保留提示词。</small>
      </aside></Teleport
    >
  </div>
</template>
<style>
.annotation-control {
  position: relative;
}
.annotation-letter {
  font-family: var(--font-body, serif);
  font-size: 21px;
  line-height: 1;
}
.annotation-menu {
  position: fixed;
  left: calc(var(--rail-w, 104px) + 8px);
  bottom: 44px;
  width: 310px;
  max-width: calc(100vw - var(--rail-w, 104px) - 20px);
  max-height: 75vh;
  overflow: auto;
  z-index: 2000;
  padding: 20px;
  color: var(--text);
  background: var(--drawer-bg, #eff6f5ed);
  backdrop-filter: blur(28px);
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  box-shadow: 0 12px 70px #142b4026;
  text-align: left;
}
.annotation-menu header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.annotation-menu header button {
  border: 0;
  background: none;
  color: inherit;
  font-size: 24px;
}
.annotation-modes {
  display: grid;
  gap: 8px;
}
.annotation-modes label {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 8px;
  border-radius: 8px;
}
.annotation-modes label.selected {
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.annotation-modes input {
  accent-color: var(--accent);
}
.annotation-modes b {
  display: block;
  font-size: 15px;
  font-weight: 500;
}
.annotation-modes small,
.annotation-hint {
  display: block;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.7;
}
.annotation-channels {
  letter-spacing: 0.18em;
  font-size: 12px;
  color: var(--text-2);
  margin: 15px 0;
}
.annotation-phase,
.annotation-summary,
.annotation-error {
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
  margin: 10px 0;
}
.annotation-error {
  color: var(--text-2);
  border-left: 2px solid #aa7d8c;
  padding-left: 10px;
}
.annotation-action {
  display: block;
  border: 0;
  background: transparent;
  color: var(--accent);
  padding: 8px 0;
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.annotation-menu details {
  font-size: 12px;
  margin: 8px 0;
}
.annotation-menu pre {
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
  font: inherit;
  line-height: 1.8;
}
</style>
