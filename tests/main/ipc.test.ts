/**
 * 朱墨 ZhuMo —— IPC 注册层单测（mock electron，其余走真实文件 IO）。
 *
 * 覆盖 T22：ReadBook handler 成功读取后写入最近列表（与 openBookDialog
 * 对齐）、读取失败不污染列表、两入口混合开书的去重置顶语义。
 * openBookDialog 的对话框返回值用 mock 固定，复刻 .perf 既有脚本的做法。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { realpath } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc-types'
import { ZhuMoStore } from '../../src/main/store'
import { registerIpc } from '../../src/main/ipc'
import { productIdentity, allowsFileAssociations } from '../../src/main/product-identity'
import * as associations from '../../src/main/file-assoc'

/** electron 桩：捕获 ipcMain.handle 注册的 handler；dialog 返回值可编程 */
const electronStub = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { handlers, showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '2.0.0-rc.1',
    getAppPath: () => testRoot,
    getPath: () => testRoot
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: {
    showOpenDialog: electronStub.showOpenDialog,
    showSaveDialog: electronStub.showSaveDialog
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronStub.handlers.set(channel, handler)
    })
  }
}))
vi.mock('../../src/main/file-assoc', async (original) => ({
  ...(await original<typeof import('../../src/main/file-assoc')>()),
  queryProgIdCommand: vi.fn(async () => []),
  registerFileAssoc: vi.fn(async () => true),
  unregisterFileAssoc: vi.fn(async () => true)
}))

/** 测试根目录：每个用例独立子目录，互不干扰 */
let testRoot: string

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'zhumo-ipc-test-'))
})

afterAll(async () => {
  if (testRoot) {
    const part = relative(await realpath(tmpdir()), await realpath(testRoot))
    expect(part.startsWith('zhumo-ipc-test-') && !part.includes('..')).toBe(true)
    await rm(testRoot, { recursive: true, force: true })
  }
})
it('uses the same product capability for both file-association IPC calls, including previews without preview in their version', async () => {
  const store = new ZhuMoStore(await mkdtemp(join(testRoot, 'association-')))
  for (const [channel, background] of [
    ['preview-ai', false],
    ['stable', true]
  ] as const) {
    vi.mocked(associations.queryProgIdCommand).mockClear()
    vi.mocked(associations.registerFileAssoc).mockClear()
    vi.mocked(associations.unregisterFileAssoc).mockClear()
    registerIpc(
      store,
      undefined,
      allowsFileAssociations(productIdentity({ zhumoChannel: channel }), true, background)
    )
    expect(await handlerFor(IPC.FileAssocStatus)()).toBe('off')
    await handlerFor(IPC.FileAssocSet)(undefined, true)
    await handlerFor(IPC.FileAssocSet)(undefined, false)
    expect(associations.queryProgIdCommand).not.toHaveBeenCalled()
    expect(associations.registerFileAssoc).not.toHaveBeenCalled()
    expect(associations.unregisterFileAssoc).not.toHaveBeenCalled()
  }
  registerIpc(
    store,
    undefined,
    allowsFileAssociations(productIdentity({ zhumoChannel: 'stable' }), true, false)
  )
  await handlerFor(IPC.FileAssocSet)(undefined, true)
  await handlerFor(IPC.FileAssocStatus)()
  await handlerFor(IPC.FileAssocSet)(undefined, false)
  expect(associations.queryProgIdCommand).toHaveBeenCalledOnce()
  expect(associations.registerFileAssoc).toHaveBeenCalledOnce()
  expect(associations.unregisterFileAssoc).toHaveBeenCalledOnce()
})

/** 造一本临时书（相对 testRoot），返回绝对路径 */
async function makeBook(relName: string, content: string): Promise<string> {
  const p = join(testRoot, relName)
  await writeFile(p, content, 'utf8')
  return p
}

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = electronStub.handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return handler
}

describe('IPC ReadBook：最近列表写入（T22）', () => {
  it('打开与另存默认进入文稿目录，取消不写文件，另存保留原稿', async () => {
    const store = new ZhuMoStore(await mkdtemp(join(testRoot, 'case-')))
    registerIpc(store)
    const original = await makeBook('目录原稿.md', '# 原稿')
    electronStub.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await handlerFor(IPC.OpenBookDialog)({ sender: undefined })).toBeNull()
    expect(electronStub.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: join(testRoot, '文稿') })
    )
    electronStub.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await handlerFor(IPC.SaveBookAs)({ sender: undefined }, original, '# 新稿')).toBeNull()
    const destination = join(testRoot, '文稿', '目录原稿.md')
    expect(electronStub.showSaveDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: destination })
    )
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    electronStub.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination })
    await handlerFor(IPC.SaveBookAs)({ sender: undefined }, original, '# 新稿')
    expect(await readFile(destination, 'utf8')).toBe('# 新稿')
    expect(await readFile(original, 'utf8')).toBe('# 原稿')
  })
  it('按路径开书成功后写入最近列表，name 为去扩展名文件名', async () => {
    const dir = await mkdtemp(join(testRoot, 'case-'))
    const store = new ZhuMoStore(dir)
    registerIpc(store)
    const bookPath = await makeBook('测证书.md', '# 你好\n\n正文。')

    const payload = (await handlerFor(IPC.ReadBook)(undefined, bookPath)) as {
      path: string
      title: string
    }
    expect(payload.path).toBe(bookPath)
    expect(payload.title).toBe('测证书')

    const list = await store.getRecentBooks()
    expect(list).toHaveLength(1)
    expect(list[0].path).toBe(bookPath)
    expect(list[0].name).toBe('测证书')
    expect(typeof list[0].lastOpenedAt).toBe('number')
  })

  it('读取失败不污染最近列表', async () => {
    const dir = await mkdtemp(join(testRoot, 'case-'))
    const store = new ZhuMoStore(dir)
    registerIpc(store)
    const ghost = join(testRoot, '不存在的书.md')

    await expect(handlerFor(IPC.ReadBook)(undefined, ghost)).rejects.toThrow('文件不存在')
    await expect(store.getRecentBooks()).resolves.toEqual([])
  })

  it('路径开书与对话框开书混合：去重、最新置顶、无重复条目', async () => {
    const dir = await mkdtemp(join(testRoot, 'case-'))
    const store = new ZhuMoStore(dir)
    registerIpc(store)
    const bookA = await makeBook('甲书.md', '# 甲')
    const bookB = await makeBook('乙书.txt', '乙')

    // 路径开书 A → 对话框开书 B：B 最新在顶
    await handlerFor(IPC.ReadBook)(undefined, bookA)
    electronStub.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [bookB] })
    await handlerFor(IPC.OpenBookDialog)({ sender: undefined })
    let list = await store.getRecentBooks()
    expect(list.map((b) => b.path)).toEqual([bookB, bookA])

    // 再按路径重开 A：去重置顶，仍恰好两条
    await handlerFor(IPC.ReadBook)(undefined, bookA)
    list = await store.getRecentBooks()
    expect(list).toHaveLength(2)
    expect(list[0].path).toBe(bookA)
    expect(list[0].name).toBe('甲书')

    // 对话框取消：列表不动
    electronStub.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handlerFor(IPC.OpenBookDialog)({ sender: undefined })).resolves.toBeNull()
    await expect(store.getRecentBooks().then((b) => b.map((x) => x.path))).resolves.toEqual([
      bookA,
      bookB
    ])
  })
})
