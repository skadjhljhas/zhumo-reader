/**
 * 解析 Worker：接收 { source, options }，回 { book } 或 { error }。
 *
 * UI 侧用法（vite 自动打包模块 Worker）：
 *   const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
 *   worker.postMessage({ source, options })
 *   worker.onmessage = (ev) => { const { book, error } = ev.data }
 */
import { parseBook } from '../index'
import type { ParseOptions, ParsedBook } from '../../../../shared/types'

export interface ParseWorkerRequest {
  source: string
  options?: ParseOptions
}

export type ParseWorkerResponse = { book: ParsedBook } | { error: string }

interface WorkerContext {
  onmessage: ((ev: MessageEvent<ParseWorkerRequest>) => void) | null
  postMessage(message: ParseWorkerResponse): void
}

const ctx = self as unknown as WorkerContext

ctx.onmessage = (ev: MessageEvent<ParseWorkerRequest>): void => {
  const { source, options } = ev.data ?? {}
  try {
    ctx.postMessage({ book: parseBook(source, options) })
  } catch (err) {
    // parseBook 自身永不抛错，此分支仅作防御
    ctx.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
