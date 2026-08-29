<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 阅读设置浮层。
 * 所有值实时生效（CSS 变量 / data 属性）并经 saveSettings 持久化（防抖在 useSettings 内）。
 * 层级上限在松手后触发重新解析。
 * 末尾「文件关联」区块（T26）：查询 / 切换便携版自注册，浏览器预览桩下禁用。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { settings, uiState } from '../composables/useSettings'
import { bookState, reparseCurrentBook } from '../composables/useBook'
import { isMockApi } from '../dev/api-mock'
import { SETTINGS_LIMITS } from '../../../shared/ipc-types'
import type { FileAssocStatus } from '../../../shared/ipc-types'

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
const fileAssocUnavailable = isMockApi || typeof window.api === 'undefined' || window.api === null

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
    await refreshFileAssoc()
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
      void refreshFileAssoc()
      assocTimer = setInterval(() => void refreshFileAssoc(), 2000)
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (assocTimer !== undefined) clearInterval(assocTimer)
})

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
] as const

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
        <div class="sp-row">
          <span class="sp-label">主题</span>
          <div class="sp-segment" role="radiogroup" aria-label="主题">
            <button
              v-for="opt in THEME_OPTIONS"
              :key="opt.value"
              class="sp-segment-btn"
              :class="{ 'is-on': settings.theme === opt.value }"
              role="radio"
              :aria-checked="settings.theme === opt.value"
              @click="settings.theme = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
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
          <p v-if="fileAssocUnavailable" class="sp-hint">浏览器预览模式不可用</p>
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
