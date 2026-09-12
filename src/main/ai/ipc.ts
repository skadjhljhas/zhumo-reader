import { app, BrowserWindow, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { AI_IPC, type AiEvent, type AiLane, type AiRequest } from '../../shared/ai-types'
import { AiConfigStore } from './config'
import { streamCompletion, validateAiRequest } from './transport'
import { AiResultCache, selectionCacheKey } from './result-cache'
import { SyntaxStream } from '../../shared/syntax-stream'
import { createDocumentAnnotationStream } from '../../shared/document-annotations'
import { AiJobAdmission } from './job-admission'

export function registerAiIpc(): void {
  const resultCache = new AiResultCache(app.getPath('userData'), {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  })
  const store = new AiConfigStore(app.getPath('userData'), {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  })
  const jobs = new AiJobAdmission()
  const watched = new Set<number>()
  function authorize(event: IpcMainInvokeEvent): void {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('无效的 AI 调用来源。')
  }
  function lane(value: unknown): asserts value is AiLane {
    if (value !== 'reading' && value !== 'syntax') throw new Error('无效的模型用途。')
  }
  ipcMain.handle(AI_IPC.profiles, (event) => {
    authorize(event)
    return store.profiles()
  })
  ipcMain.handle(AI_IPC.activity, (event) => {
    authorize(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    return {
      focused: Boolean(win?.isFocused()),
      visible: Boolean(win?.isVisible() && !win.isMinimized()),
      backgroundTest:
        process.env.ZHUMO_TEST_BACKGROUND === '1' && Boolean(process.env.ZHUMO_USER_DATA)
    }
  })
  ipcMain.handle(AI_IPC.save, (event, name, input) => {
    authorize(event)
    lane(name)
    return store.save(name, input)
  })
  ipcMain.handle(AI_IPC.cancel, (event, id: unknown) => {
    authorize(event)
    if (typeof id !== 'string') return
    jobs.cancel(event.sender.id, id)
  })
  ipcMain.handle(AI_IPC.start, async (event, request: AiRequest) => {
    authorize(event)
    validateAiRequest(request)
    const sender = event.sender
    const job = jobs.reserve(sender.id, request)
    const { abort } = job
    if (!watched.has(sender.id)) {
      watched.add(sender.id)
      sender.once('destroyed', () => {
        jobs.destroy(sender.id)
        watched.delete(sender.id)
      })
    }
    const send = (data: AiEvent): void => {
      if (!sender.isDestroyed()) sender.send(AI_IPC.event, data)
    }
    void (async () => {
      // A total bound includes slow reasoning before the first token. User can stop at any time.
      const timer = setTimeout(() => abort.abort('timeout'), 10 * 60 * 1000)
      let pending = '',
        pendingReasoning = '',
        flushTimer: ReturnType<typeof setTimeout> | undefined
      const flush = (): void => {
        clearTimeout(flushTimer)
        flushTimer = undefined
        if (pendingReasoning) {
          send({ id: request.id, type: 'reasoning', text: pendingReasoning })
          pendingReasoning = ''
        }
        if (pending) {
          send({ id: request.id, type: 'delta', text: pending })
          pending = ''
        }
      }
      try {
        const { profile, apiKey } = await store.credentials(request.lane, request.profileRevision)
        if (abort.signal.aborted) throw new Error('cancelled')
        const cacheKey = !request.test ? selectionCacheKey(profile, request) : ''
        if (cacheKey) {
          const cached = await resultCache.get(cacheKey)
          if (abort.signal.aborted) throw Error('cancelled')
          if (cached !== undefined) {
            send({ id: request.id, type: 'delta', text: cached })
            send({ id: request.id, type: 'done', finishReason: 'stop' })
            return
          }
        }
        let complete = ''
        const finishReason = await streamCompletion(
          profile,
          apiKey,
          request,
          abort.signal,
          (text) => {
            complete += text
            pending += text
            flushTimer ??= setTimeout(flush, 32)
          },
          fetch,
          (text) => {
            pendingReasoning += text
            flushTimer ??= setTimeout(flush, 32)
          }
        )
        flush()
        if (cacheKey && !abort.signal.aborted && ['stop', 'end_turn'].includes(finishReason)) {
          let valid = true
          if (request.lane === 'syntax') {
            try {
              const stream =
                request.annotationMode === 'document'
                  ? createDocumentAnnotationStream(request.documentBlocks!)
                  : new SyntaxStream(request.selectedText)
              stream.push(complete)
              stream.finish()
            } catch {
              valid = false
            }
          }
          if (valid) void resultCache.put(cacheKey, complete)
        }
        send(
          abort.signal.aborted
            ? { id: request.id, type: 'cancelled' }
            : { id: request.id, type: 'done', finishReason }
        )
      } catch (error) {
        flush()
        if (abort.signal.aborted && abort.signal.reason !== 'timeout')
          send({ id: request.id, type: 'cancelled' })
        else
          send({
            id: request.id,
            type: 'error',
            message:
              abort.signal.reason === 'timeout'
                ? '等待模型超过十分钟，已停止。已有文字保留，可调整设置后重试。'
                : error instanceof TypeError
                  ? '无法连接 API，请检查地址、网络或本机模型服务。'
                  : error instanceof Error
                    ? error.message
                    : '模型请求失败。'
          })
      } finally {
        clearTimeout(timer)
        clearTimeout(flushTimer)
        jobs.release(job)
      }
    })()
  })
  app.on('before-quit', () => {
    jobs.abortAll()
  })
}
