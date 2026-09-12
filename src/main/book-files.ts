import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BOOK_EXTENSIONS } from './args'
import { decodeBookBytes, encodeBookText, type BookEncoding } from './book-encoding'

const queue = new Map<string, Promise<unknown>>()
export const MAX_BOOK_BYTES = 50 * 1024 * 1024

/** Serialize writes to the same physical document, including windows with stale copies. */
export async function saveBookFile(
  path: string,
  content: string,
  expected: string | null
): Promise<void> {
  if (
    typeof path !== 'string' ||
    !path.trim() ||
    !BOOK_EXTENSIONS.includes(extname(path).toLowerCase())
  ) {
    throw new Error('只能保存为 .md、.markdown 或 .txt 文档')
  }
  if (typeof content !== 'string' || (expected !== null && typeof expected !== 'string')) {
    throw new Error('无效的文档内容')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BOOK_BYTES) throw new Error('文档超过 50 MB，未保存')
  let target: string
  try {
    target = await realpath(path)
  } catch {
    target = resolve(path)
  }
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  const previous = queue.get(key) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      const check = async (): Promise<BookEncoding> => {
        let disk: string | null = null
        let encoding: BookEncoding = 'utf-8'
        try {
          const decoded = decodeBookBytes(await readFile(target))
          disk = decoded.content
          encoding = decoded.encoding
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
        if (disk !== expected)
          throw new Error('文件已被其他程序修改，或已被移动。为保护双方内容，请另存为新文件。')
        return encoding
      }
      const encoding = await check()
      const bytes = encodeBookText(content, encoding)
      if (bytes.byteLength > MAX_BOOK_BYTES) throw new Error('文档超过 50 MB，未保存')
      const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
      try {
        const mode = await stat(target)
          .then((s) => s.mode)
          .catch(() => 0o666)
        const handle = await open(temp, 'wx', mode)
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        if ((await check()) !== encoding)
          throw new Error('文件编码已被其他程序修改，请另存为新文件。')
        await rename(temp, target)
      } finally {
        await rm(temp, { force: true }).catch(() => undefined)
      }
    })
  queue.set(key, task)
  try {
    await task
  } finally {
    if (queue.get(key) === task) queue.delete(key)
  }
}
