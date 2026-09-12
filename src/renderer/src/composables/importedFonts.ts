import { reactive } from 'vue'
import type { ImportedFont, Settings } from '../../../shared/ipc-types'
export const fontState = reactive({ fonts: [] as ImportedFont[], error: '', busy: false })
const loaded = new Map<string, Promise<FontFace>>()
let generation = 0
async function face(id: string, bytes?: Uint8Array): Promise<FontFace> {
  let pending = loaded.get(id)
  if (!pending) {
    pending = (async () => {
      const data = bytes ?? (await window.api.readFont(id))
      const font = new FontFace('ZhuMoFont_' + id, new Uint8Array(data).buffer)
      await font.load()
      document.fonts.add(font)
      return font
    })()
    loaded.set(id, pending)
    pending.catch(() => loaded.delete(id))
  }
  return pending
}
export async function refreshFonts(): Promise<void> {
  try {
    fontState.fonts = await window.api.listFonts()
  } catch {
    fontState.error = '无法读取导入的字体。'
  }
}
export async function importFont(): Promise<string | null> {
  fontState.busy = true
  fontState.error = ''
  try {
    const result = await window.api.importFont()
    if (!result) return null
    await face(result.font.id, result.data)
    await refreshFonts()
    return result.font.id
  } catch (error) {
    fontState.error = error instanceof Error ? error.message : '无法加载字体。'
    if (/font|decode|invalid|OTS/i.test(fontState.error))
      fontState.error = '字体解析失败。可换用同一字体的 TTF、OTF、WOFF 或 WOFF2 文件。'
    return null
  } finally {
    fontState.busy = false
  }
}
export async function applyFonts(
  settings: Pick<Settings, 'uiFont' | 'bodyFont' | 'noteFont'>
): Promise<void> {
  const current = ++generation
  const roles = [
    ['uiFont', '--ui-font', "'Segoe UI', 'Microsoft YaHei UI', sans-serif"],
    ['bodyFont', '--font-body', "'Noto Serif SC', 'Songti SC', serif"],
    ['noteFont', '--font-note', "'LXGW WenKai', 'Noto Serif SC', serif"]
  ] as const
  await Promise.all(
    roles.map(async ([key, property, fallback]) => {
      let id = settings[key]
      try {
        if (id) await face(id)
      } catch {
        if (current === generation) fontState.error = '部分字体未能加载，已使用备用字体。'
        id = ''
      }
      if (current !== generation) return
      document.documentElement.style.setProperty(
        property,
        (id ? `"ZhuMoFont_${id}", ` : '') + fallback
      )
      document.documentElement.toggleAttribute('data-custom-' + key, Boolean(id))
    })
  )
  if (current === generation) window.dispatchEvent(new Event('zhumo-fonts-changed'))
}
