/**
 * 朱墨 ZhuMo —— 书籍装载与解析（单例 composable）。
 *
 * 状态机：welcome → loading → reading。
 * 解析在 Worker 中进行；Worker 异常时回退主线程 parseBook
 * （parseBook 自身永不抛错，会产出带 parse-fallback 警告的降级书）。
 * 解析失败/降级不白屏：信息汇入 statusMessage，由状态栏呈现。
 *
 * 切书安全（H2）：payload/book/restore 三元组在全部 await 完成后原子落地，
 * 配合 ReaderView 的书身份快照，切书时旧书进度保存不再污染新书存档。
 */
import { reactive } from 'vue'
import type { BookPayload, Progress } from '../../../shared/ipc-types'
import type { ParsedBook } from '../../../shared/types'
import type { ParseWorkerResponse } from '../parser/worker/parse.worker'
import { isMockApi } from '../dev/api-mock'
import { parseBook } from '../parser'
import { settings } from './useSettings'
import { resetReaderState } from './readerStore'

export type AppStatus = 'welcome' | 'loading' | 'reading'

export const bookState = reactive({
  status: 'welcome' as AppStatus,
  payload: null as BookPayload | null,
  book: null as ParsedBook | null,
  /** 待恢复的阅读进度（ReaderView 消费） */
  restore: null as Progress | null,
  /** 状态栏提示（解析降级 / 读取失败等非致命问题） */
  statusMessage: '',
  /** 最近列表版本号（开书后 +1，通知欢迎页刷新） */
  recentsVersion: 0
})

/** Worker 解析；Worker 本身故障时回退主线程解析 */
function parseInWorker(source: string, levelCap: number): Promise<ParsedBook> {
  return new Promise((resolve) => {
    let worker: Worker | null = null
    try {
      worker = new Worker(new URL('../parser/worker/parse.worker.ts', import.meta.url), {
        type: 'module'
      })
    } catch {
      resolve(parseBook(source, { levelCap }))
      return
    }
    const done = (book: ParsedBook): void => {
      worker?.terminate()
      resolve(book)
    }
    worker.onmessage = (ev: MessageEvent<ParseWorkerResponse>) => {
      const data = ev.data
      if ('book' in data) {
        done(data.book)
      } else {
        console.warn('[zhumo] Worker 解析异常，回退主线程解析：', data.error)
        done(parseBook(source, { levelCap }))
      }
    }
    worker.onerror = (ev) => {
      console.warn('[zhumo] Worker 运行失败，回退主线程解析：', ev.message)
      done(parseBook(source, { levelCap }))
    }
    worker.postMessage({ source, options: { levelCap } })
  })
}

/** 装载序号：快速连续开书时仅最新一次装载的结果允许落地（M1 竞态防护）。
 *  loadPayload / reparseCurrentBook 共用：后发起的装载使先前尚在 await 中的
 *  装载整体作废，杜绝「旧书 book 盖到新书 payload 上」的错位。 */
let loadSeq = 0

async function loadPayload(payload: BookPayload): Promise<void> {
  const seq = ++loadSeq
  bookState.status = 'loading'
  bookState.statusMessage = ''
  resetReaderState()
  // 注意：payload / book / restore 延迟到全部 await 完成后原子落地（H2）——
  // 旧实现先换 payload，切书卸载中的 ReaderView 若读全局状态会把新书 path 配上
  // 旧书章节，污染新书进度存档；现在旧 ReaderView 卸载时全局仍是完整的旧书。

  let book: ParsedBook
  try {
    book = await parseInWorker(payload.content, settings.noteLevelCap)
  } catch (err) {
    // parseBook 不抛错，此分支仅为防御
    book = parseBook(payload.content, { levelCap: settings.noteLevelCap })
    console.warn('[zhumo] 解析兜底：', err)
  }

  let restore: Progress | null = null
  try {
    restore = await window.api.getProgress(payload.path)
  } catch {
    restore = null
  }

  if (seq !== loadSeq) return // 过期装载：解析与进度读取期间又有新的开书请求，整体丢弃

  // 原子落地：book / restore / payload 同步可见，渲染层任何观测时刻
  // 看到的都是同一本书的完整三元组
  bookState.book = book
  bookState.restore = restore
  bookState.payload = payload
  if (book.warnings.some((w) => w.kind === 'parse-fallback')) {
    bookState.statusMessage = '本书解析异常，已降级为纯文本渲染'
  } else if (book.warnings.length > 0) {
    bookState.statusMessage = `解析完成，有 ${book.warnings.length} 条提示`
  }
  bookState.recentsVersion++
  bookState.status = 'reading'
}

