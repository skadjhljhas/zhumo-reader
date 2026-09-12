<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { THEMES, studio, selectTheme } from '../composables/useStudio'
import StudioIcon from './StudioIcon.vue'
const dialog = ref<HTMLDialogElement | null>(null)
watch(
  () => studio.galleryOpen,
  async (open) => {
    await nextTick()
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  }
)
function key(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') studio.galleryOpen = false
}
onMounted(() => window.addEventListener('keydown', key))
onBeforeUnmount(() => window.removeEventListener('keydown', key))
</script>
<template>
  <dialog
    ref="dialog"
    class="theme-dialog"
    @close="studio.galleryOpen = false"
    @click="
      (e) => {
        if (e.target === dialog) studio.galleryOpen = false
      }
    "
  >
    <header class="gallery-head">
      <div>
        <span class="eyebrow">SPACES FOR YOUR MIND</span>
        <h2>换一种光，读同一段文字。</h2>
        <p>从白纸黑字到流动的光。共 {{ THEMES.length }} 种阅读空间。</p>
      </div>
      <button class="studio-icon-button" aria-label="关闭主题" @click="studio.galleryOpen = false">
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="theme-grid">
      <button
        v-for="(theme, i) in THEMES"
        :key="theme.id"
        class="theme-choice"
        :class="{ selected: studio.themeId === theme.id }"
        :aria-pressed="studio.themeId === theme.id"
        @click="selectTheme(theme.id)"
      >
        <div
          class="theme-mini"
          :class="theme.id"
          :style="{ '--mini-bg': theme.bg, '--mini-ink': theme.color }"
        >
          <span class="mini-number">{{ String(i + 1).padStart(2, '0') }}</span
          ><span class="mini-glyph">{{ theme.mark }}</span>
          <div class="mini-page"><i></i><i></i><i></i><i></i></div>
          <div class="mini-notes"><i></i><i></i></div>
          <span class="mini-name">{{ theme.english }}</span
          ><span v-if="studio.themeId === theme.id" class="mini-selected"
            ><StudioIcon name="check" :size="16"
          /></span>
        </div>
        <div class="theme-caption">
          <strong>{{ theme.name }}</strong
          ><span>{{ theme.mood }}</span
          ><small>{{ theme.detail }}</small>
        </div>
      </button>
    </div>
    <footer class="gallery-footer">
      <span>你的选择会自动记住。</span
      ><button class="studio-primary" @click="studio.galleryOpen = false">
        回到阅读 <StudioIcon name="arrow" :size="16" />
      </button>
    </footer>
  </dialog>
</template>
