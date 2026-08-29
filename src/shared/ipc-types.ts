/**
 * 朱墨 ZhuMo —— 主进程 / 渲染层共享的 IPC 契约。
 *
 * 渲染层通过 window.api（见 src/preload）消费以下类型；
 * 字段名与语义为前后端契约，任何修改须经双方确认。
 */

/** 阅读偏好设置 */
export interface Settings {
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: 'auto' | 'light' | 'dark'
  /** 正文字号（px），14–24，默认 17 */
  fontSize: number
  /** 正文行高（倍数），1.6–2.2，默认 1.85 */
  lineHeight: number
  /** 版心宽度（每行字数），34–46，默认 40 */
  contentWidth: number
  /** 段落样式：首行缩进 / 段间距 */
  paragraphStyle: 'indent' | 'spacing'
  /** 是否显示侧边栏，默认 true */
  sidebarVisible: boolean
  /** 脚注层级上限，1–6，默认 4 */
  noteLevelCap: number
}

/** 阅读进度 */
export interface Progress {
  sectionId: string
  ratio: number
  updatedAt: number
}

/** 便携版文件关联状态（T26）
 * - active：已注册且指向当前程序
 * - stale：已注册但指向其他路径（待自愈）
 * - off：未注册或用户已关闭（dev / 浏览器预览恒为 off） */
export type FileAssocStatus = 'active' | 'stale' | 'off'

/** 最近打开的图书条目 */
export interface RecentBook {
  path: string
  name: string
  lastOpenedAt: number
}

/** 传给渲染层的图书载荷（title 为文件名去扩展名） */
export interface BookPayload {
  path: string
  content: string
  title: string
}

/** window.api 的完整形状（由 preload 经 contextBridge 暴露，全部为 invoke 请求-响应式调用） */
export interface ZhuMoApi {
  /** 系统打开对话框（.md/.markdown/.txt）；取消返回 null，成功即更新最近列表 */
  openBookDialog(): Promise<BookPayload | null>
  /** utf8 读取图书并记入最近列表（T22，与 openBookDialog 对齐）；不存在 / 不可读 / 超 50MB 时 reject（中文错误信息） */
  readBook(path: string): Promise<BookPayload>
  /** 保存某书的阅读进度 */
  saveProgress(path: string, progress: Progress): Promise<void>
  /** 读取某书的阅读进度；无记录返回 null */
  getProgress(path: string): Promise<Progress | null>
  /** 保存设置（越界值会被钳制回默认区间） */
  saveSettings(settings: Settings): Promise<void>
  /** 读取设置；无存档返回默认值 */
  getSettings(): Promise<Settings>
  /** 最近打开列表（最近优先，上限 12 条） */
  getRecentBooks(): Promise<RecentBook[]>
  /** 从最近列表移除指定路径 */
  removeRecent(path: string): Promise<void>
  /** 取 File 对象对应的磁盘路径（拖放开书用；必须在 preload 中执行） */
  getPathForFile(file: File): Promise<string>
  /** 便携版文件关联状态（真实环境查询 HKCU；dev / 浏览器预览恒为 'off'） */
  fileAssocStatus(): Promise<FileAssocStatus>
  /** 开启 / 关闭便携版文件关联自注册（非打包环境为空操作，不碰注册表） */
  fileAssocSet(enabled: boolean): Promise<void>
}

/** IPC 通道名（ipcMain.handle / ipcRenderer.invoke 一一对应） */
export const IPC = {
  OpenBookDialog: 'book:open-dialog',
  ReadBook: 'book:read',
  SaveProgress: 'progress:save',
  GetProgress: 'progress:get',
  SaveSettings: 'settings:save',
  GetSettings: 'settings:get',
  GetRecentBooks: 'recent:list',
  RemoveRecent: 'recent:remove',
  FileAssocStatus: 'fileassoc:status',
  FileAssocSet: 'fileassoc:set'
} as const

/* ------------------------------------------------------------------
 * 以下为设置契约的运行时部分（单一事实源）：
 * 主进程持久化（store.ts）、渲染层状态（useSettings.ts）、
 * 浏览器预览桩（api-mock.ts）、设置面板滑杆（SettingsPanel.vue）
 * 的默认值 / 区间 / 钳制全部由这里导出，四处不再各自抄写。
 * ------------------------------------------------------------------ */

/** 默认阅读设置（全端唯一副本，勿在他处复制字面量） */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  fontSize: 17,
  lineHeight: 1.85,
  contentWidth: 40,
  paragraphStyle: 'indent',
  sidebarVisible: true,
  noteLevelCap: 4
}

/** 数值型设置字段的区间与步长 */
export interface NumericSettingLimit {
  min: number
  max: number
  step: number
}

/** 数值型设置字段名（可经滑杆调节的那几个） */
export type NumericSettingsKey = 'fontSize' | 'lineHeight' | 'contentWidth' | 'noteLevelCap'

/** 数值型设置字段的区间与步长（钳制与 UI 滑杆共用的单一事实源） */
export const SETTINGS_LIMITS: Record<NumericSettingsKey, NumericSettingLimit> = {
  fontSize: { min: 14, max: 24, step: 1 },
  lineHeight: { min: 1.6, max: 2.2, step: 0.05 },
  contentWidth: { min: 34, max: 46, step: 1 },
  noteLevelCap: { min: 1, max: 6, step: 1 }
}

function clampNumber(
  value: unknown,
  limit: NumericSettingLimit,
  fallback: number,
  integer: boolean
): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamped = Math.min(limit.max, Math.max(limit.min, num))
  return integer ? Math.round(clamped) : clamped
}

function pickOption<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/**
 * 设置钳制（纯函数）：越界数值钳回 SETTINGS_LIMITS 区间，
 * 非法类型回落 DEFAULT_SETTINGS 对应默认值。
 * 任何来源（渲染层输入 / 磁盘存档 / localStorage 缓存）的设置
 * 都应先经此函数再使用或落盘，保证存储与应用值永远合法。
 */
export function clampSettings(input: unknown): Settings {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_SETTINGS }
  const raw = input as Record<string, unknown>
  return {
    theme: pickOption(raw.theme, ['auto', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    fontSize: clampNumber(raw.fontSize, SETTINGS_LIMITS.fontSize, DEFAULT_SETTINGS.fontSize, true),
    lineHeight: clampNumber(
      raw.lineHeight,
      SETTINGS_LIMITS.lineHeight,
      DEFAULT_SETTINGS.lineHeight,
      false
    ),
    contentWidth: clampNumber(
      raw.contentWidth,
      SETTINGS_LIMITS.contentWidth,
      DEFAULT_SETTINGS.contentWidth,
      true
    ),
    paragraphStyle: pickOption(
      raw.paragraphStyle,
      ['indent', 'spacing'] as const,
      DEFAULT_SETTINGS.paragraphStyle
    ),
    sidebarVisible:
      typeof raw.sidebarVisible === 'boolean'
        ? raw.sidebarVisible
        : DEFAULT_SETTINGS.sidebarVisible,
    noteLevelCap: clampNumber(
      raw.noteLevelCap,
      SETTINGS_LIMITS.noteLevelCap,
      DEFAULT_SETTINGS.noteLevelCap,
      true
    )
  }
}
