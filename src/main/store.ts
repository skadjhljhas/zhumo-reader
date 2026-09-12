/**
 * 朱墨 ZhuMo —— 主进程持久化层。
 *
 * 设计目标：把「纯逻辑 + 文件 IO」与 Electron API 完全分离，
 * 使本模块可在无 Electron 的环境（vitest / Node）下直接单测：
 * - JsonStore   通用 JSON 键值存储（原子写 / 节流写 / 损坏回退 null）
 * - ZhuMoStore  面向业务的组合封装（设置 / 最近列表 / 阅读进度）
 * - 纯函数      设置规范化、最近列表增删排序等
 *
 * 磁盘布局（相对 baseDir，通常为 app.getPath('userData')）：
 * - settings.json          阅读设置
 * - recent.json            最近打开列表
 * - books/<sha1(path)>.json 各书阅读进度（按路径 SHA-1 命名，规避非法字符）
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clampSettings } from '../shared/ipc-types'
import type { Progress, RecentBook, Settings } from '../shared/ipc-types'

// 设置契约（默认值 / 区间 / 钳制）的单一事实源在 src/shared/ipc-types.ts；
// 此处 re-export 保持既有导入路径（tests 等）不变。sanitizeSettings 即 clampSettings。
export { DEFAULT_SETTINGS, clampSettings as sanitizeSettings } from '../shared/ipc-types'

/** 最近列表容量上限 */
export const RECENT_BOOKS_LIMIT = 12

/** 应用级偏好（T26）：与阅读设置分离持久化（app.json），避免污染渲染层 Settings 契约 */
export interface AppPrefs {
  /** 便携版文件关联自注册开关；缺省 / 损坏视为 true（用户未表达过意愿） */
  fileAssocEnabled?: boolean
}

/** 存储键：顶层键，或进度键（books/<sha1(path)>） */
export type StoreKey = 'settings' | 'recent' | 'app' | `books/${string}`

const KEY_PATTERN = /^(?:settings|recent|app|books\/[0-9a-f]{40})$/

/** 进度文件的存储键：书籍路径的 SHA-1 摘要 */
export function progressKeyFor(path: string): StoreKey {
  return `books/${createHash('sha1').update(path, 'utf8').digest('hex')}`
}

export interface JsonStoreOptions {
  /** 同一 key 的节流窗口（毫秒），默认 2000 */
  throttleMs?: number
  /** 每次真实落盘后的回调（测试观察用） */
  onPersist?: (key: string) => void
}

/** 临时文件序号，避免同一毫秒内的并发写撞名 */
let tmpSequence = 0

/**
 * 通用 JSON 存储：
 * - 原子写：先写同目录临时文件，再 rename 覆盖（避免留下半截 JSON）
 * - 节流写：同一 key 在窗口内的多次 write 合并为一次落盘，可随时 flush
 * - 容错读：文件不存在或 JSON 损坏一律返回 null，绝不抛错
 */
export class JsonStore {
  private readonly baseDir: string
  private readonly throttleMs: number
  private readonly onPersist?: (key: string) => void
  /** key -> 待落盘 JSON 文本（写入时即序列化，天然与调用方对象隔离） */
  private readonly pending = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** key -> 进行中的落盘链（同一 key 严格串行，避免并发写同一文件） */
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly ensuredDirs = new Set<string>()

  constructor(baseDir: string, options: JsonStoreOptions = {}) {
    this.baseDir = baseDir
    this.throttleMs = options.throttleMs ?? 2000
    this.onPersist = options.onPersist
  }

  /** 读取 key：优先返回节流窗口内的内存值，其次磁盘；缺失 / 损坏返回 null */
  async read<T>(key: StoreKey): Promise<T | null> {
    const pendingText = this.pending.get(key)
    if (pendingText !== undefined) {
      try {
        return JSON.parse(pendingText) as T
      } catch {
        return null
      }
    }
    let raw: string
    try {
      raw = await readFile(this.fileFor(key), 'utf8')
    } catch {
      return null // 文件不存在（或不可读）
    }
    try {
      const parsed = JSON.parse(raw) as T
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null // JSON 损坏
    }
  }

  /** 写入 key（节流）：立即更新内存值，窗口到期或 flush 时原子落盘 */
  async write(key: StoreKey, value: unknown): Promise<void> {
    this.fileFor(key) // 触发 key 合法性校验
    const text = JSON.stringify(value, null, 2)
    this.pending.set(key, text)
    if (!this.timers.has(key)) {
      const timer = setTimeout(() => {
        this.timers.delete(key)
        this.persist(key).catch((error) => {
          console.error(`[zhumo] 持久化失败（${key}）：`, error)
        })
      }, this.throttleMs)
      timer.unref() // 不因节流定时器而拖住进程退出
      this.timers.set(key, timer)
    }
  }

