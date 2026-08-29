/**
 * 朱墨 ZhuMo —— 设置状态（单例 composable）。
 *
 * 职责：加载/保存/实时应用设置。
 * 应用方式：全部落到 <html> 的 CSS 变量与 data-* 属性 —
 *   --reader-font-size / --reader-line-height / --reader-width
 *   data-theme="light|dark"（auto 由 matchMedia 解析，切换无闪烁）
 *   data-paragraph-style="indent|spacing"
 * 另把最新设置镜像进 localStorage，下次启动在异步 IPC 返回前先应用缓存，
 * 避免主题闪烁。
 */
import { reactive, watch } from 'vue'
import { clampSettings, DEFAULT_SETTINGS } from '../../../shared/ipc-types'
import type { Settings } from '../../../shared/ipc-types'

const LS_CACHE = 'zhumo.settings.v1'

export const settings = reactive<Settings>({ ...DEFAULT_SETTINGS })

/** 纯 UI 的瞬态（不持久化） */
export const uiState = reactive({
  tocOpen: true,
  settingsOpen: false
})

let loaded = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')

function resolvedTheme(): 'light' | 'dark' {
  if (settings.theme === 'auto') return darkMedia.matches ? 'dark' : 'light'
  return settings.theme
}

/** 把当前设置应用到文档根元素 */
export function applySettings(): void {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme()
  root.dataset.paragraphStyle = settings.paragraphStyle
  root.style.setProperty('--reader-font-size', `${settings.fontSize}px`)
  root.style.setProperty('--reader-line-height', String(settings.lineHeight))
  root.style.setProperty('--reader-width', String(settings.contentWidth))
}

darkMedia.addEventListener('change', () => {
  if (settings.theme === 'auto') applySettings()
})

/**
 * 启动时先同步应用 localStorage 缓存（IPC 返回前防闪烁），main.ts 调用。
 * 缓存值可能被外部工具或旧版本写入越界值，统一经 clampSettings 钳制后再应用。
 */
export function applyCachedSettings(): void {
  try {
    const raw = localStorage.getItem(LS_CACHE)
    if (!raw) {
      applySettings()
      return
    }
    const cached = JSON.parse(raw) as Partial<Settings>
    Object.assign(settings, clampSettings({ ...DEFAULT_SETTINGS, ...cached }))
  } catch {
    /* 缓存损坏时静默回落默认 */
  }
  applySettings()
}

/** 从桥接层加载设置（启动时调用一次；返回值同样过钳制，双保险） */
export async function loadSettings(): Promise<void> {
  try {
    const remote = await window.api.getSettings()
    Object.assign(settings, clampSettings({ ...DEFAULT_SETTINGS, ...remote }))
  } catch (err) {
    console.warn('[zhumo] 设置读取失败，使用默认值：', err)
  }
  loaded = true
  applySettings()
}

function persist(): void {
  const snapshot: Settings = { ...settings }
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify(snapshot))
  } catch {
    /* ignore */
  }
  if (!loaded) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.api.saveSettings({ ...settings }).catch((err) => {
      console.warn('[zhumo] 设置保存失败：', err)
    })
  }, 250)
}

// 任何设置变化：立即应用 + 防抖持久化
watch(settings, () => {
  applySettings()
  persist()
})
