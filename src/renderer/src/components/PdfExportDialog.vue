<script setup lang="ts">
import { pdfExport, exportCurrentPdf } from '../composables/pdfExport'
import StudioIcon from './StudioIcon.vue'
import { ref, watch, nextTick } from 'vue'
const dialog = ref<HTMLDialogElement>()
watch(
  () => pdfExport.open,
  async (open) => {
    await nextTick()
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  }
)
</script>
<template>
  <dialog
    ref="dialog"
    class="pdf-export-dialog"
    aria-label="导出 PDF"
    @close="pdfExport.open = false"
    @cancel="pdfExport.busy && $event.preventDefault()"
    @click.self="!pdfExport.busy && (pdfExport.open = false)"
  >
    <header>
      <h2>导出 PDF</h2>
      <button
        class="studio-icon-button"
        aria-label="关闭PDF导出"
        :disabled="pdfExport.busy"
        @click="pdfExport.open = false"
      >
        <StudioIcon name="close" />
      </button>
    </header>
    <label
      >视觉风格<select v-model="pdfExport.style" :disabled="pdfExport.busy">
        <option value="theme">保留当前阅读主题</option>
        <option value="paper">纸面排版</option>
      </select></label
    >
    <label
      >页面方向<select v-model="pdfExport.landscape" :disabled="pdfExport.busy">
        <option :value="false">A4 · 纵向</option>
        <option :value="true">A4 · 横向</option>
      </select></label
    >
    <label class="pdf-note-option"
      ><input
        v-model="pdfExport.notes"
        type="checkbox"
        :disabled="pdfExport.busy"
      />包含全部注释</label
    >
    <p>导出全文。主题色彩、字体与已有的文字荧光会保留，动态背景定格为静态光场。</p>
    <p v-if="pdfExport.error" role="alert">{{ pdfExport.error }}</p>
    <button class="studio-primary" :disabled="pdfExport.busy" @click="exportCurrentPdf">
      {{ pdfExport.busy ? '正在排版…' : '导出 PDF' }}
    </button>
  </dialog>
</template>
<style>
.pdf-export-dialog::backdrop {
  background: #10273430;
}
.pdf-export-dialog {
  width: min(430px, calc(100vw - 40px));
  padding: 24px;
  border-radius: 18px;
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: 0 20px 80px #102c4930;
  font-family: var(--ui-font);
}
.pdf-export-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.pdf-export-dialog h2 {
  font-size: 20px;
}
.pdf-export-dialog label {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0;
}
.pdf-export-dialog select {
  font: inherit;
  padding: 7px;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.pdf-export-dialog .pdf-note-option {
  justify-content: flex-start;
  gap: 8px;
}
.pdf-export-dialog p {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
  margin: 18px 0;
}
</style>