/**
 * 启动参数 ?book= 自动开书（T20 多窗口 / 文件关联传书链路的渲染层端点）。
 * 主进程 loadFile/loadURL 以 encodeURIComponent 编码盘符路径写入 query
 * （再经 loadFile/URLSearchParams 的一次编码，共双重编码）；此处
 * URLSearchParams.get 已解码一层，再 decodeURIComponent 即还原原路径。
 *
 * 门控：
 * - isMockApi（纯浏览器预览桩）忽略该参数：mock 的 readBook 读不了磁盘
 *   路径，且 ?book= 在 mock 下另有「选演示书」语义，不得误触；
 * - window.api 缺失（无桥接的生产构建，如静态预览未加 ?mock=1）同样忽略。
 * 失败处理：openBookByPath 自带——文件被移动等场景回退欢迎页并提示。
 */
export function openBookFromLaunchQuery(): void {
  if (isMockApi) return
  if (typeof window.api === 'undefined' || window.api === null) return
  let encoded: string | null = null
  try {
    encoded = new URLSearchParams(window.location.search).get('book')
  } catch {
    return
  }
  if (encoded === null || encoded === '') return
  let path = encoded
  try {
    path = decodeURIComponent(encoded)
  } catch {
    /* 编码异常（路径含裸 % 等）时按原值尝试，readBook 校验会兜底报错 */
  }
  void openBookByPath(path)
}

/** 系统对话框开书 */
export async function openBookViaDialog(): Promise<void> {
  try {
    const payload = await window.api.openBookDialog()
    if (payload) await loadPayload(payload)
  } catch (err) {
    bookState.statusMessage = err instanceof Error ? err.message : String(err)
  }
}

/** 按路径开书（最近列表 / 拖放） */
export async function openBookByPath(path: string): Promise<void> {
  bookState.status = 'loading'
  try {
    const payload = await window.api.readBook(path)
    await loadPayload(payload)
  } catch (err) {
    bookState.status = 'welcome'
    bookState.statusMessage = err instanceof Error ? err.message : String(err)
  }
}

/** 拖放开书：File → 磁盘路径（preload webUtils / mock 暂存）→ readBook */
export async function openBookByFile(file: File): Promise<void> {
  bookState.status = 'loading'
  try {
    const path = await window.api.getPathForFile(file)
    await openBookByPath(path)
  } catch (err) {
    bookState.status = 'welcome'
    bookState.statusMessage = err instanceof Error ? err.message : String(err)
  }
}

/** 层级上限变更后重新解析（保持阅读位置） */
export async function reparseCurrentBook(): Promise<void> {
  const payload = bookState.payload
  if (!payload || bookState.status === 'loading') return
  const seq = ++loadSeq
  bookState.status = 'loading'
  const book = await parseInWorker(payload.content, settings.noteLevelCap)
  let restore: Progress | null = null
  // restore 保持当前章节（readerState.currentSectionId 由 ReaderView 在卸载前已保存进度；
  // 这里直接以上次保存的进度恢复即可——若没有则从头）
  try {
    restore = await window.api.getProgress(payload.path)
  } catch {
    restore = null
  }
  if (seq !== loadSeq) return // 重解析期间又发起了新的开书：丢弃过期结果（M1）
  bookState.book = book
  bookState.restore = restore
  bookState.status = 'reading'
}

/** 回欢迎页（保留 payload 以便重开） */
export function backToWelcome(): void {
  bookState.status = 'welcome'
  bookState.book = null
  bookState.restore = null
  resetReaderState()
}
