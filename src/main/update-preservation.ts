import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { physicalFs } from './physical-fs'
const {
  mkdir,
  open,
  lstat,
  realpath,
  readdir,
  readFile,
  rename,
  symlink,
  stat,
  utimes,
  chmod,
  copyFile
} = physicalFs
import { isAbsolute, join, relative, resolve, parse, sep } from 'node:path'

type FileEntry = {
  kind: 'file'
  path: string
  size: number
  sha256: string
  mtimeMs: number
  mode: number
}
type Entry =
  | FileEntry
  | { kind: 'directory'; path: string }
  | { kind: 'link'; path: string; resolved: string; targetKind: 'file' | 'directory' }
interface Root {
  source: string
  kind: 'file' | 'directory'
  entries: Entry[]
}
export interface PreservationManifest {
  version: 1
  id: string
  created: string
  roots: Root[]
}
export interface PreservationOptions {
  signal?: AbortSignal
  progress?: (files: number, bytes: number) => void | Promise<void>
}
const canonicalKey = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path
const beneath = (parent: string, child: string): boolean => {
  const r = relative(canonicalKey(parent), canonicalKey(child))
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
}
function check(options: PreservationOptions): void {
  options.signal?.throwIfAborted()
}
function safeRelative(path: string): void {
  if (
    path &&
    (isAbsolute(path) ||
      path
        .split(/[\\/]/)
        .some((p) => !p || p === '.' || p === '..' || p.includes(':') || p.includes('\0')))
  )
    throw Error('保存记录包含无效相对路径。')
}
export async function fileDigest(
  path: string,
  destination?: string,
  options: PreservationOptions = {}
): Promise<FileEntry> {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw Error('文件类型已改变，不能确认保存完整。')
  const input = await open(path, 'r')
  const output = destination
    ? await (async () => {
        check(options)
        // Native copying retains Windows named streams as well as the default stream.
        // The following source hash and the caller's readback still check file bytes.
        await copyFile(path, destination, constants.COPYFILE_EXCL)
        await chmod(destination, 0o600)
        return open(destination, 'r+')
      })().catch(async (e) => {
        await input.close()
        throw e
      })
    : undefined
  const hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  try {
    const opened = await input.stat({ bigint: true })
    if (before.ino !== opened.ino || before.dev !== opened.dev) throw Error('文件在读取前被替换。')
    for (;;) {
      check(options)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes)
      size += bytesRead
    }
    if (output) await output.sync()
    const after = await lstat(path, { bigint: true })
    if (
      !after.isFile() ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(size) !== before.size
    )
      throw Error('文件在保存期间发生改变，请正常退出朱墨后重试。')
    return {
      kind: 'file',
      path: '',
      size,
      sha256: hash.digest('hex'),
      mtimeMs: Number(before.mtimeNs) / 1_000_000,
      mode: Number(before.mode) & 0o777
    }
  } finally {
    await input.close()
    await output?.close()
  }
}
async function writeDurable(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2))
    await file.sync()
  } finally {
    await file.close()
  }
}
async function newDestination(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root)
    throw Error('请选择具体的全新保存目录。')
  const parent = await realpath(resolve(path, '..'))
  const target = join(parent, parse(path).base)
  try {
    await lstat(target)
    throw Error('目标已存在，不能覆盖已有文件。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}
async function inventory(
  source: string,
  payload: string | undefined,
  addRoot: (path: string) => Promise<void>,
  options: PreservationOptions
): Promise<Root> {
  const rootStat = await lstat(source)
  if (!rootStat.isDirectory() && !rootStat.isFile()) throw Error('不能保存此类型的根路径。')
  const root: Root = { source, kind: rootStat.isDirectory() ? 'directory' : 'file', entries: [] }
  const walk = async (path: string, name: string, depth: number): Promise<void> => {
    check(options)
    if (depth > 128 || root.entries.length > 1_000_000)
      throw Error('目录结构超出保存上限，尚未生成可用保存点。')
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const target = await realpath(path),
        type = await stat(target)
      if (!type.isDirectory() && !type.isFile()) throw Error('链接目标类型不受支持。')
      await addRoot(target)
      root.entries.push({
        kind: 'link',
        path: name,
        resolved: target,
        targetKind: type.isDirectory() ? 'directory' : 'file'
      })
      return
    }
    if (info.isDirectory()) {
      if (payload) await mkdir(join(payload, name))
      root.entries.push({ kind: 'directory', path: name })
      for (const child of (await readdir(path)).sort())
        await walk(join(path, child), name ? name + '/' + child : child, depth + 1)
    } else if (info.isFile()) {
      const file = await fileDigest(path, payload ? join(payload, name) : undefined, options)
      root.entries.push({ ...file, path: name })
    } else throw Error('目录含有无法逐字节保存的特殊文件。')
  }
  await walk(source, '', 0)
  return root
}

/** A complete, independently verified save point. No source is moved/deleted or opened for writing.
 * The caller must close readers/writers before using it to authorize an update. A two-pass
 * byte check detects changes during capture; it is not a substitute for that lifecycle lock. */
export async function createPreservationSnapshot(
  sources: string[],
  destination: string,
  options: PreservationOptions = {}
): Promise<string> {
  if (!sources.length || sources.some((path) => !isAbsolute(path)))
    throw Error('必须明确指定要保存的绝对路径。')
  const target = await newDestination(destination)
  const queued: string[] = [],
    seen = new Set<string>()
  const addRoot = async (path: string): Promise<void> => {
    const source = await realpath(path)
    if (source === parse(source).root || beneath(source, target) || beneath(target, source))
      throw Error('保存点不能包含自身，也不能把整个盘符作为数据根。')
    const key = canonicalKey(source)
    if (seen.has(key)) return
    if (queued.length >= 256) throw Error('关联目录过多，未完成保存。')
    seen.add(key)
    queued.push(source)
  }
  for (const source of sources) await addRoot(source)
  // Incomplete work remains inspectable, without the ready manifest, after errors or interruption.
  await mkdir(target, { mode: 0o700 })
  await mkdir(join(target, 'payload'))
  const manifest: PreservationManifest = {
    version: 1,
    id: randomUUID(),
    created: new Date().toISOString(),
    roots: []
  }
  let files = 0,
    bytes = 0
  for (let i = 0; i < queued.length; i++) {
    const root = await inventory(queued[i], join(target, 'payload', String(i)), addRoot, options)
    manifest.roots.push(root)
    for (const e of root.entries)
      if (e.kind === 'file') {
        files++
        bytes += e.size
      }
    await options.progress?.(files, bytes)
  }
  // Re-enumerate *all* source roots; additions, removals, retargeted links and bytes all matter.
  for (const root of manifest.roots) {
    const current = await inventory(
      root.source,
      undefined,
      async (path) => {
        if (!seen.has(canonicalKey(path))) throw Error('保存期间出现了新链接。')
      },
      options
    )
    if (JSON.stringify(current) !== JSON.stringify(root))
      throw Error('保存期间目录或文件发生改变，未授权继续更新。')
  }
  await verifyPayload(target, manifest, options)
  check(options)
  await writeDurable(join(target, 'manifest.pending.json'), manifest)
  await rename(join(target, 'manifest.pending.json'), join(target, 'manifest.json'))
  return target
}
function validateManifest(value: unknown): PreservationManifest {
  const m = value as PreservationManifest
  if (
    !m ||
    m.version !== 1 ||
    typeof m.id !== 'string' ||
    !Array.isArray(m.roots) ||
    !m.roots.length ||
    m.roots.length > 256
  )
    throw Error('保存记录无效。')
  const roots = new Set<string>()
  for (const root of m.roots) {
    if (
      !root ||
      typeof root.source !== 'string' ||
      !isAbsolute(root.source) ||
      !['file', 'directory'].includes(root.kind) ||
      !Array.isArray(root.entries) ||
      !root.entries.length
    )
      throw Error('保存根记录无效。')
    if (roots.has(canonicalKey(root.source))) throw Error('保存根重复。')
    roots.add(canonicalKey(root.source))
    const paths = new Map<string, Entry['kind']>()
    for (const entry of root.entries) {
      if (
        !entry ||
        typeof entry.path !== 'string' ||
        !['directory', 'file', 'link'].includes(entry.kind)
      )
        throw Error('保存文件记录无效。')
      safeRelative(entry.path)
      const key = canonicalKey(entry.path.replace(/\\/g, '/'))
      if (paths.has(key)) throw Error('保存记录包含冲突文件名。')
      paths.set(key, entry.kind)
      if (
        entry.kind === 'file' &&
        (!Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isFinite(entry.mtimeMs) ||
          !Number.isInteger(entry.mode) ||
          entry.mode < 0 ||
          entry.mode > 0o777)
      )
        throw Error('文件校验记录无效。')
      if (
        entry.kind === 'link' &&
        (typeof entry.resolved !== 'string' ||
          !isAbsolute(entry.resolved) ||
          !['file', 'directory'].includes(entry.targetKind))
      )
        throw Error('链接记录无效。')
    }
    if (paths.get('') !== root.kind) throw Error('保存根类型不一致。')
    for (const name of paths.keys())
      if (name) {
        const parts = name.split('/')
        parts.pop()
        if (paths.get(parts.join('/')) !== 'directory') throw Error('保存目录结构不完整。')
      }
  }
  for (const root of m.roots)
    for (const entry of root.entries)
      if (entry.kind === 'link') {
        const target = m.roots.find((r) => canonicalKey(r.source) === canonicalKey(entry.resolved))
        if (!target || target.kind !== entry.targetKind)
          throw Error('保存点缺少链接目标的完整内容。')
      }
  return m
}
async function verifyPayload(
  snapshot: string,
  manifest: PreservationManifest,
  options: PreservationOptions
): Promise<void> {
  for (const [index, root] of manifest.roots.entries()) {
    const payload = join(snapshot, 'payload', String(index))
    for (const entry of root.entries) {
      check(options)
      if (entry.kind === 'link') continue
      const path = join(payload, entry.path)
      // Every ancestor is separately checked as a real directory, never a reparse point.
      const parts = relative(snapshot, path).split(sep)
      let parent = snapshot
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part)
        const info = await lstat(parent)
        if (info.isSymbolicLink() || !info.isDirectory()) throw Error('保存目录被链接替换。')
      }
      if (entry.kind === 'directory') {
        const info = await lstat(path)
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('保存目录类型已改变。')
      } else {
        const actual = await fileDigest(path, undefined, options)
        if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
          throw Error('保存文件校验失败，不允许恢复或继续更新。')
      }
    }
  }
}
export async function verifyPreservationSnapshot(
  snapshot: string,
  options: PreservationOptions = {}
): Promise<PreservationManifest> {
  const canonical = await realpath(snapshot)
  const path = join(canonical, 'manifest.json')
  if ((await lstat(path)).isSymbolicLink()) throw Error('保存清单不能是链接。')
  const manifest = validateManifest(JSON.parse(await readFile(path, 'utf8')))
  await verifyPayload(canonical, manifest, options)
  return manifest
}
/** Restore into a new sibling staging directory, then atomically publish the complete tree.
 * No overlay into a live profile: Local State, LevelDB, settings and key ciphertext travel
 * together. Link targets are rebased to recovered roots, never to the user's live files. */
