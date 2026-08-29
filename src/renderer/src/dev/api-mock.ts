/**
 * 朱墨 ZhuMo —— 浏览器预览桩。
 *
 * 仅在开发模式（vite dev）或 URL 带 ?mock=1 显式开启（如 4175 静态预览）时注入；
 * 生产应用不再有静默降级链：preload 桥接故障时 window.api 缺失会自然报错，
 * 而不是无声进入演示书。
 *
 * - openBookDialog → 拉取 out/renderer/public 下的演示书（?book= 选择，默认《精神现象学·序言》）
 * - readBook → 演示书路径 / 拖放暂存的 File 对象 / 其余路径报中文错误
 * - saveProgress / getProgress / saveSettings / getSettings / 最近列表 → localStorage
 * - 默认设置与钳制直接复用 shared/ipc-types 的单一事实源
 */
import { clampSettings, DEFAULT_SETTINGS } from '../../../shared/ipc-types'
import type {
  BookPayload,
  Progress,
  RecentBook,
  Settings,
  ZhuMoApi
} from '../../../shared/ipc-types'

/**
 * 演示书注册表：键即 URL 查询参数 ?book=<key>。
 * phg 为默认书（无参数时使用，保持向后兼容）；其余供压测/E2E 选择。
 */
interface DemoBook {
  file: string
  path: string
  title: string
}

const DEMO_BOOKS: Record<string, DemoBook> = {
  phg: { file: 'phg-sample.md', path: '/demo/精神现象学·序言.md', title: '精神现象学·序言' },
  'stress-50w': { file: 'stress-50w.md', path: '/demo/stress-50w.md', title: '压测书·五十万字' },
  'edge-cases': { file: 'edge-cases.md', path: '/demo/edge-cases.md', title: '边界用例集' }
}

/** 当前演示书：?book= 已注册则用之，否则默认 phg */
const demoBook: DemoBook = (() => {
  try {
    const key = new URLSearchParams(window.location.search).get('book')
    return (key !== null && DEMO_BOOKS[key]) || DEMO_BOOKS.phg
  } catch {
    return DEMO_BOOKS.phg
  }
})()

const DEMO_PATH = demoBook.path
const DEMO_TITLE = demoBook.title
const LS_SETTINGS = 'zhumo.settings.v1'
const LS_PROGRESS = 'zhumo.mock.progress.v1'
const LS_RECENTS = 'zhumo.mock.recents.v1'

/** 拖入窗口的 File 对象暂存（浏览器拿不到磁盘路径，用伪路径指代） */
const droppedFiles = new Map<string, File>()

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式等场景下静默失败 */
  }
}

async function fetchBook(book: DemoBook): Promise<BookPayload> {
  const url = `${import.meta.env.BASE_URL}demo/${book.file}`
  const t0 = performance.now()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`演示书加载失败（HTTP ${res.status}）`)
  const content = await res.text()
  // mock 阶段探针：供压测/E2E 从 console 观测 fetch 耗时与书体量
  console.info(
    `[zhumo-mock] 演示书就绪：${book.title}（${content.length} 字符，fetch 耗时 ${Math.round(performance.now() - t0)}ms）`
  )
  return { path: book.path, content, title: book.title }
}

function fetchDemo(): Promise<BookPayload> {
  return fetchBook(demoBook)
}

function touchRecent(path: string, name: string): void {
  const list = readJson<RecentBook[]>(LS_RECENTS, [])
  const next = [
    { path, name, lastOpenedAt: Date.now() },
    ...list.filter((r) => r.path !== path)
  ].slice(0, 12)
  writeJson(LS_RECENTS, next)
}

const mock: ZhuMoApi = {
  async openBookDialog() {
    const payload = await fetchDemo()
    touchRecent(payload.path, payload.title)
    return payload
  },

  async readBook(path: string) {
    // 任何已注册演示书路径均可读（最近列表多条目 / ?book= 切换共用同一通道）
    const book = Object.values(DEMO_BOOKS).find((b) => b.path === path)
    if (book) {
      // 与主进程 ReadBook 行为对齐（T22）：按路径开书同样记入最近列表
      touchRecent(book.path, book.title)
      return fetchBook(book)
    }
    const file = droppedFiles.get(path)
    if (file) {
      const content = await file.text()
      const title = file.name.replace(/\.(md|markdown|txt)$/i, '')
      touchRecent(path, title)
      return { path, content, title }
    }
    throw new Error('浏览器预览模式无法读取磁盘路径，请拖入文件或打开演示书')
  },

  async saveProgress(path: string, progress: Progress) {
    const map = readJson<Record<string, Progress>>(LS_PROGRESS, {})
    map[path] = progress
    writeJson(LS_PROGRESS, map)
  },

  async getProgress(path: string) {
    const map = readJson<Record<string, Progress>>(LS_PROGRESS, {})
    return map[path] ?? null
  },

  async saveSettings(settings: Settings) {
    writeJson(LS_SETTINGS, settings)
  },

  async getSettings() {
    // 读回值可能被旧版本或外部写入越界，统一过钳制（与主进程同一契约）
    return clampSettings({ ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(LS_SETTINGS, {}) })
  },

  async getRecentBooks() {
    const list = readJson<RecentBook[]>(LS_RECENTS, [])
    if (list.length === 0) {
      const seed: RecentBook[] = [{ path: DEMO_PATH, name: DEMO_TITLE, lastOpenedAt: Date.now() }]
      writeJson(LS_RECENTS, seed)
      return seed
    }
    return list
  },

  async removeRecent(path: string) {
    const list = readJson<RecentBook[]>(LS_RECENTS, [])
    writeJson(
      LS_RECENTS,
      list.filter((r) => r.path !== path)
    )
  },

  async getPathForFile(file: File) {
    const pseudo = `browser-file://${Date.now()}/${file.name}`
    droppedFiles.set(pseudo, file)
    return pseudo
  },

  // 浏览器预览无真实文件关联：状态恒 off，开关为空操作（真实实现见 src/main/file-assoc.ts）
  async fileAssocStatus() {
    return 'off'
  },

  async fileAssocSet(enabled: boolean) {
    void enabled // 预览桩：无注册表可写（保留参数对齐 ZhuMoApi 签名）
  }
}

/** mock 启用门控：仅开发模式，或 URL 显式带 ?mock=1（4175 静态预览等场景） */
function isMockEnabled(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1'
  } catch {
    return false
  }
}

/** window.api 缺失时注入 mock；返回是否已注入（供界面提示「预览模式」）。
 *  门控不满足时直接返回 false：生产应用桥接故障宁可报错也不无声进演示书。 */
export function installApiMock(): boolean {
  if (!isMockEnabled()) return false
  if (typeof window.api !== 'undefined' && window.api !== null) return false
  Object.defineProperty(window, 'api', { value: mock, configurable: true })
  console.info('[zhumo] 未检测到 Electron 桥接，已注入浏览器预览桩（api-mock）')
  return true
}

export const isMockApi = installApiMock()
