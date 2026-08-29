/**
 * 朱墨 ZhuMo —— 启动参数解析（纯函数，零 Electron / IO 依赖，可直接单测）。
 *
 * 两条开书入口都汇到这里：
 * - 首启：app ready 后解析 process.argv（生产形态为 [ZhuMo.exe, 文件路径]）
 * - 第二实例：app.on('second-instance', (_e, commandLine) => ...)
 *
 * 解析策略：宽松遍历、严格过滤——
 * - 忽略以 - 开头的参数（--inspect / --remote-debugging-port 等 electron 开关）
 * - 忽略 URL 形态参数（带层级 scheme，如 http:// / file://）
 * - Windows 盘符路径（C:\ 或 C:/）在 URL 判定之前显式放行
 * - 只接受可开书扩展名（.md / .markdown / .txt，大小写不敏感，
 *   与 ipc.ts 的读文件校验共用 BOOK_EXTENSIONS 单一事实源）
 * - 取第一个命中的路径（相对路径解析为绝对）；无命中返回 null
 *
 * 纯函数不做存在性检查：文件被移动等场景由渲染层 readBook 失败链路
 * 优雅回退欢迎页并提示（见 useBook.openBookFromLaunchQuery）。
 */
import { extname, resolve } from 'node:path'

/** 可开书扩展名白名单（小写存储，匹配时大小写不敏感） */
export const BOOK_EXTENSIONS = ['.md', '.markdown', '.txt']

/** Windows 盘符路径：C:\… 或 C:/…（不能被 URL scheme 规则误杀） */
const WIN_DRIVE_PATTERN = /^[a-zA-Z]:[/\\]/

/** 层级 URL scheme：http:// https:// file:// ftp:// 等（mailto: 无 //，本就不可开书） */
const HIERARCHICAL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i

/** 参数是否可能是一个文件路径（先过滤 flag 与 URL，再谈扩展名） */
function looksLikePath(arg: string): boolean {
  if (arg.startsWith('-')) return false // electron / vite 开关
  if (WIN_DRIVE_PATTERN.test(arg)) return true // C:\… / C:/…
  if (HIERARCHICAL_URL_PATTERN.test(arg)) return false // http(s):// file:// 等
  return true
}

/** 扩展名是否在白名单内（大小写不敏感） */
function hasBookExtension(arg: string): boolean {
  return BOOK_EXTENSIONS.includes(extname(arg).toLowerCase())
}

/**
 * 从启动参数中解析待打开的图书路径。
 * @param argv 完整 argv / commandLine（含 exe 自身路径，内部自行跳过）
 * @returns 第一个命中的书路径（绝对路径）；无命中返回 null
 */
export function parseBookArg(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!looksLikePath(arg)) continue
    if (!hasBookExtension(arg)) continue
    return resolve(arg)
  }
  return null
}
