<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 阅读设置浮层。
 * 所有值实时生效（CSS 变量 / data 属性）并经 saveSettings 持久化（防抖在 useSettings 内）。
 * 层级上限在松手后触发重新解析。
 * 末尾「文件关联」区块（T26）：查询 / 切换便携版自注册，浏览器预览桩下禁用。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import FontSettings from './FontSettings.vue'
import HdrSettings from './HdrSettings.vue'
import { studio, currentTheme } from '../composables/useStudio'
import { settings, uiState } from '../composables/useSettings'
import { bookState, reparseCurrentBook } from '../composables/useBook'
import { openAiSettings, aiState } from '../composables/aiReading'
import { chooseAnnotationMode } from '../composables/documentAnnotations'
import { aiProfileReady, AUTOMATIC_SYNTAX_CONCURRENCY } from '../../../shared/ai-types'

import { SETTINGS_LIMITS } from '../../../shared/ipc-types'
import type { FileAssocStatus } from '../../../shared/ipc-types'
import { isMockApi } from '../dev/api-mock'
const library = ref<{ path: string; available: boolean; error?: string }>({
  path: '',
  available: false
})
const libraryBusy = ref(false)
async function refreshLibrary(): Promise<void> {
  try {
    library.value = await window.api.manuscriptLocation()
  } catch (error) {
    library.value = {
      path: '',
      available: false,
      error: error instanceof Error ? error.message : '无法读取文稿位置。'
    }
  }
}
async function chooseLibrary(): Promise<void> {
  if (libraryBusy.value) return
  libraryBusy.value = true
  try {
    const next = await window.api.chooseManuscriptLocation()
    if (next) library.value = next
  } catch (error) {
    library.value.error = error instanceof Error ? error.message : '未能更改文稿位置。'
  } finally {
    libraryBusy.value = false
  }
}
async function revealLibrary(): Promise<void> {
  try {
    await window.api.revealManuscriptLocation()
  } catch (error) {
    library.value.error = error instanceof Error ? error.message : '未能打开文稿文件夹。'
  }
}

function openGallery(): void {
  close()
  studio.galleryOpen = true
}

