import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveBookFile } from '../../src/main/book-files'
import { decodeBookBytes, encodeBookText, type BookEncoding } from '../../src/main/book-encoding'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-save-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe('Atomic document saves', () => {
  it.each(['utf-16le', 'utf-16be'] as BookEncoding[])(
    'preserves BOM and %s encoding when editing a Windows text file',
    async (encoding) => {
      const path = join(root, 'unicode.md')
      const original = '\uFEFF# 中文文稿\r\n原文🖋️'
      await writeFile(path, encodeBookText(original, encoding))
      expect(decodeBookBytes(await readFile(path))).toEqual({ content: original, encoding })
      await saveBookFile(path, original + '\r\n续文', original)
      expect(await readFile(path)).toEqual(encodeBookText(original + '\r\n续文', encoding))
    }
  )
  it('never overwrites invalid UTF-8 with replacement characters', async () => {
    const path = join(root, 'legacy.md'),
      bytes = Buffer.from([0x81, 0x40, 0xff])
    await writeFile(path, bytes)
    expect(() => decodeBookBytes(bytes)).toThrow('UTF-8')
    await expect(saveBookFile(path, 'new', bytes.toString('utf8'))).rejects.toThrow('UTF-8')
    expect(await readFile(path)).toEqual(bytes)
  })
  it('saves exactly the provided bytes, with no leftover temp files', async () => {
    const path = join(root, '中文书.md'),
      original = '\uFEFF# 题目\r\n原文  \r\n',
      next = original + '追加 🐈\r\n'
    await writeFile(path, original)
    await saveBookFile(path, next, original)
    expect(await readFile(path, 'utf8')).toBe(next)
    expect(await readdir(root)).toEqual(['中文书.md'])
  })
  it('protects external edits and deleted originals', async () => {
    const path = join(root, 'book.md')
    await writeFile(path, 'external')
    await expect(saveBookFile(path, 'mine', 'old')).rejects.toThrow('其他程序修改')
    expect(await readFile(path, 'utf8')).toBe('external')
    await rm(path)
    await expect(saveBookFile(path, 'mine', 'old')).rejects.toThrow('被移动')
    expect(await readdir(root)).toEqual([])
  })
  it('lets only one stale writer commit, and never truncates the winning document', async () => {
    const path = join(root, 'concurrent.md')
    await writeFile(path, 'original')
    const results = await Promise.allSettled([
      saveBookFile(path, 'first', 'original'),
      saveBookFile(path, 'second', 'original')
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(['first', 'second']).toContain(await readFile(path, 'utf8'))
    expect(await readdir(root)).toEqual(['concurrent.md'])
  })
  it('creates a new document, rejects an occupied target and forbidden extension', async () => {
    const path = join(root, 'new.md')
    await saveBookFile(path, 'new', null)
    await expect(saveBookFile(path, 'overwrite', null)).rejects.toThrow('其他程序修改')
    await expect(saveBookFile(join(root, 'new.exe'), '', null)).rejects.toThrow('只能保存')
  })
})