  /** 立即落盘全部待写数据（应用退出前调用） */
  async flushAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    const keys = new Set<string>([...this.pending.keys(), ...this.inflight.keys()])
    await Promise.all([...keys].map((key) => this.persist(key)))
  }

  private fileFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`非法的存储键：${key}`)
    }
    return join(this.baseDir, `${key}.json`)
  }

  /** 把某 key 的最新待写值排入串行落盘链 */
  private persist(key: string): Promise<void> {
    const prev = this.inflight.get(key) ?? Promise.resolve()
    const task = prev.then(() => this.doPersist(key))
    this.inflight.set(key, task)
    void task
      .catch(() => undefined)
      .then(() => {
        if (this.inflight.get(key) === task) this.inflight.delete(key)
      })
    return task
  }

  private async doPersist(key: string): Promise<void> {
    const text = this.pending.get(key)
    if (text === undefined) return
    const file = this.fileFor(key)
    const dir = dirname(file)
    if (!this.ensuredDirs.has(dir)) {
      await mkdir(dir, { recursive: true })
      this.ensuredDirs.add(dir)
    }
    const tmp = `${file}.${process.pid}.${++tmpSequence}.tmp`
    try {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file) // 同目录 rename，Windows 上亦可原子覆盖
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    // 落盘期间又有新写入时保留 pending，交给下一轮
    if (this.pending.get(key) === text) this.pending.delete(key)
    this.onPersist?.(key)
  }
}

/** 过滤非法条目并按最近优先排序、截断至上限 */
export function normalizeRecentBooks(raw: unknown): RecentBook[] {
  if (!Array.isArray(raw)) return []
  const valid = raw.filter(
    (item): item is RecentBook =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as RecentBook).path === 'string' &&
      (item as RecentBook).path.length > 0 &&
      typeof (item as RecentBook).name === 'string' &&
      typeof (item as RecentBook).lastOpenedAt === 'number' &&
      Number.isFinite((item as RecentBook).lastOpenedAt)
  )
  return valid.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, RECENT_BOOKS_LIMIT)
}

/** 打开图书后更新最近列表（同路径去重置顶，超出上限淘汰最旧） */
export function upsertRecentBook(
  list: RecentBook[],
  path: string,
  name: string,
  lastOpenedAt: number
): RecentBook[] {
  const rest = list.filter((book) => book.path !== path)
  return normalizeRecentBooks([{ path, name, lastOpenedAt }, ...rest])
}

/** 校验进度形状；非法返回 null */
export function sanitizeProgress(raw: unknown): Progress | null {
  if (typeof raw !== 'object' || raw === null) return null
  const input = raw as Record<string, unknown>
  if (typeof input.sectionId !== 'string') return null
  if (typeof input.ratio !== 'number' || !Number.isFinite(input.ratio)) return null
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) return null
  return { sectionId: input.sectionId, ratio: input.ratio, updatedAt: input.updatedAt }
}

/**
 * 面向业务的存储封装：设置 / 最近列表 / 阅读进度。
 * 仅依赖 JsonStore 与纯函数，不触碰任何 Electron API。
 */
export class ZhuMoStore {
  private readonly json: JsonStore

  constructor(baseDir: string, options: JsonStoreOptions = {}) {
    this.json = new JsonStore(baseDir, options)
  }

  /** 读取设置；无存档或损坏时返回默认值（钳制见 shared/ipc-types 的 clampSettings） */
  async getSettings(): Promise<Settings> {
    return clampSettings(await this.json.read('settings'))
  }

  /** 保存设置（先钳制再落盘，存储值永远合法） */
  async saveSettings(settings: Settings): Promise<void> {
    await this.json.write('settings', clampSettings(settings))
  }

  /** 最近列表（最近优先，上限 12 条） */
  async getRecentBooks(): Promise<RecentBook[]> {
    return normalizeRecentBooks(await this.json.read('recent'))
  }

  /** 便携版文件关联自注册开关（缺省 / 损坏一律视为开启，T26） */
  async getFileAssocEnabled(): Promise<boolean> {
    const prefs = await this.json.read<AppPrefs>('app')
    return prefs?.fileAssocEnabled !== false
  }

  /** 写入文件关联开关（保留 app.json 其它字段，节流落盘） */
  async setFileAssocEnabled(enabled: boolean): Promise<void> {
    const prefs = (await this.json.read<AppPrefs>('app')) ?? {}
    await this.json.write('app', { ...prefs, fileAssocEnabled: enabled })
  }

  /** 记录一次打开（同路径去重置顶；name 为文件名去扩展名） */
  async touchRecentBook(path: string, name: string, lastOpenedAt = Date.now()): Promise<void> {
    const list = await this.getRecentBooks()
    await this.json.write('recent', upsertRecentBook(list, path, name, lastOpenedAt))
  }

  /** 从最近列表移除指定路径（保留其阅读进度） */
  async removeRecentBook(path: string): Promise<void> {
    const list = await this.getRecentBooks()
    await this.json.write(
      'recent',
      list.filter((book) => book.path !== path)
    )
  }

  /** 读取某书的阅读进度；无记录或损坏返回 null */
  async getProgress(path: string): Promise<Progress | null> {
    return sanitizeProgress(await this.json.read(progressKeyFor(path)))
  }

  /** 保存某书的阅读进度（形状非法时抛中文错误，绝不落盘垃圾） */
  async saveProgress(path: string, progress: Progress): Promise<void> {
    const sanitized = sanitizeProgress(progress)
    if (sanitized === null) {
      throw new Error('无效的进度数据（需要 sectionId / ratio / updatedAt 字段）')
    }
    await this.json.write(progressKeyFor(path), sanitized)
  }

  /** 立即落盘全部待写数据 */
  async flushAll(): Promise<void> {
    await this.json.flushAll()
  }
}
