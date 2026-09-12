/// <reference types="vite/client" />
import type {} from '../src/preload/bridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedBook } from '../src/shared/types'
import type { BookPayload } from '../src/shared/ipc-types'

vi.mock('../src/renderer/src/dev/api-mock', () => ({ isMockApi: false }))
vi.mock('../src/renderer/src/composables/bookResources', () => ({
  attachBookResources: (book: ParsedBook) => book
}))
vi.mock('../src/renderer/src/composables/useSettings', () => ({ settings: { noteLevelCap: 4 } }))
vi.mock('../src/renderer/src/composables/readerStore', () => ({ resetReaderState: vi.fn() }))
vi.mock('../src/renderer/src/composables/useStudio', () => ({ studio: {}, loadBookPins: vi.fn() }))
vi.mock('../src/renderer/src/composables/drafts', () => ({ readDrafts: async () => [] }))
import {
  backToWelcome,
  bookState,
  openBookByPath,
  openBookViaDialog,
  parseInWorker
} from '../src/renderer/src/composables/useBook'
import { resetDocumentSession } from '../src/renderer/src/composables/documentSession'

const payload = (path: string): BookPayload => ({ path, title: path, content: path })
function book(title: string): ParsedBook {
  return {
    title,
    sections: [],
    notes: [],
    toc: [],
    warnings: [],
    stats: { chars: title.length, noteCount: 0, maxLevel: 0 }
  }
}
function pending<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    }),
    resolve,
    reject
  }
}
const workers: FakeWorker[] = []
class FakeWorker {
  onmessage?: (event: { data: { book: ParsedBook } }) => void
  onerror?: (event: unknown) => void
  terminated = false
  constructor() {
    workers.push(this)
  }
  terminate(): void {
    this.terminated = true
  }
  postMessage({ source }: { source: string }): void {
    if (source !== 'pending')
      queueMicrotask(() => this.onmessage?.({ data: { book: book(source) } }))
  }
}
beforeEach(() => {
  resetDocumentSession('', '')
  backToWelcome()
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', {
    api: { getProgress: async () => null, readBook: async (path: string) => payload(path) }
  })
})
describe('newest requested document wins', () => {
  it('ignores an older slow disk read after a newer file has opened', async () => {
    const slow = pending<BookPayload>()
    window.api.readBook = (path) => (path === 'old' ? slow.promise : Promise.resolve(payload(path)))
    const oldRequest = openBookByPath('old')
    await openBookByPath('new')
    slow.resolve(payload('old'))
    await oldRequest
    expect(bookState.payload?.path).toBe('new')
    expect(bookState.book?.title).toBe('new')
  })
  it('ignores a stale read error without hiding the current book', async () => {
    const slow = pending<BookPayload>()
    window.api.readBook = (path) => (path === 'old' ? slow.promise : Promise.resolve(payload(path)))
    const oldRequest = openBookByPath('old')
    await openBookByPath('new')
    slow.reject(new Error('旧文件不存在'))
    await oldRequest
    expect(bookState.status).toBe('reading')
    expect(bookState.statusMessage).toBe('')
  })
  it('does not reopen a pending file after returning to welcome', async () => {
    const slow = pending<BookPayload>()
    window.api.readBook = () => slow.promise
    const request = openBookByPath('old')
    backToWelcome()
    slow.resolve(payload('old'))
    await request
    expect(bookState.status).toBe('welcome')
    expect(bookState.book).toBeNull()
  })
  it('a delayed dialog result cannot overwrite a later open request', async () => {
    const slow = pending<BookPayload>()
    window.api.openBookDialog = () => slow.promise
    const request = openBookViaDialog()
    await openBookByPath('new')
    slow.resolve(payload('old'))
    await request
    expect(bookState.payload?.path).toBe('new')
  })
})
describe('preview cancellation', () => {
  it('terminates obsolete workers and rejects with AbortError', async () => {
    const controller = new AbortController()
    const parse = parseInWorker('pending', 4, controller.signal)
    const rejection = expect(parse).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(workers[0].terminated).toBe(true)
  })
  it('does not start a worker when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(parseInWorker('pending', 4, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(workers).toHaveLength(0)
  })
})
