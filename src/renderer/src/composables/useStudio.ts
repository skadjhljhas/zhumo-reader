import { computed, reactive, watch } from 'vue'
import { newNoteJourney } from './noteJourney'

export const THEMES = [
  {
    id: 'lucent',
    name: '琉璃',
    english: 'LUCENT / THE LIGHT WITHIN',
    mood: '光穿过文字，意义留下余迹',
    detail: '晶体折射 · 流动光场 · 文字余迹',
    dark: false,
    color: '#35627d',
    bg: '#dbe6ee',
    mark: '澄'
  },
  {
    id: 'chaosheng',
    name: '潮光',
    english: 'TIDAL / AN OCEAN OF WORDS',
    mood: '日月星汉，出入于文字之海',
    detail: '沧海深蓝 · 月白潮涌 · 星汉余辉',
    dark: true,
    color: '#aac9ef',
    bg: '#081528',
    mark: '潮'
  },
  {
    id: 'paper',
    name: '白纸',
    english: 'PAPER',
    mood: '白纸黑字，只读文字',
    detail: '纯白底色 · 黑色文字 · 简洁排版',
    dark: false,
    color: '#111111',
    bg: '#ffffff',
    mark: '字'
  },
  {
    id: 'astral',
    name: '星辰',
    english: 'ASTRAL / A DISTANCE MADE OF WORDS',
    mood: '在辽阔之中，读到此刻',
    detail: '多层星野 · 时空纵深 · 思想连线',
    dark: true,
    color: '#b6d5f3',
    bg: '#060c1d',
    mark: '宙'
  },
  {
    id: 'cinnabar',
    name: '朱砂书院',
    english: 'THE VERMILION ATELIER',
    mood: '纸的温度，墨的呼吸',
    detail: '书刊版式 · 朱砂印记 · 暖纸纹理',
    dark: false,
    color: '#ae3c2a',
    bg: '#efe9dd',
    mark: '文'
  },
  {
    id: 'nocturne',
    name: '玄青静观',
    english: 'A NOCTURNE FOR THOUGHT',
    mood: '夜色深处，思想清晰',
    detail: '深海墨色 · 低眩光 · 克制留白',
    dark: true,
    color: '#d5bb8d',
    bg: '#14242c',
    mark: '思'
  },
  {
    id: 'cosmos',
    name: '星图漫游',
    english: 'THE OBSERVATORY',
    mood: '在思想的引力之间',
    detail: '星轨空间 · 光谱层次 · 坐标导航',
    dark: true,
    color: '#9ff0dd',
    bg: '#101625',
    mark: '∞'
  },
  {
    id: 'manifesto',
    name: '先锋构成',
    english: 'WORDS MAKE WORLDS',
    mood: '让文字拥有自己的声量',
    detail: '构成主义 · 巨幅字形 · 鲜明色块',
    dark: false,
    color: '#e33e28',
    bg: '#f5df53',
    mark: '字'
  },
  {
    id: 'botanical',
    name: '苔庭',
    english: 'THE BOTANICAL LIBRARY',
    mood: '万物生长，字句亦然',
    detail: '植物线描 · 森林绿 · 自然的节律',
    dark: false,
    color: '#426452',
    bg: '#e9ede2',
    mark: '生'
  },
  {
    id: 'prism',
    name: '晨雾',
    english: 'THE PRISM ROOM',
    mood: '光在留白中缓缓展开',
    detail: '半透明层次 · 几何光影 · 轻盈秩序',
    dark: false,
    color: '#6558ab',
    bg: '#eceaf4',
    mark: '光'
  }
] as const
export type ThemeId = (typeof THEMES)[number]['id']

