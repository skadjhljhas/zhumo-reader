<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 应用骨架。
 * 状态机：welcome → loading → reading。
 * 三栏：目录抽屉 | 正文列 | 注释侧栏；工具栏置顶、状态栏垫底、滚动容器互相隔离。
 * 整窗拖放开书（dragenter/leave 计数避免闪烁）。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import WelcomeScreen from './components/WelcomeScreen.vue'
import LoadingScreen from './components/LoadingScreen.vue'
import ReaderView from './components/ReaderView.vue'
import NotesSidebar from './components/NotesSidebar.vue'
import TocDrawer from './components/TocDrawer.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PdfExportDialog from './components/PdfExportDialog.vue'
import StatusBar from './components/StatusBar.vue'
import StudioRail from './components/StudioRail.vue'
import ThemeGallery from './components/ThemeGallery.vue'
import SearchPanel from './components/SearchPanel.vue'
import NotePeek from './components/NotePeek.vue'
import ReadingSelection from './components/ReadingSelection.vue'
import NoteHoverGuide from './components/NoteHoverGuide.vue'
import ReadingEcho from './components/ReadingEcho.vue'
import AiReadingPanel from './components/AiReadingPanel.vue'
import AiSettings from './components/AiSettings.vue'
import SyntaxLight from './components/SyntaxLight.vue'
import AutomaticSyntaxLight from './components/AutomaticSyntaxLight.vue'
import NoteRangeLight from './components/NoteRangeLight.vue'
import DiagramLayer from './components/DiagramLayer.vue'
const SourceEditor = defineAsyncComponent(() => import('./components/SourceEditor.vue'))
const ReadingAtmosphere = defineAsyncComponent(() => import('./components/ReadingAtmosphere.vue'))
const ChaoshengAtmosphere = defineAsyncComponent(
  () => import('./components/ChaoshengAtmosphere.vue')
)
const AnnotationGuide = defineAsyncComponent(() => import('./components/AnnotationGuide.vue'))
const NoteAtlas = defineAsyncComponent(() => import('./components/NoteAtlas.vue'))
const BookPanorama = defineAsyncComponent(() => import('./components/BookPanorama.vue'))
const ChaoshengMemory = defineAsyncComponent(() => import('./components/ChaoshengMemory.vue'))
import LeaveEditorDialog from './components/LeaveEditorDialog.vue'
import FormulaInspector from './components/FormulaInspector.vue'
import { studio } from './composables/useStudio'
import { documentSession, isDirty, guardDocumentAction } from './composables/documentSession'
import {
  saveCurrentDocument,
  restoreDraft,
  ignoreRecovery,
  flushDraft
} from './composables/useEditor'
import {
  bookState,
  openBookByFile,
  openBookByPath,
  openBookFromLaunchQuery,
  newMarkdown
} from './composables/useBook'
import { bookFileUrl, bookPathFromUrl, findBookHash } from './composables/bookResources'
import { requestSearchLanding } from './composables/readerStore'
import { loadSettings, settings, uiState } from './composables/useSettings'
import { installReadingFieldSession } from './composables/readingFieldSession'

const status = computed(() => bookState.status)
let offClose: (() => void) | undefined
let stopReadingField: (() => void) | undefined
function onDocumentLink(event: MouseEvent): void {
  if (event.defaultPrevented) return
  if (!(event.target instanceof Element)) return
  const anchor = event.target.closest<HTMLAnchorElement>(
    '.section-body a[href], .zmu-note-body a[href]'
  )
  if (!anchor || !bookState.payload) return
  const href = anchor.getAttribute('href') ?? ''
  const base = bookFileUrl(bookState.payload.path)
  if (href.startsWith('#')) {
    if (anchor.closest('.draft-preview')) return
    event.preventDefault()
    const target = bookState.book && findBookHash(bookState.book, href)
    if (target) requestSearchLanding(target.sectionId, target.blockIndex)
    return
  }
  if (!base) return
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return
  }
  const path = bookPathFromUrl(url)
  if (!path || !/\.(md|markdown|txt|epub)$/i.test(path)) return
  event.preventDefault()
  guardDocumentAction(() => {
    void openBookByPath(path).then(async () => {
      await nextTick()
      if (url.hash && bookState.book && bookState.payload?.path === path) {
        const target = findBookHash(bookState.book, url.hash)
        if (target) requestSearchLanding(target.sectionId, target.blockIndex)
      }
    })
  })
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (isDirty.value) {
    void flushDraft()
    event.preventDefault()
    event.returnValue = ''
  }
}
function onShortcut(event: KeyboardEvent): void {
  if (document.querySelector('dialog[open]')) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    uiState.settingsOpen = false
    void newMarkdown()
    return
  }
  if (event.key.toLowerCase() === 's' && bookState.payload) {
    event.preventDefault()
    void saveCurrentDocument(event.shiftKey)
  }
  if (event.key.toLowerCase() === 'f' && documentSession.mode === 'read') {
    event.preventDefault()
    studio.searchOpen = true
  }
  if (event.key === ',') {
    event.preventDefault()
    uiState.settingsOpen = !uiState.settingsOpen
  }
}

