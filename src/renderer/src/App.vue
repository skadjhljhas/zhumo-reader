<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 应用骨架。
 * 状态机：welcome → loading → reading。
 * 三栏：目录抽屉 | 正文列 | 注释侧栏；工具栏置顶、状态栏垫底、滚动容器互相隔离。
 * 整窗拖放开书（dragenter/leave 计数避免闪烁）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppToolbar from './components/AppToolbar.vue'
import WelcomeScreen from './components/WelcomeScreen.vue'
import LoadingScreen from './components/LoadingScreen.vue'
import ReaderView from './components/ReaderView.vue'
import NotesSidebar from './components/NotesSidebar.vue'
import TocDrawer from './components/TocDrawer.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusBar from './components/StatusBar.vue'
import { bookState, openBookByFile, openBookFromLaunchQuery } from './composables/useBook'
import { loadSettings, settings } from './composables/useSettings'

const status = computed(() => bookState.status)

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
  void loadSettings()
  // T20：?book= 启动参数自动开书（多窗口 / 文件关联传书）；
  // mock 预览与无桥接环境下内部门控忽略，失败时优雅回退欢迎页
  openBookFromLaunchQuery()
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <div class="app-shell">
    <AppToolbar v-if="status !== 'welcome'" />

    <div class="app-main">
      <TocDrawer v-if="status === 'reading'" />
      <main class="app-center">
        <WelcomeScreen v-if="status === 'welcome'" />
        <LoadingScreen v-else-if="status === 'loading'" />
        <ReaderView v-else />
      </main>
      <NotesSidebar v-if="status === 'reading' && settings.sidebarVisible" />
    </div>

    <StatusBar v-if="status === 'reading'" />
    <SettingsPanel />

    <Transition name="drop-fade">
      <div v-if="dragOver" class="drop-overlay" aria-hidden="true">
        <div class="drop-frame">
          <p class="drop-text">松手以打开</p>
        </div>
      </div>
    </Transition>
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
  overflow-x: auto;
}

.app-center {
  flex: 1;
  min-width: 320px;
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