function savedTheme(): ThemeId {
  const initial: ThemeId =
    typeof __CHAOSHENG_PREVIEW__ !== 'undefined' && __CHAOSHENG_PREVIEW__ ? 'chaosheng' : 'lucent'
  try {
    const value = localStorage.getItem('zhumo.studio.theme')
    return THEMES.find((t) => t.id === value)?.id ?? initial
  } catch {
    return initial
  }
}
function savedNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number(raw)
    return n >= min && n <= max ? n : fallback
  } catch {
    return fallback
  }
}
export const studio = reactive({
  syncPositions: (() => {
    try {
      return localStorage.getItem('zhumo.editing.positionSync') !== 'false'
    } catch {
      return true
    }
  })(),
  hoverNotes: (() => {
    try {
      return localStorage.getItem('zhumo.notes.hover') === 'true'
    } catch {
      return false
    }
  })(),
  atlasOpen: false,
  panoramaOpen: false,
  atlasNoteId: '',
  promptOpen: false,
  effectsMode: (() => {
    try {
      const saved = localStorage.getItem('zhumo.effects')
      if (saved === 'full' || saved === 'quiet' || saved === 'off') return saved
    } catch {
      /* Use the system motion preference. */
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'quiet' : 'full'
  })() as 'full' | 'quiet' | 'off',
  noteWidth: savedNumber('zhumo.note.width', 370, 280, 640),
  noteFontSize: savedNumber('zhumo.note.font', 16, 14, 24),
  peekTransparency: savedNumber('zhumo.peek.transparency', 12, 0, 90),
  themeId: savedTheme(),
  galleryOpen: false,
  searchOpen: false,
  focusMode: false,
  notesTab: 'all' as 'all' | 'focus' | 'pinned',
  pinnedLabels: new Set<string>(),
  noteJourney: newNoteJourney(),
  noteQuery: '',
  explicitFollowPause: false
})
export const currentTheme = computed(() => THEMES.find((t) => t.id === studio.themeId) ?? THEMES[0])
watch(
  () => studio.peekTransparency,
  (value) => {
    const normalized = Number.isFinite(value) ? Math.max(0, Math.min(90, Math.round(value))) : 12
    if (value !== normalized) {
      studio.peekTransparency = normalized
      return
    }
    document.documentElement.style.setProperty('--peek-opacity', String(1 - normalized / 100))
    try {
      localStorage.setItem('zhumo.peek.transparency', String(normalized))
    } catch {
      /* Keep the session setting. */
    }
  },
  { immediate: true }
)
watch(
  () => studio.syncPositions,
  (value) => {
    try {
      localStorage.setItem('zhumo.editing.positionSync', String(value))
    } catch {
      /* Keep the session preference. */
    }
  }
)
export function selectTheme(id: ThemeId): void {
  studio.themeId = id
}
export function openNoteAtlas(noteId = ''): void {
  studio.atlasNoteId = noteId
  studio.atlasOpen = true
}
export function cycleEffects(): void {
  studio.effectsMode = studio.effectsMode === 'off' ? 'full' : 'off'
}
watch(
  () => studio.hoverNotes,
  (enabled) => {
    try {
      localStorage.setItem('zhumo.notes.hover', String(enabled))
    } catch {
      /* Keep the current session preference. */
    }
  }
)
watch(
  () => studio.effectsMode,
  (mode) => {
    try {
      localStorage.setItem('zhumo.effects', mode)
    } catch {
      /* Keep the current session preference. */
    }
    document.documentElement.dataset.optics = mode
  },
  { immediate: true }
)
function applyTheme(): void {
  document.documentElement.dataset.skin = studio.themeId
  try {
    localStorage.setItem('zhumo.studio.theme', studio.themeId)
  } catch {
    /* storage unavailable */
  }
}
watch(() => studio.themeId, applyTheme)
applyTheme()
export function togglePin(label: string): void {
  if (studio.pinnedLabels.has(label)) studio.pinnedLabels.delete(label)
  else studio.pinnedLabels.add(label)
}

watch(
  () => [studio.noteWidth, studio.noteFontSize],
  () => {
    document.documentElement.style.setProperty('--note-font-size', `${studio.noteFontSize}px`)
    try {
      localStorage.setItem('zhumo.note.width', String(studio.noteWidth))
      localStorage.setItem('zhumo.note.font', String(studio.noteFontSize))
    } catch {
      /* storage unavailable */
    }
  },
  { immediate: true }
)
let pinsPath = ''
export function loadBookPins(path: string): void {
  pinsPath = ''
  try {
    const labels: unknown = JSON.parse(localStorage.getItem(`zhumo.pins:${path}`) ?? '[]')
    studio.pinnedLabels = new Set(
      Array.isArray(labels) ? labels.filter((x) => typeof x === 'string') : []
    )
  } catch {
    studio.pinnedLabels = new Set()
  }
  pinsPath = path
}
watch(
  () => [...studio.pinnedLabels],
  (labels) => {
    if (pinsPath)
      try {
        localStorage.setItem(`zhumo.pins:${pinsPath}`, JSON.stringify(labels))
      } catch {
        /* storage unavailable */
      }
  },
  { flush: 'sync' }
)
