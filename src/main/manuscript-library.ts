import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureManuscriptDirectory } from './manuscript-directory'

export interface ManuscriptLocation {
  path: string
  available: boolean
  error?: string
}
class LibraryError extends Error {
  constructor(
    message: string,
    readonly path = ''
  ) {
    super(message)
  }
}
/** Test actual writes: fs.access(W_OK) alone does not fully test Windows ACLs. */
async function writableDirectory(directory: string): Promise<string> {
  const canonical = await realpath(directory)
  if (canonical === parse(canonical).root) throw Error('请选择具体的文稿文件夹。')
  if (!(await stat(canonical)).isDirectory()) throw Error('不是文件夹')
  const probe = join(canonical, '.zhumo-write-check-' + randomUUID() + '.tmp')
  const file = await open(probe, 'wx', 0o600)
  try {
    await file.writeFile('')
    await file.sync()
  } finally {
    await file.close()
    await unlink(probe)
  }
  return canonical
}
/** A profile owns one explicit library binding. Binary upgrades do not choose a new library.
 * Resolving symlinks once keeps the actual manuscripts reachable after an old version's
 * disposable junction is removed. A lost/offline library is never replaced with an empty one. */
export class ManuscriptLibrary {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private profile: string,
    private program: string,
    private documents: string
  ) {}
  private get file(): string {
    return join(this.profile, 'manuscript-library.v1.json')
  }
  private async read(): Promise<string | undefined> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new LibraryError('无法读取文稿位置记录，未改用其它目录。')
    }
    try {
      if (text.length > 32768) throw Error()
      const record = JSON.parse(text)
      if (
        record.version !== 1 ||
        typeof record.path !== 'string' ||
        !isAbsolute(record.path) ||
        record.path.includes('\0') ||
        record.path === parse(record.path).root
      )
        throw Error()
      return record.path
    } catch {
      throw new LibraryError(
        '文稿位置记录损坏，未覆盖记录或改用空目录。请在阅读设置中重新选择文稿文件夹。'
      )
    }
  }
  private async remember(path: string): Promise<void> {
    await mkdir(this.profile, { recursive: true })
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, path }, null, 2))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, this.file)
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation)
    this.queue = job.catch(() => undefined)
    return job
  }
  private async resolveInner(): Promise<string> {
    const stored = await this.read()
    if (stored) {
      try {
        return await writableDirectory(stored)
      } catch {
        throw new LibraryError(
          '原文稿文件夹暂不可用，未创建替代目录。请检查磁盘连接或在阅读设置中选择其当前位置。',
          stored
        )
      }
    }
    const directory = await ensureManuscriptDirectory(this.program, this.documents)
    const canonical = await writableDirectory(directory)
    await this.remember(canonical)
    return canonical
  }
  resolve(): Promise<string> {
    return this.run(() => this.resolveInner())
  }
  status(): Promise<ManuscriptLocation> {
    return this.run(async () => {
      try {
        return { path: await this.resolveInner(), available: true }
      } catch (error) {
        return {
          path: error instanceof LibraryError ? error.path : '',
          available: false,
          error: error instanceof Error ? error.message : '无法读取文稿位置。'
        }
      }
    })
  }
  /** Explicit user folder choice changes the binding only. No manuscript is moved or deleted. */
  select(directory: string): Promise<ManuscriptLocation> {
    return this.run(async () => {
      if (!isAbsolute(directory) || directory.includes('\0') || directory === parse(directory).root)
        throw new LibraryError('请选择一个具体的文稿文件夹。')
      const canonical = await writableDirectory(directory)
      await this.remember(canonical)
      return { path: canonical, available: true }
    })
  }
}