/* ---- 整窗拖放 ---- */
const dragOver = ref(false)
let dragDepth = 0

function hasFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  dragDepth++
  dragOver.value = true
}

function onDragOver(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}

function onDrop(ev: DragEvent): void {
  if (!hasFiles(ev)) return
  ev.preventDefault()
  dragDepth = 0
  dragOver.value = false
  const file = ev.dataTransfer?.files?.[0]
  if (file) void openBookByFile(file)
}

onMounted(() => {
  stopReadingField = installReadingFieldSession()
  document.addEventListener('click', onDocumentLink)
  void loadSettings()
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('keydown', onShortcut)
  offClose = window.api?.onCloseRequested?.(() =>
    guardDocumentAction(() => {
      void window.api.closeConfirmed()
    })
  )
  // T20：?book= 启动参数自动开书（多窗口 / 文件关联传书）；
  // mock 预览与无桥接环境下内部门控忽略，失败时优雅回退欢迎页
  openBookFromLaunchQuery()
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  stopReadingField?.()
  document.removeEventListener('click', onDocumentLink)
  offClose?.()
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('keydown', onShortcut)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <PdfExportDialog />
  <ReadingAtmosphere v-if="['lucent', 'astral'].includes(studio.themeId)" />
  <ChaoshengAtmosphere v-if="studio.themeId === 'chaosheng'" />
  <ReadingEcho v-if="['lucent', 'chaosheng'].includes(studio.themeId)" />
  <div class="studio-frame" :class="{ 'focus-space': studio.focusMode }">
    <StudioRail />
    <div class="app-shell">
      <div v-if="documentSession.recovery" class="recovery-banner" role="status">
        <span>发现这份文档的未保存草稿</span>
        <select
          v-if="documentSession.recoveryAlternatives.length > 1"
          :value="documentSession.recovery.id"
          aria-label="选择恢复草稿"
          @change="
            documentSession.recovery =
              documentSession.recoveryAlternatives.find(
                (d) => d.id === ($event.target as HTMLSelectElement).value
              ) ?? null
          "
        >
          <option
            v-for="draft in documentSession.recoveryAlternatives"
            :key="draft.id"
            :value="draft.id"
          >
            {{ new Date(draft.updatedAt).toLocaleString() }} · {{ draft.source.length }} 字符
          </option></select
        ><button @click="restoreDraft">恢复编辑</button
        ><button @click="ignoreRecovery">忽略草稿</button>
      </div>
      <div class="app-main">
        <TocDrawer v-if="status === 'reading' && documentSession.mode === 'read'" />
        <main class="app-center">
          <WelcomeScreen v-if="status === 'welcome'" />
          <LoadingScreen v-else-if="status === 'loading'" />
          <template v-else>
            <ReaderView v-show="documentSession.mode === 'read'" :key="bookState.payload?.path" />
            <SourceEditor v-if="documentSession.mode === 'edit'" />
          </template>
        </main>
        <NotesSidebar
          v-if="status === 'reading' && settings.sidebarVisible && documentSession.mode === 'read'"
        />
      </div>

      <StatusBar v-if="status === 'reading'" />
      <SettingsPanel />
      <AiReadingPanel />
      <AiSettings />
      <SyntaxLight />
      <AutomaticSyntaxLight />
      <NoteRangeLight />
      <ThemeGallery />
      <SearchPanel />
      <ChaoshengMemory v-if="['lucent', 'chaosheng'].includes(studio.themeId)" />
      <LeaveEditorDialog />
      <FormulaInspector />
      <DiagramLayer v-if="bookState.book" />
      <AnnotationGuide />
      <NoteAtlas v-if="studio.atlasOpen && bookState.book && documentSession.mode === 'read'" />
      <NotePeek v-if="bookState.book && documentSession.mode === 'read'" />
      <ReadingSelection v-if="bookState.book && documentSession.mode === 'read'" />
      <NoteHoverGuide v-if="bookState.book && documentSession.mode === 'read'" />
      <BookPanorama
        v-if="studio.panoramaOpen && bookState.book && documentSession.mode === 'read'"
      />

      <Transition name="drop-fade">
        <div v-if="dragOver" class="drop-overlay" aria-hidden="true">
          <div class="drop-frame">
            <p class="drop-text">松手以打开</p>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}

.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  /* 极窄视口：正文列保底 320px，三栏总宽超出时允许横向滚动，避免正文被侧栏挤没 */
  overflow: hidden;
  position: relative;
}

.app-center {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  height: 100%;
}

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(3px);
}

.drop-frame {
  width: min(480px, 78vw);
  height: min(260px, 52vh);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px dashed var(--accent);
  border-radius: 14px;
  background: var(--accent-soft);
}

.drop-text {
  margin: 0;
  font-size: 17px;
  letter-spacing: 0.3em;
  color: var(--accent);
}

.drop-fade-enter-active,
.drop-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.drop-fade-enter-from,
.drop-fade-leave-to {
  opacity: 0;
}
</style>