export async function restorePreservationSnapshot(
  snapshot: string,
  destination: string,
  options: PreservationOptions = {}
): Promise<string[]> {
  const manifest = await verifyPreservationSnapshot(snapshot, options)
  const target = await newDestination(destination)
  const staging = target + '.restoring-' + randomUUID()
  if (beneath(await realpath(snapshot), target)) throw Error('恢复位置不能放在保存点内部。')
  await mkdir(staging, { mode: 0o700 })
  for (const [index, root] of manifest.roots.entries()) {
    for (const entry of root.entries) {
      check(options)
      const path = join(staging, String(index), entry.path)
      if (entry.kind === 'directory') await mkdir(path)
      else if (entry.kind === 'file') {
        const actual = await fileDigest(
          join(snapshot, 'payload', String(index), entry.path),
          path,
          options
        )
        if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
          throw Error('恢复期间保存点发生变化。')
        await utimes(path, new Date(), new Date(entry.mtimeMs))
        await chmod(path, entry.mode)
        const copied = await fileDigest(path, undefined, options)
        if (copied.sha256 !== entry.sha256 || copied.size !== entry.size)
          throw Error('恢复副本校验失败，未发布恢复目录。')
      }
    }
  }
  for (const [index, root] of manifest.roots.entries())
    for (const entry of root.entries)
      if (entry.kind === 'link') {
        check(options)
        const to = manifest.roots.findIndex(
          (r) => canonicalKey(r.source) === canonicalKey(entry.resolved)
        )
        // Relative symlinks work on POSIX; Windows directory junctions support non-admin users.
        const link = join(staging, String(index), entry.path)
        const mapped = join(target, String(to))
        await symlink(
          process.platform === 'win32'
            ? mapped
            : relative(resolve(link, '..'), join(staging, String(to))),
          link,
          entry.targetKind === 'directory' ? 'junction' : 'file'
        )
      }
  await writeDurable(join(staging, 'recovery.json'), {
    snapshot: resolve(snapshot),
    id: manifest.id,
    roots: manifest.roots.map((r, index) => ({
      original: r.source,
      recovered: join(target, String(index))
    }))
  })
  check(options)
  // Refuse an intervening destination creation; a caller must not treat the staging tree as ready.
  await newDestination(target)
  await rename(staging, target)
  return manifest.roots.map((_, index) => join(target, String(index)))
}