function close(): void {
  uiState.settingsOpen = false
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function onLevelCapChange(): void {
  if (bookState.status === 'reading') void reparseCurrentBook()
}

/* ---- T26 文件关联：便携版自注册的状态行与开关 ---- */

const ASSOC_STATUS_TEXT: Record<FileAssocStatus, string> = {
  active: '已注册，指向当前程序',
  stale: '已注册，但指向其他位置的程序',
  off: '未注册'
}

/** 浏览器预览桩（mock）或无桥接的静态预览：无注册表可写，区块照常展示但开关禁用 */
const fileAssocUnavailable = true // Preview builds run alongside the installed reader.

/** 面板每次打开时查询（启动自检 / 他处解除都可能晚于本组件挂载而变化） */
const fileAssocStatus = ref<FileAssocStatus>('off')
const fileAssocBusy = ref(false)

/** stale（已注册但指向旧路径）语义上仍算「开着」，待下次启动自愈 */
const fileAssocOn = computed(
  () => fileAssocStatus.value === 'active' || fileAssocStatus.value === 'stale'
)
const fileAssocStatusText = computed(() => ASSOC_STATUS_TEXT[fileAssocStatus.value])

async function refreshFileAssoc(): Promise<void> {
  if (fileAssocUnavailable || fileAssocBusy.value) return
  try {
    fileAssocStatus.value = await window.api.fileAssocStatus()
  } catch {
    /* 查询失败维持原显示，不打断设置面板 */
  }
}

/** 开关点击：写注册表后回读状态，避免显示与实际漂移 */
async function onFileAssocToggle(): Promise<void> {
  if (fileAssocUnavailable || fileAssocBusy.value) return
  fileAssocBusy.value = true
  try {
    await window.api.fileAssocSet(!fileAssocOn.value)
    fileAssocStatus.value = await window.api.fileAssocStatus()
  } catch (error) {
    bookState.statusMessage = error instanceof Error ? error.message : String(error)
  } finally {
    fileAssocBusy.value = false
  }
}

/** 面板打开期间轻量轮询：捕获启动自检异步完成、他处解除等晚到的状态变化 */
let assocTimer: ReturnType<typeof setInterval> | undefined

watch(
  () => uiState.settingsOpen,
  (open) => {
    if (assocTimer !== undefined) {
      clearInterval(assocTimer)
      assocTimer = undefined
    }
    if (open) {
      void refreshLibrary()
      void refreshFileAssoc()
      assocTimer = setInterval(() => void refreshFileAssoc(), 2000)
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (assocTimer !== undefined) clearInterval(assocTimer)
})

const PARA_OPTIONS = [
  { value: 'indent', label: '首行缩进' },
  { value: 'spacing', label: '段间留白' }
] as const
</script>

<template>
  <Transition name="sp-fade">
    <div v-if="uiState.settingsOpen" class="sp-backdrop" aria-hidden="true" @click="close"></div>
  </Transition>

  <Transition name="sp-pop">
    <section v-if="uiState.settingsOpen" class="settings-panel" role="dialog" aria-label="阅读设置">
      <header class="sp-head">
        <h2 class="sp-title">阅读设置</h2>
        <button class="zm-icon-btn sp-close" aria-label="关闭设置" @click="close">
          <AppIcon name="close" :size="15" />
        </button>
      </header>

      <div class="sp-body">
        <FontSettings />
        <HdrSettings />
        <fieldset class="selection-preferences manuscript-location-settings">
          <legend>默认文稿文件夹</legend>
          <p class="sp-hint" style="overflow-wrap: anywhere">
            {{ library.path || '尚未取得位置' }}
          </p>
          <p v-if="library.error" class="sp-hint" role="status">{{ library.error }}</p>
          <div class="ai-result-actions">
            <button :disabled="isMockApi || !library.available" @click="revealLibrary">
              打开文件夹</button
            ><button :disabled="isMockApi || libraryBusy" @click="chooseLibrary">
              选择文稿文件夹
            </button>
          </div>
          <p class="sp-hint">打开与另存默认使用此位置。更换位置不会移动或删除原有文稿。</p>
        </fieldset>
        <fieldset class="selection-preferences">
          <legend>选中文字后</legend>
          <label><input v-model="settings.selectionNote" type="checkbox" />写用户注释</label>
          <label><input v-model="settings.selectionExplain" type="checkbox" />自动解释</label>
          <label><input v-model="settings.selectionCopy" type="checkbox" />自动复制</label>
          <p class="sp-hint">
            可任意组合。全部关闭时只选字；复制不弹窗。注释中 Enter 保存，Shift+Enter 换行。
          </p>
        </fieldset>
        <div class="sp-row">
          <span class="sp-label">AI 阅读</span>
          <button class="theme-settings-button" @click="openAiSettings()">
            模型、密钥与系统提示词
          </button>
        </div>
        <div class="sp-row">
          <span class="sp-label">文本标注</span>
          <div class="sp-segment" role="radiogroup" aria-label="文本标注方式">
            <button
              class="sp-segment-btn"
              :class="{ 'is-on': settings.annotationMode === 'follow' }"
              role="radio"
              :aria-checked="settings.annotationMode === 'follow'"
              @click="chooseAnnotationMode('follow')"
            >
              跟随阅读
            </button>
            <button
              class="sp-segment-btn"
              :class="{ 'is-on': settings.annotationMode === 'document' }"
              role="radio"
              :aria-checked="settings.annotationMode === 'document'"
              @click="chooseAnnotationMode('document')"
            >
              全文标注
            </button>
          </div>
        </div>
        <fieldset class="selection-preferences">
          <legend>句法之光</legend>
          <label
            ><input
              v-model="settings.automaticSyntax"
              :disabled="settings.annotationMode === 'document'"
              type="checkbox"
            />随阅读自动分析句法</label
          >
          <label class="sp-row">
            <span class="sp-label">开始标注前停留</span>
            <input
              v-model.number="settings.automaticSyntaxWaitSeconds"
              type="range"
              aria-label="自动标注等待时间"
              :aria-valuetext="settings.automaticSyntaxWaitSeconds + ' 秒'"
              :min="SETTINGS_LIMITS.automaticSyntaxWaitSeconds.min"
              :max="SETTINGS_LIMITS.automaticSyntaxWaitSeconds.max"
              :step="SETTINGS_LIMITS.automaticSyntaxWaitSeconds.step"
            />
            <span>{{ settings.automaticSyntaxWaitSeconds }} 秒</span>
          </label>
          <p class="sp-hint">
            句段连续可见 {{ settings.automaticSyntaxWaitSeconds }} 秒后开始分析，可设为 1–15
            秒。最多 {{ AUTOMATIC_SYNTAX_CONCURRENCY }} 个句段并行，已完成的结果优先复用缓存。
          </p>
          <p v-if="!aiProfileReady(aiState.profiles.syntax)" class="sp-hint">
            句法模型尚未连接，可在上方配置。
          </p>
          <p v-else-if="aiState.profiles.syntax.keyStorage === 'unavailable'" class="sp-hint">
            句法模型的密钥无法读取，请在上方模型设置中处理。
          </p>
        </fieldset>
        <div class="sp-row">
          <span class="sp-label">主题</span>
          <button class="theme-settings-button" @click="openGallery">
            {{ currentTheme.name }} · 更换阅读空间
          </button>
        </div>

        <div class="sp-row">
          <label for="peek-transparency-setting" class="sp-label"
            >就地注释整体透明度<em class="sp-value">{{ studio.peekTransparency }}%</em></label
          >
          <input
            id="peek-transparency-setting"
            v-model.number="studio.peekTransparency"
            class="sp-slider"
            type="range"
            min="0"
            max="90"
            step="1"
            aria-label="就地注释整体透明度"
            :aria-valuetext="`${studio.peekTransparency}%`"
          />
          <p class="sp-hint">整块注页一起淡去，注释文字另用一色，与正文区分。</p>
        </div>
        <div class="sp-row">
          <span class="sp-label"
            >字号<em class="sp-value">{{ settings.fontSize }} px</em></span
          >
          <input
            v-model.number="settings.fontSize"
            class="sp-slider"
            type="range"
            :min="SETTINGS_LIMITS.fontSize.min"
            :max="SETTINGS_LIMITS.fontSize.max"
            :step="SETTINGS_LIMITS.fontSize.step"
            aria-label="正文字号"
          />
        </div>

        <div class="sp-row">
          <span class="sp-label"
            >行距<em class="sp-value">{{ settings.lineHeight.toFixed(2) }}</em></span
          >
          <input
            v-model.number="settings.lineHeight"
            class="sp-slider"
            type="range"
            :min="SETTINGS_LIMITS.lineHeight.min"
            :max="SETTINGS_LIMITS.lineHeight.max"
            :step="SETTINGS_LIMITS.lineHeight.step"
            aria-label="正文行距"
          />
        </div>

        <div class="sp-row">
          <span class="sp-label"
            >每行字数<em class="sp-value">{{ settings.contentWidth }} 字</em></span
          >
          <input
            v-model.number="settings.contentWidth"
            class="sp-slider"
            type="range"
            :min="SETTINGS_LIMITS.contentWidth.min"
            :max="SETTINGS_LIMITS.contentWidth.max"
            :step="SETTINGS_LIMITS.contentWidth.step"
            aria-label="每行字数"
          />
        </div>

        <div class="sp-row">
          <span class="sp-label">段落风格</span>
          <div class="sp-segment" role="radiogroup" aria-label="段落风格">
            <button
              v-for="opt in PARA_OPTIONS"
              :key="opt.value"
              class="sp-segment-btn"
              :class="{ 'is-on': settings.paragraphStyle === opt.value }"
              role="radio"
              :aria-checked="settings.paragraphStyle === opt.value"
              @click="settings.paragraphStyle = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>

        <div class="sp-row">
          <span class="sp-label"
            >旁注字号<em class="sp-value">{{ studio.noteFontSize }} px</em></span
          >
          <input
            v-model.number="studio.noteFontSize"
            class="sp-slider"
            type="range"
            min="14"
            max="24"
            step="1"
            aria-label="旁注字号"
          />
        </div>
        <div class="sp-row sp-row-inline">
          <span class="sp-label">就地注释</span>
          <button
            class="sp-switch"
            :class="{ 'is-on': studio.hoverNotes }"
            role="switch"
            :aria-checked="studio.hoverNotes"
            aria-label="就地注释开关"
            @click="studio.hoverNotes = !studio.hoverNotes"
          >
            <span class="sp-switch-knob"></span>
          </button>
        </div>
        <p class="sp-hint">关闭后，悬停正文注号会连线到页边，并平滑对齐对应旁注。</p>
        <div class="sp-row sp-row-inline">
          <span class="sp-label">注释侧栏</span>
          <button
            class="sp-switch"
            :class="{ 'is-on': settings.sidebarVisible }"
            role="switch"
            :aria-checked="settings.sidebarVisible"
            aria-label="注释侧栏开关"
            @click="settings.sidebarVisible = !settings.sidebarVisible"
          >
            <span class="sp-switch-knob"></span>
          </button>
        </div>

        <div class="sp-row">
          <span class="sp-label">
            注释层级上限<em class="sp-value">{{ settings.noteLevelCap }} 层</em>
          </span>
          <input
            v-model.number="settings.noteLevelCap"
            class="sp-slider"
            type="range"
            :min="SETTINGS_LIMITS.noteLevelCap.min"
            :max="SETTINGS_LIMITS.noteLevelCap.max"
            :step="SETTINGS_LIMITS.noteLevelCap.step"
            aria-label="注释层级上限"
            @change="onLevelCapChange"
          />
          <p class="sp-hint">修改后将以新上限重新解析本书</p>
        </div>

        <!-- T26 文件关联：便携版自注册状态与开关（浏览器预览下展示但禁用） -->
        <div class="sp-row">
          <div class="sp-assoc-line">
            <span class="sp-label">文件关联</span>
            <button
              class="sp-switch"
              :class="{ 'is-on': fileAssocOn }"
              role="switch"
              :aria-checked="fileAssocOn"
              aria-label="文件关联开关"
              :disabled="fileAssocUnavailable || fileAssocBusy"
              @click="onFileAssocToggle"
            >
              <span class="sp-switch-knob"></span>
            </button>
          </div>
          <p class="sp-hint">在 .md / .markdown 的右键「打开方式」中显示朱墨</p>
          <p class="sp-assoc-status" :class="{ 'is-off': !fileAssocOn }" role="status">
            {{ fileAssocStatusText }}
          </p>
          <p v-if="fileAssocUnavailable" class="sp-hint">预览版不更改系统文件关联</p>
        </div>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.sp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.settings-panel {
  position: fixed;
  top: calc(var(--toolbar-h) + 10px);
  right: 14px;
  width: 304px;
  z-index: 41;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-soft);
  overflow: hidden;
}

.sp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 10px 12px 18px;
  border-bottom: 1px solid var(--line);
}

