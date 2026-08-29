/**
 * 朱墨 ZhuMo —— IPC 通道注册（主进程侧胶水层）。
 *
 * 全部通道均为 ipcMain.handle / ipcRenderer.invoke 的请求-响应模式，
 * 无事件推送。业务规则：
 * - openBookDialog：成功读取后写入最近列表；取消返回 null
 * - readBook：成功读取后同样写入最近列表（T22）——按路径开书的各入口
 *   （最近列表点击 / 拖放 / argv 传书 / second-instance / 启动 query）
 *   均汇于此通道，与对话框路径对齐；读取失败则整体 reject，不污染列表
 * - fileassoc:*（T26）：便携版文件关联状态查询与开关；非打包环境（dev）
 *   状态恒 'off' 且开关为空操作，绝不触碰开发机注册表
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { IPC } from '../shared/ipc-types'
import type { BookPayload, FileAssocStatus, Progress, Settings } from '../shared/ipc-types'
import { BOOK_EXTENSIONS } from './args'
import {
  ASSOC_PROG_ID,
  commandPointsTo,
  currentAssocExePath,
  queryProgIdCommand,
  registerFileAssoc,
  unregisterFileAssoc
} from './file-assoc'
import type { ZhuMoStore } from './store'

/** 图书大小上限：50 MB */
const MAX_BOOK_BYTES = 50 * 1024 * 1024
const BOOK_FILE_FILTERS: Electron.FileFilter[] = [
  { name: 'Markdown / 文本文档', extensions: ['md', 'markdown', 'txt'] }
]

/** 文件名去扩展名，作为书名 */
export function bookTitleOf(path: string): string {
  const base = basename(path)
  const ext = extname(base)
  return ext !== '' ? base.slice(0, base.length - ext.length) : base
}

/** 校验扩展名 / 大小并以 utf8 读取图书文件（错误信息为中文） */
async function readBookFile(path: string): Promise<BookPayload> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('无效的文件路径')
  }
  const ext = extname(path).toLowerCase()
  // 白名单单一事实源在 args.ts（与启动参数解析共用，T20）
  if (!BOOK_EXTENSIONS.includes(ext)) {
    throw new Error(
      `不支持的文件类型「${ext === '' ? '无扩展名' : ext}」，仅支持 .md / .markdown / .txt`
    )
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new Error(`文件不存在或无法访问：${path}`)
  }
  if (!info.isFile()) {
    throw new Error(`目标不是普通文件：${path}`)
  }
  if (info.size > MAX_BOOK_BYTES) {
    const mb = (info.size / (1024 * 1024)).toFixed(1)
    throw new Error(`文件过大（${mb} MB），超过 50 MB 上限：${path}`)
  }
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `无法读取文件：${path}（${error instanceof Error ? error.message : String(error)}）`
    )
  }
  return { path, content, title: bookTitleOf(path) }
}

function assertBookPath(path: unknown): void {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('无效的文件路径')
  }
}

/** 注册全部 IPC 通道（应用生命周期内仅调用一次） */
export function registerIpc(store: ZhuMoStore): void {
  ipcMain.handle(IPC.OpenBookDialog, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const picked = owner
      ? await dialog.showOpenDialog(owner, {
          title: '打开图书',
          properties: ['openFile'],
          filters: BOOK_FILE_FILTERS
        })
      : await dialog.showOpenDialog({
          title: '打开图书',
          properties: ['openFile'],
          filters: BOOK_FILE_FILTERS
        })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const [filePath] = picked.filePaths
    // 读取失败则整体 reject，不污染最近列表
    const payload = await readBookFile(filePath)
    await store.touchRecentBook(filePath, bookTitleOf(filePath))
    return payload
  })

  // 按路径开书成功后与 openBookDialog 一样写入最近列表（T22）。
  // 对话框 handler 在主进程内部直接调 readBookFile，不经此通道，
  // 因此两条入口各自恰好 touch 一次，不会二次置顶。
  ipcMain.handle(IPC.ReadBook, async (_event, path: string) => {
    const payload = await readBookFile(path)
    await store.touchRecentBook(path, bookTitleOf(path))
    return payload
  })

  ipcMain.handle(IPC.SaveProgress, (_event, path: string, progress: Progress) => {
    assertBookPath(path)
    return store.saveProgress(path, progress)
  })

  ipcMain.handle(IPC.GetProgress, (_event, path: string) => {
    assertBookPath(path)
    return store.getProgress(path)
  })

  ipcMain.handle(IPC.SaveSettings, (_event, settings: Settings) => store.saveSettings(settings))

  ipcMain.handle(IPC.GetSettings, () => store.getSettings())

  ipcMain.handle(IPC.GetRecentBooks, () => store.getRecentBooks())

  ipcMain.handle(IPC.RemoveRecent, (_event, path: string) => {
    assertBookPath(path)
    return store.removeRecentBook(path)
  })

  // ---- 文件关联（T26）：真实环境查 HKCU，dev / 非打包一律 'off' / 空操作 ----
  ipcMain.handle(IPC.FileAssocStatus, async (): Promise<FileAssocStatus> => {
    if (process.platform !== 'win32' || !app.isPackaged) return 'off'
    if (!(await store.getFileAssocEnabled())) return 'off'
    const commands = await queryProgIdCommand(ASSOC_PROG_ID)
    if (commands.length === 0) return 'off'
    const exePath = currentAssocExePath()
    return commands.some((command) => commandPointsTo(command, exePath)) ? 'active' : 'stale'
  })

  ipcMain.handle(IPC.FileAssocSet, async (_event, enabled: boolean): Promise<void> => {
    if (typeof enabled !== 'boolean') {
      throw new Error('无效的文件关联开关参数（需要 boolean）')
    }
    await store.setFileAssocEnabled(enabled)
    // dev 不动注册表（注册 electron.exe 到系统是错误行为）
    if (process.platform !== 'win32' || !app.isPackaged) return
    // 显式开关无条件执行：用户明确意愿优先于启动期的 NSIS 覆盖跳过逻辑；
    // register / unregister 内部吞错告警，不会向渲染层抛出注册表细节
    if (enabled) {
      await registerFileAssoc(currentAssocExePath())
    } else {
      await unregisterFileAssoc()
    }
  })

  console.log(`[zhumo] IPC 通道已注册：${Object.values(IPC).join(', ')}`)
}
