import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ImportedFont, FontPayload } from '../shared/ipc-types'

const MAX_BYTES = 96 * 1024 * 1024
const idPattern = /^[a-f0-9]{64}$/
/** Fonts belong to the profile, independently of the program and manuscript locations. */
export class FontLibrary {
  private directory: string
  constructor(profile: string) {
    this.directory = join(profile, 'fonts')
  }
  async list(): Promise<ImportedFont[]> {
    const files = await readdir(this.directory).catch(() => [])
    const result: ImportedFont[] = []
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      try {
        const font = JSON.parse(await readFile(join(this.directory, file), 'utf8')) as ImportedFont
        if (font.id + '.json' === file && typeof font.name === 'string' && font.name.length < 250)
          result.push(font)
      } catch {
        /* A damaged entry does not hide other fonts. */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
  async import(path: string): Promise<FontPayload> {
    const handle = await open(path, 'r')
    let bytes: Buffer
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 12 || stat.size > MAX_BYTES)
        throw new Error('请选择不超过 96 MB 的字体文件。')
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    const signature = bytes.toString('latin1', 0, 4)
    if (!['\x00\x01\x00\x00', 'OTTO', 'true', 'wOFF', 'wOF2', 'ttcf'].includes(signature))
      throw new Error('这不是可识别的 OpenType、TrueType 或 Web 字体。')
    const id = createHash('sha256').update(bytes).digest('hex')
    const font = { id, name: basename(path, extname(path)).slice(0, 240), bytes: bytes.length }
    await mkdir(this.directory, { recursive: true })
    // Reimport can repair an interrupted write; a different font always has a different address.
    for (const [suffix, data] of [
      ['font', bytes],
      ['json', JSON.stringify(font)]
    ] as const) {
      const target = join(this.directory, id + '.' + suffix)
      const expected = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const previous = await readFile(target).catch(() => null)
      if (previous?.equals(expected)) continue
      const temporary = target + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx')
      try {
        await file.writeFile(data)
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await rename(temporary, target)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    }
    return { font, data: new Uint8Array(bytes) }
  }
  async read(id: string): Promise<Uint8Array> {
    if (!idPattern.test(id)) throw new Error('无效的字体编号。')
    const handle = await open(join(this.directory, id + '.font'), 'r')
    try {
      if ((await handle.stat()).size > MAX_BYTES) throw new Error('字体文件过大。')
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') !== id)
        throw new Error('字体文件已经损坏，请重新导入。')
      return new Uint8Array(bytes)
    } finally {
      await handle.close()
    }
  }
}