.sp-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.sp-close {
  width: 28px;
  height: 28px;
}

.sp-body {
  padding: 8px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: min(80vh, 660px);
  overflow-y: auto;
}

.sp-row {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding-top: 10px;
}

.sp-row-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.sp-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-2);
  letter-spacing: 0.05em;
}

.sp-value {
  font-style: normal;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.sp-hint {
  margin: -2px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}

/* 分段选择器 */
.sp-segment {
  display: flex;
  background: var(--hover-bg);
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}
.sp-segment-btn {
  flex: 1;
  padding: 6px 0;
  font-size: 12.5px;
  border-radius: 6px;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}
.sp-segment-btn:hover {
  color: var(--text);
}
.sp-segment-btn.is-on {
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

/* 滑杆 */
.sp-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 22px;
  background: transparent;
  cursor: pointer;
}
.sp-slider::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: var(--line-strong);
}
.sp-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  margin-top: -6px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 2px solid var(--accent);
  transition: transform var(--dur-fast) var(--ease-out);
}
.sp-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}
.sp-slider::-moz-range-track {
  height: 3px;
  border-radius: 2px;
  background: var(--line-strong);
}
.sp-slider::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 2px solid var(--accent);
}

/* 开关 */
.sp-switch {
  width: 40px;
  height: 23px;
  border-radius: 999px;
  background: var(--line-strong);
  position: relative;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.sp-switch.is-on {
  background: var(--accent);
}
.sp-switch-knob {
  position: absolute;
  top: 2.5px;
  left: 2.5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-elevated);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  transition: transform var(--dur-fast) var(--ease-out);
}
.sp-switch.is-on .sp-switch-knob {
  transform: translateX(17px);
}

/* 文件关联（T26）：标题行 + 状态行 */
.sp-assoc-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.sp-assoc-status {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
  letter-spacing: 0.03em;
}

.sp-assoc-status.is-off {
  color: var(--text-3);
}

.sp-switch:disabled {
  cursor: default;
  opacity: 0.45;
}

.sp-pop-enter-active,
.sp-pop-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
.sp-pop-enter-from,
.sp-pop-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

.sp-fade-enter-active,
.sp-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.sp-fade-enter-from,
.sp-fade-leave-to {
  opacity: 0;
}
</style>
