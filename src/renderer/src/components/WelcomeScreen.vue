<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  bookState,
  openBookViaDialog,
  openBookByPath,
  openSampleBook,
  newMarkdown
} from '../composables/useBook'
import { THEMES, studio, selectTheme, currentTheme } from '../composables/useStudio'
import ThemeArtwork from './ThemeArtwork.vue'
import StudioIcon from './StudioIcon.vue'
import type { RecentBook } from '../../../shared/ipc-types'
import { readUntitledDrafts, type Draft } from '../composables/drafts'
const recents = ref<RecentBook[]>([])
const drafts = ref<Draft[]>([])
onMounted(async () => {
  try {
    recents.value = await window.api.getRecentBooks()
    drafts.value = await readUntitledDrafts()
  } catch {
    /* optional history */
  }
})
</script>
<template>
  <div class="welcome-studio">
    <header class="welcome-top">
      <span class="eyebrow">ZHUMO / A PLACE FOR THOUGHT</span
      ><button class="welcome-theme" @click="studio.galleryOpen = true">
        <StudioIcon name="palette" :size="16" />{{ currentTheme.name
        }}<StudioIcon name="chevron" :size="14" />
      </button>
    </header>
    <section class="welcome-hero">
      <div class="welcome-copy">
        <div class="welcome-label">
          <span class="little-seal">朱墨</span><span>READING ROOM — 2.0</span>
        </div>
        <h1>文字之间，<br /><em>另有天地。</em></h1>
        <p>让正文与旁注彼此照亮。<br />在自己的节奏里，读得更深。</p>
        <div class="welcome-actions">
          <button class="studio-primary" @click="openBookViaDialog">
            <StudioIcon name="open" :size="18" />打开文件</button
          ><button class="studio-text-button" @click="newMarkdown()">
            新建 Markdown <StudioIcon name="new" :size="18" /></button
          ><button class="studio-text-button" @click="openSampleBook">
            进入示范文稿 <StudioIcon name="arrow" :size="18" />
          </button>
        </div>
        <span class="welcome-drop">也可以拖到这里 · Markdown / EPUB / TXT</span>
        <p v-if="bookState.statusMessage" class="studio-error" role="status">
          {{ bookState.statusMessage }}
        </p>
      </div>
      <div class="welcome-art">
        <ThemeArtwork /><span class="welcome-art-note">{{ currentTheme.mood }}</span>
      </div>
    </section>
    <section class="welcome-lower">
      <div class="welcome-recent">
        <div v-if="drafts.length" class="untitled-drafts">
          <div class="section-kicker"><span>未保存的新文稿</span></div>
          <button
            v-for="draft in drafts"
            :key="draft.id"
            class="recent-book"
            @click="newMarkdown(draft)"
          >
            <StudioIcon name="edit" :size="18" /><span>{{
              draft.source
                .replace(/^#+\s*/, '')
                .trim()
                .slice(0, 32) || '未命名文稿'
            }}</span
            ><small>恢复编辑</small>
          </button>
        </div>
        <div class="section-kicker"><span>继续阅读</span><small>RECENTLY OPENED</small></div>
        <div v-if="!recents.length" class="recent-empty">
          <span>第一本书，从这里开始。</span>
          <p>你的文稿保留在本机，每一次打开都会记住阅读进度。</p>
        </div>
        <button
          v-for="book in recents.slice(0, 4)"
          :key="book.path"
          class="recent-book"
          @click="openBookByPath(book.path)"
        >
          <StudioIcon name="book" :size="18" /><span>{{ book.name }}</span
          ><StudioIcon name="arrow" :size="16" />
        </button>
      </div>
      <div class="welcome-spaces">
        <div class="section-kicker">
          <span>选择阅读空间</span
          ><button @click="studio.galleryOpen = true">
            浏览全部 <StudioIcon name="arrow" :size="14" />
          </button>
        </div>
        <div class="space-swatches" :style="{ '--theme-count': THEMES.length }">
          <button
            v-for="theme in THEMES"
            :key="theme.id"
            :class="{ active: studio.themeId === theme.id }"
            :aria-label="theme.name"
            :title="theme.name"
            :style="{ background: theme.bg, color: theme.color }"
            @click="selectTheme(theme.id)"
          >
            <span>{{ theme.mark }}</span
            ><small>{{ theme.name }}</small>
          </button>
        </div>
      </div>
    </section>
    <footer class="welcome-footer">
      <span>原文为墨 · 思想为朱</span><span>LOCAL FILES. OPEN POSSIBILITIES.</span>
    </footer>
  </div>
</template>
