<script setup lang="ts">
import { computed } from 'vue'
import { bookState } from '../composables/useBook'
import { currentTheme } from '../composables/useStudio'
import ThemeArtwork from './ThemeArtwork.vue'
import { searchableText } from '../composables/searchText'
const title = computed(() => bookState.book?.title || bookState.payload?.title || '未命名文稿')
const stats = computed(() => bookState.book?.stats)
const titleAddress = computed(() => {
  for (const section of bookState.book?.sections ?? []) {
    const heading = section.html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0]
    if (!heading) continue
    const template = document.createElement('template')
    template.innerHTML = heading
    const inline = template.content.querySelector<HTMLElement>('h1 [data-source-inline]')
    if (inline && searchableText(inline, true) === title.value)
      return { section: section.id, inline: inline.dataset.sourceInline }
  }
  return undefined
})
</script>
<template>
  <header class="document-overture">
    <div class="overture-copy">
      <div class="overture-eyebrow">
        <span class="little-seal">朱墨</span><span>{{ currentTheme.english }}</span>
      </div>
      <h1 :data-title-section="titleAddress?.section" :data-title-inline="titleAddress?.inline">
        {{ title }}
      </h1>
      <div class="overture-rule"></div>
      <p class="overture-meta">
        <span>{{ (stats?.chars ?? 0).toLocaleString() }} 字</span><i></i
        ><span>{{ stats?.noteCount ?? 0 }} 条旁注</span><i></i
        ><span>约 {{ Math.max(1, Math.ceil((stats?.chars ?? 0) / 500)) }} 分钟</span>
      </p>
    </div>
    <ThemeArtwork compact /><span class="overture-folio">VOL. 02 / READING ROOM</span>
  </header>
</template>
