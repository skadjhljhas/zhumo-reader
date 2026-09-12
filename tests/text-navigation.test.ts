import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedBook } from '../src/shared/types'
import { parseBook } from '../src/renderer/src/parser'
import {
  textAddress,
  textDocumentVersion,
  type TextAddress
} from '../src/renderer/src/composables/textAddress'
import { navigateTextAddress } from '../src/renderer/src/composables/textNavigation'

const state = vi.hoisted(() => ({
  bookState: { book: null as ParsedBook | null, status: 'reading' },
  documentSession: { path: 'C:/书.md', source: '门槛是一处开始。', mode: 'read' },
  body: vi.fn(),
  note: vi.fn()
}))
vi.mock('../src/renderer/src/composables/useBook', () => ({ bookState: state.bookState }))
vi.mock('../src/renderer/src/composables/documentSession', () => ({
  documentSession: state.documentSession
}))
vi.mock('../src/renderer/src/composables/readerStore', () => ({
  readerState: { scrollRequest: { seq: 0 }, sidebarRequest: { seq: 0 } },
  requestSearchLanding: state.body,
  requestSidebarLocate: state.note
}))
vi.mock('../src/renderer/src/composables/useStudio', () => ({ studio: { focusMode: false } }))
vi.mock('../src/renderer/src/composables/useSettings', () => ({
  settings: { sidebarVisible: true }
}))

let address: TextAddress
beforeEach(async () => {
  state.body.mockClear()
  state.note.mockClear()
  state.documentSession.path = 'C:/书.md'
  state.documentSession.source = '门槛是一处开始。'
  state.documentSession.mode = 'read'
  state.bookState.status = 'reading'
  const book = parseBook(state.documentSession.source)
  state.bookState.book = book
  address = textAddress(
    await textDocumentVersion(state.documentSession.path, state.documentSession.source),
    book,
    {
      kind: 'section',
      id: book.sections[0].id,
      title: '正文',
      text: state.documentSession.source,
      blockIndex: 0,
      position: 0
    },
    { start: 0, end: 2, text: '门槛' }
  )!
})
afterEach(() => {
  vi.restoreAllMocks()
  expect(state.body).not.toHaveBeenCalled()
  expect(state.note).not.toHaveBeenCalled()
})

describe('navigation refuses stale or cancelled work before touching rendered content', () => {
  it('rejects malformed persisted addresses and inactive reading without entering the editor', async () => {
    expect(await navigateTextAddress({ ...address, schema: 9 } as unknown as TextAddress)).toEqual({
      status: 'invalid-address'
    })
    state.documentSession.mode = 'edit'
    expect(await navigateTextAddress(address)).toEqual({ status: 'not-reading' })
    expect(state.documentSession.mode).toBe('edit')
    state.documentSession.mode = 'read'
    state.bookState.status = 'loading'
    expect(await navigateTextAddress(address)).toEqual({ status: 'not-reading' })
  })
  it('reports a changed version before looking up an old block or another matching word', async () => {
    const original = state.documentSession.source
    state.documentSession.source = '新的门槛。\n\n' + original
    state.bookState.book = parseBook(state.documentSession.source)
    expect(await navigateTextAddress(address)).toEqual({ status: 'version-changed' })
    expect(state.documentSession.source).toBe('新的门槛。\n\n' + original)
    state.documentSession.source = original
    state.documentSession.path = 'C:/另一本.md'
    expect(await navigateTextAddress(address)).toEqual({ status: 'version-changed' })
  })
  it('honors cancellation before computing a digest', async () => {
    const controller = new AbortController()
    controller.abort()
    const digest = vi.spyOn(crypto.subtle, 'digest')
    expect(await navigateTextAddress(address, { signal: controller.signal })).toEqual({
      status: 'cancelled'
    })
    expect(digest).not.toHaveBeenCalled()
  })
  it.each(['source', 'book', 'loading', 'mode', 'signal', 'subsequent request'])(
    'cancels when %s changes during asynchronous version verification',
    async (change) => {
      let finish!: (value: ArrayBuffer) => void
      const pending = new Promise<ArrayBuffer>((resolve) => {
        finish = resolve
      })
      vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => pending)
      const controller = new AbortController()
      const navigation = navigateTextAddress(address, { signal: controller.signal })
      if (change === 'source') state.documentSession.source += '后来。'
      if (change === 'book') state.bookState.book = parseBook('另一次开始。')
      if (change === 'loading') state.bookState.status = 'loading'
      if (change === 'mode') state.documentSession.mode = 'edit'
      if (change === 'signal') controller.abort()
      if (change === 'subsequent request') {
        const cancelled = new AbortController()
        cancelled.abort()
        expect(await navigateTextAddress(address, { signal: cancelled.signal })).toEqual({
          status: 'cancelled'
        })
      }
      finish(new ArrayBuffer(32))
      expect(await navigation).toEqual({ status: 'cancelled' })
    }
  )
})
