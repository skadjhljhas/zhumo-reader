<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { documentSession, isDirty } from '../composables/documentSession'
import { discardDraft, saveCurrentDocument } from '../composables/useEditor'
const dialog = ref<HTMLDialogElement>()
watch(
  () => documentSession.showLeaveDialog,
  async (open) => {
    await nextTick()
    if (open && !dialog.value?.open) dialog.value?.showModal()
    else if (!open) dialog.value?.close()
  }
)
function cancel(): void {
  documentSession.showLeaveDialog = false
  documentSession.pendingAction = null
}
async function finish(save: boolean): Promise<void> {
  if (documentSession.saving) return
  if (save) {
    if (!(await saveCurrentDocument()) || isDirty.value) return
  } else await discardDraft()
  const action = documentSession.pendingAction
  cancel()
  action?.()
}
</script>
<template>
  <dialog
    ref="dialog"
    class="leave-dialog"
    aria-labelledby="leave-title"
    @cancel.prevent="cancel"
    @close="documentSession.showLeaveDialog = false"
  >
    <h2 id="leave-title">还有未保存的修改</h2>
    <p>保存后继续，或回到编辑。选择放弃会撤销本次未保存的修改。</p>
    <p v-if="documentSession.error" class="studio-error" role="alert">
      {{ documentSession.error }}
    </p>
    <div class="leave-actions">
      <button :disabled="documentSession.saving" @click="finish(false)">放弃修改</button>
      <button :disabled="documentSession.saving" autofocus @click="cancel">继续编辑</button>
      <button class="studio-primary" :disabled="documentSession.saving" @click="finish(true)">
        {{ documentSession.saving ? '保存中…' : '保存并继续' }}
      </button>
    </div>
  </dialog>
</template>
