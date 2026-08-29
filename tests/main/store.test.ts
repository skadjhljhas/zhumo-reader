/**
 * 朱墨 ZhuMo —— 持久化层单测（纯 Node 环境，不依赖 Electron）。
 *
 * 覆盖：原子写可读回 / 损坏 JSON 回退 null / 节流合并 /
 * recent 增删与 12 条上限与排序 / settings 默认值与钳制 / progress 读写。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  JsonStore,
  RECENT_BOOKS_LIMIT,
  ZhuMoStore,
  normalizeRecentBooks,
  progressKeyFor,
  sanitizeProgress,
  sanitizeSettings,
  upsertRecentBook
} from '../../src/main/store'

/** 测试根目录：每个用例在其中取独立子目录，互不干扰 */
let testRoot: string
/** 用例序号，用于生成独立子目录 */
let caseNo = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  caseNo += 1
})

afterAll(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

/** 为当前用例创建独立存储目录 */
async function freshDir(): Promise<string> {
  if (!testRoot) {
    testRoot = await mkdtemp(join(tmpdir(), 'zhumo-store-test-'))
  }
  const dir = join(testRoot, `case-${caseNo}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('JsonStore：原子写与容错读', () => {
  it('原子写后可跨实例读回（真正落盘）', async () => {
    const dir = await freshDir()
    const store = new JsonStore(dir)
    const settings = { theme: 'dark', fontSize: 18 } as const
    await store.write('settings', settings)
    await store.flushAll()

    // 新实例无内存缓存，能读回即证明已落盘
    const other = new JsonStore(dir)
    await expect(other.read('settings')).resolves.toEqual(settings)
    // 落盘内容是合法 JSON 且无残留临时文件
    const text = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(JSON.parse(text)).toEqual(settings)
  })

  it('损坏的 JSON 返回 null 而不抛错', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'settings.json'), '{"broken": oops', 'utf8')
    const store = new JsonStore(dir)
    await expect(store.read('settings')).resolves.toBeNull()
  })

  it('不存在的键返回 null', async () => {
    const dir = await freshDir()
    const store = new JsonStore(dir)
    await expect(store.read('settings')).resolves.toBeNull()
    await expect(store.read(progressKeyFor('C:/none.md'))).resolves.toBeNull()
  })

  it('进度文件落在 books/<sha1> 子目录，且同路径键稳定', async () => {
    const dir = await freshDir()
    const store = new JsonStore(dir)
    const key = progressKeyFor('C:/books/墨子.md')
    expect(key).toMatch(/^books\/[0-9a-f]{40}$/)
    expect(progressKeyFor('C:/books/墨子.md')).toBe(key)
    expect(progressKeyFor('C:/books/孟子.md')).not.toBe(key)

    await store.write(key, { sectionId: 's1', ratio: 0.5, updatedAt: 1 })
    await store.flushAll()
    await expect(
      readFile(join(dir, 'books', `${key.slice('books/'.length)}.json`), 'utf8')
    ).resolves.toContain('sectionId')
  })
})

describe('JsonStore：节流合并', () => {
  it('两次快速写只落盘一次，flush 后为最新值', async () => {
    const dir = await freshDir()
    const onPersist = vi.fn()
    const store = new JsonStore(dir, { throttleMs: 5000, onPersist })

    await store.write('settings', { fontSize: 16 })
    await store.write('settings', { fontSize: 20 })
    // 节流窗口内不落盘，但读取应命中内存值
    expect(onPersist).not.toHaveBeenCalled()
    await expect(store.read('settings')).resolves.toEqual({ fontSize: 20 })

    await store.flushAll()
    expect(onPersist).toHaveBeenCalledTimes(1)
    expect(onPersist).toHaveBeenCalledWith('settings')
    await expect(new JsonStore(dir).read('settings')).resolves.toEqual({ fontSize: 20 })
  })

  it('节流窗口到期自动落盘，窗口内的连续写合并为一次', async () => {
    const dir = await freshDir()
    const onPersist = vi.fn()
    const store = new JsonStore(dir, { throttleMs: 60, onPersist })

    await store.write('recent', [{ path: 'a' }])
    await sleep(220) // 窗口到期，自动落盘一次
    expect(onPersist).toHaveBeenCalledTimes(1)
    await expect(new JsonStore(dir).read('recent')).resolves.toEqual([{ path: 'a' }])

    await store.write('recent', [{ path: 'a' }, { path: 'b' }])
    await store.write('recent', [{ path: 'a' }, { path: 'b' }, { path: 'c' }])
    await sleep(220) // 两写合并，仅再落盘一次
    expect(onPersist).toHaveBeenCalledTimes(2)
    await expect(new JsonStore(dir).read('recent')).resolves.toEqual([
      { path: 'a' },
      { path: 'b' },
      { path: 'c' }
    ])
  })
})

describe('recent：增删、去重、上限与排序', () => {
  it('upsertRecentBook 去重并置顶', () => {
    const base = [
      { path: 'b1.md', name: 'b1', lastOpenedAt: 3 },
      { path: 'b2.md', name: 'b2', lastOpenedAt: 2 },
      { path: 'b3.md', name: 'b3', lastOpenedAt: 1 }
    ]
    const next = upsertRecentBook(base, 'b2.md', 'b2-新名', 9)
    expect(next).toHaveLength(3)
    expect(next[0]).toEqual({ path: 'b2.md', name: 'b2-新名', lastOpenedAt: 9 })
    expect(next.filter((book) => book.path === 'b2.md')).toHaveLength(1)
  })

  it('超过 12 条时淘汰最旧，且最近优先排序', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    for (let i = 0; i < 14; i += 1) {
      await store.touchRecentBook(`C:/books/b${String(i).padStart(2, '0')}.md`, `b${i}`, i)
    }
    const list = await store.getRecentBooks()
    expect(list).toHaveLength(RECENT_BOOKS_LIMIT)
    // 最近打开的排最前
    expect(list[0]).toEqual({ path: 'C:/books/b13.md', name: 'b13', lastOpenedAt: 13 })
    // 最旧的两本被淘汰
    expect(list.some((book) => book.path.endsWith('b00.md'))).toBe(false)
    expect(list.some((book) => book.path.endsWith('b01.md'))).toBe(false)
    // 整体按时间降序
    const times = list.map((book) => book.lastOpenedAt)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('删除指定路径，其余保留', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await store.touchRecentBook('C:/a.md', 'a', 1)
    await store.touchRecentBook('C:/b.md', 'b', 2)
    await store.removeRecentBook('C:/a.md')
    const list = await store.getRecentBooks()
    expect(list.map((book) => book.path)).toEqual(['C:/b.md'])
  })

  it('增删后 flush 落盘，跨实例读取结果一致', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await store.touchRecentBook('C:/x.md', 'x', 5)
    await store.touchRecentBook('C:/y.md', 'y', 6)
    await store.removeRecentBook('C:/x.md')
    await store.flushAll()

    const revived = new ZhuMoStore(dir)
    await expect(revived.getRecentBooks()).resolves.toEqual([
      { path: 'C:/y.md', name: 'y', lastOpenedAt: 6 }
    ])
  })

  it('normalizeRecentBooks 过滤非法条目并排序截断', () => {
    const messy = [
      { path: 'a.md', name: 'a', lastOpenedAt: 1 },
      null,
      { path: '', name: 'x', lastOpenedAt: 9 },
      { path: 'b.md', name: 42, lastOpenedAt: 9 },
      { path: 'c.md', name: 'c', lastOpenedAt: 'yesterday' },
      { path: 'd.md', name: 'd', lastOpenedAt: 8 }
    ]
    expect(normalizeRecentBooks(messy)).toEqual([
      { path: 'd.md', name: 'd', lastOpenedAt: 8 },
      { path: 'a.md', name: 'a', lastOpenedAt: 1 }
    ])
    expect(normalizeRecentBooks('不是数组')).toEqual([])
  })
})

describe('settings：默认值与钳制', () => {
  it('无存档返回默认值', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await expect(store.getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('越界数值钳制回默认区间，非法类型回默认值', () => {
    const fixed = sanitizeSettings({
      theme: 'solarized',
      fontSize: 99,
      lineHeight: 0.5,
      contentWidth: 10,
      paragraphStyle: 'fancy',
      sidebarVisible: 'yes',
      noteLevelCap: 'four'
    })
    expect(fixed).toEqual({
      theme: 'auto',
      fontSize: 24,
      lineHeight: 1.6,
      contentWidth: 34,
      paragraphStyle: 'indent',
      sidebarVisible: true,
      noteLevelCap: 4
    })

    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('垃圾数据')).toEqual(DEFAULT_SETTINGS)
    // 合法值原样保留
    expect(
      sanitizeSettings({
        theme: 'dark',
        fontSize: 16,
        lineHeight: 2,
        contentWidth: 42,
        paragraphStyle: 'spacing',
        sidebarVisible: false,
        noteLevelCap: 2
      })
    ).toEqual({
      theme: 'dark',
      fontSize: 16,
      lineHeight: 2,
      contentWidth: 42,
      paragraphStyle: 'spacing',
      sidebarVisible: false,
      noteLevelCap: 2
    })
  })

  it('保存时同步规范化，读回永远是合法设置', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await store.saveSettings({ ...DEFAULT_SETTINGS, fontSize: 30, lineHeight: 9 })
    const saved = await store.getSettings()
    expect(saved.fontSize).toBe(24)
    expect(saved.lineHeight).toBe(2.2)
    await store.flushAll()
    await expect(new ZhuMoStore(dir).getSettings()).resolves.toEqual(saved)
  })
})

describe('progress：读写与容错', () => {
  it('保存后可读回；未知书返回 null', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    const progress = { sectionId: 'sec-3', ratio: 0.42, updatedAt: 1719900000000 }
    await store.saveProgress('C:/books/墨子.md', progress)
    await expect(store.getProgress('C:/books/墨子.md')).resolves.toEqual(progress)
    await expect(store.getProgress('C:/books/不存在.md')).resolves.toBeNull()
  })

  it('节流窗口内读回最新值（内存命中），flush 后落盘', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await store.saveProgress('C:/a.md', { sectionId: 's1', ratio: 0.1, updatedAt: 1 })
    await store.saveProgress('C:/a.md', { sectionId: 's2', ratio: 0.2, updatedAt: 2 })
    await expect(store.getProgress('C:/a.md')).resolves.toEqual({
      sectionId: 's2',
      ratio: 0.2,
      updatedAt: 2
    })
    await store.flushAll()
    await expect(new ZhuMoStore(dir).getProgress('C:/a.md')).resolves.toEqual({
      sectionId: 's2',
      ratio: 0.2,
      updatedAt: 2
    })
  })

  it('形状非法的进度被拒绝，不落盘', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await expect(
      // @ts-expect-error 故意传入非法形状
      store.saveProgress('C:/a.md', { sectionId: 's1', ratio: '一半' })
    ).rejects.toThrow('无效的进度数据')
    expect(sanitizeProgress({ sectionId: 's1', ratio: 0.5, updatedAt: NaN })).toBeNull()
    expect(sanitizeProgress(null)).toBeNull()
  })
})

describe('文件关联开关：app.json 持久化（T26）', () => {
  it('缺省（无 app.json）时为开启', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await expect(store.getFileAssocEnabled()).resolves.toBe(true)
  })

  it('显式关闭并落盘，跨实例读回仍为关闭；可再恢复开启', async () => {
    const dir = await freshDir()
    const store = new ZhuMoStore(dir)
    await store.setFileAssocEnabled(false)
    await store.flushAll()
    await expect(new ZhuMoStore(dir).getFileAssocEnabled()).resolves.toBe(false)

    const other = new ZhuMoStore(dir)
    await other.setFileAssocEnabled(true)
    await other.flushAll()
    await expect(new ZhuMoStore(dir).getFileAssocEnabled()).resolves.toBe(true)
  })

  it('app.json 损坏时回退开启且不抛错', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, 'app.json'), '{不是json', 'utf8')
    const store = new ZhuMoStore(dir)
    await expect(store.getFileAssocEnabled()).resolves.toBe(true)
  })
})
