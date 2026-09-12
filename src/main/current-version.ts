import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isAbsolute, join, parse, relative, resolve, sep, dirname } from 'node:path'
import { promisify } from 'node:util'
import { physicalFs as fs } from './physical-fs'
import { readProgramManifest, programManifestHash as digest } from './program-files'
import { inspectNativePathAttributes } from './native-file-helper'

export interface CurrentVersionPointer {
  version: 1
  releaseId: string
  transactionId: string
  manifestSha256: string
  appId: string
  appVersion: string
  executable: string
  /** Protected settings profile; this is never an executable or a relative version path. */
  profile?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const POINTER_LIMIT = 65536
const MANIFEST_LIMIT = 64 * 1024 * 1024
const pointerFields = [
  'version',
  'releaseId',
  'transactionId',
  'manifestSha256',
  'appId',
  'appVersion',
  'executable'
]
const execute = promisify(execFile)
const pending = new Map<string, Promise<void>>()
const canonical = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path
const samePath = (a: string, b: string): boolean => canonical(a) === canonical(b)
const within = (root: string, path: string): boolean => {
  const part = relative(canonical(root), canonical(path))
  return Boolean(part) && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

function rootPath(input: string): string {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0'))
    throw Error('当前版本必须使用绝对安装目录。')
  const path = resolve(input)
  if (samePath(path, parse(path).root)) throw Error('不能把盘根作为当前版本的安装目录。')
  return path
}

/** Node exposes symlinks/junctions, but not every Windows reparse tag. */
async function rejectReparsePoints(paths: string[]): Promise<void> {
  if (process.platform !== 'win32') return
  if (await inspectNativePathAttributes(paths)) return
  const literal = JSON.stringify(paths).replace(/'/g, "''")
  const script = `try {
    $paths = ConvertFrom-Json -InputObject '${literal}'
    foreach ($path in $paths) {
      $item = Get-Item -Force -LiteralPath $path -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    }
    [Console]::Out.Write('ok')
  } catch { [Console]::Error.Write('Unsafe update path'); exit 1 }`
  try {
    const { stdout } = await execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }
    )
    if (stdout !== 'ok') throw Error('unconfirmed')
  } catch {
    throw Error('无法确认当前版本路径不含重解析点，未切换版本。')
  }
}

/** Check every ancestor, not just the final directory after realpath has followed it. */
export async function assertPlainDirectory(path: string): Promise<void> {
  const base = parse(path).root
  let at = base
  const ancestors = [base]
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    at = join(at, part)
    ancestors.push(at)
  }
  for (const member of ancestors) {
    const info = await fs.lstat(member)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !samePath(await fs.realpath(member), member)
    )
      throw Error('当前版本路径含链接、别名或非目录，未切换版本。')
  }
  await rejectReparsePoints(ancestors)
}
const directory = assertPlainDirectory

function parsePointer(bytes: string): CurrentVersionPointer {
  let value: CurrentVersionPointer
  try {
    value = JSON.parse(bytes)
  } catch {
    throw Error('当前版本指针不是完整有效的 JSON，不能当作首次安装。')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !==
      pointerFields.length + (Object.hasOwn(value, 'profile') ? 1 : 0) ||
    !pointerFields.every((field) => Object.hasOwn(value, field)) ||
    value.version !== 1 ||
    typeof value.releaseId !== 'string' ||
    !UUID.test(value.releaseId) ||
    typeof value.transactionId !== 'string' ||
    !UUID.test(value.transactionId) ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.manifestSha256) ||
    ![value.appId, value.appVersion].every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        part.length <= 256 &&
        part.trim() === part &&
        ![...part].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    ) ||
    typeof value.executable !== 'string' ||
    !value.executable ||
    value.executable.length > 4096
  )
    throw Error('当前版本指针字段无效，不能当作首次安装。')
  if (Object.hasOwn(value, 'profile')) {
    if (
      typeof value.profile !== 'string' ||
      value.profile.includes('\r') ||
      value.profile.includes('\n')
    )
      throw Error('当前版本配置目录必须是有效的绝对目录路径。')
    // Only validate syntax here. A profile can live outside this installation and may
    // need normal main-process initialization; resolving an executable must not open it.
    rootPath(value.profile)
  }
  // Reuse the manifest's full Windows-relative-path validator; the real manifest is
  // separately read and hashed before resolving or publishing this pointer.
  const identity = JSON.stringify({
    version: 1,
    appId: value.appId,
    appVersion: value.appVersion,
    platform: 'win32',
    executable: value.executable,
    files: [...new Set([value.executable, 'resources/app.asar'])].map((path) => ({
      path,
      size: 0,
      sha256: '0'.repeat(64)
    }))
  })
  // The digest authenticates neither a provider nor a publisher; it verifies exact bytes.
  readProgramManifest(identity, digest(identity))
  return value
}

async function regularFile(path: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const info = await fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw Error('当前版本元数据或入口不是独立的普通文件，不能使用链接。')
  if (!samePath(await fs.realpath(path), path)) throw Error('当前版本文件路径已偏离安装目录。')
  await rejectReparsePoints([path])
  return info
}

async function bytesFromFile(path: string, limit: number): Promise<Buffer> {
  const before = await regularFile(path)
  if (before.size > limit) throw Error('当前版本元数据超过允许大小。')
  const handle = await fs.open(path, 'r')
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw Error('当前版本文件在打开时被替换。')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const named = await fs.lstat(path)
    if (
      bytes.length > limit ||
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1 ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw Error('当前版本文件在读取期间发生变化。')
    return bytes
  } finally {
    await handle.close()
  }
}

async function readAtRoot(
  root: string
): Promise<{ pointer: CurrentVersionPointer; bytes: string } | null> {
  await directory(root)
  const metadata = join(root, '.zhumo')
  try {
    await fs.lstat(metadata)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  await directory(metadata)
  const file = join(metadata, 'current.json')
  try {
    await fs.lstat(file)
  } catch (error) {
    if (!missing(error)) throw error
    await directory(metadata)
    return null
  }
  const raw = await bytesFromFile(file, POINTER_LIMIT)
  let bytes: string
  try {
    bytes = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  } catch {
    throw Error('当前版本指针包含无效 UTF-8，不能当作首次安装。')
  }
  return { pointer: parsePointer(bytes), bytes }
}

export async function readCurrentVersion(
  installRoot: string
): Promise<{ pointer: CurrentVersionPointer; bytes: string } | null> {
  return readAtRoot(rootPath(installRoot))
}

async function resolvePointer(
  root: string,
  pointer: CurrentVersionPointer
): Promise<{ directory: string; pointer: CurrentVersionPointer; manifestBytes: Buffer }> {
  const path = join(root, '.zhumo', 'versions', pointer.releaseId)
  await directory(path)
  const actual = await fs.realpath(path)
  if (!samePath(actual, path) || !within(root, actual)) throw Error('当前版本目录超出安装根。')
  const manifestBytes = await bytesFromFile(join(path, 'program-files.v1.json'), MANIFEST_LIMIT)
  const manifest = readProgramManifest(manifestBytes, pointer.manifestSha256)
  if (
    manifest.appId !== pointer.appId ||
    manifest.appVersion !== pointer.appVersion ||
    manifest.executable !== pointer.executable
  )
    throw Error('当前版本指针与发行清单身份不一致。')
  const executable = join(path, pointer.executable)
  if (!within(path, executable)) throw Error('当前版本入口超出版本目录。')
  await directory(dirname(executable))
  await regularFile(executable)
  return { directory: actual, pointer, manifestBytes }
}

export async function resolveCurrentVersion(
  installRoot: string
): Promise<{ directory: string; pointer: CurrentVersionPointer; manifestBytes: Buffer }> {
  const root = rootPath(installRoot)
  const current = await readAtRoot(root)
  if (!current) throw Error('当前版本指针不存在，不能解析启动入口。')
  const resolved = await resolvePointer(root, current.pointer)
  if ((await readAtRoot(root))?.bytes !== current.bytes)
    throw Error('解析期间当前版本已切换，请重新读取。')
  return resolved
}

async function serialized(root: string, run: () => Promise<void>): Promise<void> {
  const key = canonical(root)
  // Admission serializes processes. Also serialize accidental concurrent publications
  // within its one admitted coordinator, so both cannot pass the same expected bytes.
  const previous = pending.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(run)
  pending.set(key, operation)
  try {
    await operation
  } finally {
    if (pending.get(key) === operation) pending.delete(key)
  }
}

async function writePointer(
  root: string,
  pointer: CurrentVersionPointer,
  bytes: string,
  expectedBytes: string | null
): Promise<void> {
  if (((await readAtRoot(root))?.bytes ?? null) !== expectedBytes)
    throw Error('当前版本已改变，原始指针不匹配，未发布。')
  await resolvePointer(root, pointer)
  const metadata = join(root, '.zhumo')
  const temporary = join(metadata, `.current-${randomUUID()}.tmp`)
  let owned: { ino: number; dev: number } | undefined
  let published = false
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      const info = await handle.stat()
      owned = { ino: info.ino, dev: info.dev }
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!(await bytesFromFile(temporary, POINTER_LIMIT)).equals(Buffer.from(bytes)))
      throw Error('临时版本指针写入校验失败，未发布。')
    await resolvePointer(root, pointer)
    if (((await readAtRoot(root))?.bytes ?? null) !== expectedBytes)
      throw Error('发布前当前版本已改变，原始指针不匹配，未发布。')
    await fs.rename(temporary, join(metadata, 'current.json'))
    published = true
    // No fallible post-commit work: a rejected publish must never mean "new pointer active".
  } finally {
    if (owned && !published) {
      try {
        await directory(metadata)
        const info = await fs.lstat(temporary)
        if (!info.isSymbolicLink() && info.ino === owned.ino && info.dev === owned.dev)
          await fs.unlink(temporary)
      } catch {
        // An unremovable owned temporary is inert. Never delete an unknown replacement.
      }
    }
  }
}

/** Caller must hold update admission over installRoot for this entire operation. */
export async function publishCurrentVersion(
  installRoot: string,
  next: CurrentVersionPointer,
  expectedBytes: string | null
): Promise<void> {
  const root = rootPath(installRoot)
  if (expectedBytes !== null && typeof expectedBytes !== 'string')
    throw Error('切换当前版本必须提供原始指针字节或明确的首次安装空值。')
  const bytes = JSON.stringify(next) + '\n'
  if (Buffer.byteLength(bytes) > POINTER_LIMIT) throw Error('当前版本指针超过允许大小。')
  const pointer = parsePointer(bytes)
  await serialized(root, () => writePointer(root, pointer, bytes, expectedBytes))
}

/** Restore journaled bytes under the same admission as publishing. null restores absence. */
export async function restoreCurrentVersion(
  installRoot: string,
  previousBytes: string | null,
  expectedBytes: string | null
): Promise<void> {
  const root = rootPath(installRoot)
  if (
    expectedBytes !== null &&
    (typeof expectedBytes !== 'string' || Buffer.byteLength(expectedBytes) > POINTER_LIMIT)
  )
    throw Error('回滚必须提供本次已发布指针的原始字节。')
  if (expectedBytes !== null) parsePointer(expectedBytes)
  if (
    previousBytes !== null &&
    (typeof previousBytes !== 'string' || Buffer.byteLength(previousBytes) > POINTER_LIMIT)
  )
    throw Error('回滚记录必须是原始指针字节或明确的首次安装空值。')
  const previous = previousBytes === null ? null : parsePointer(previousBytes)
  await serialized(root, async () => {
    if (previous && previousBytes !== null) {
      await writePointer(root, previous, previousBytes, expectedBytes)
      return
    }
    if (expectedBytes === null) {
      if (await readAtRoot(root)) throw Error('当前版本已改变，未恢复空入口。')
      return
    }
    if ((await readAtRoot(root))?.bytes !== expectedBytes)
      throw Error('当前版本已改变，原始指针不匹配，未回滚。')
    const metadata = join(root, '.zhumo')
    const archive = join(metadata, `current.aborted.${randomUUID()}.json`)
    try {
      await fs.lstat(archive)
      throw Error('回滚记录名称已存在，未覆盖任何文件。')
    } catch (error) {
      if (!missing(error)) throw error
    }
    // Every conforming writer holds admission. Recheck both source and absence just
    // before this atomic move; an existing archive is never an overwrite target.
    if ((await readAtRoot(root))?.bytes !== expectedBytes)
      throw Error('回滚前当前版本已改变，原始指针不匹配，未回滚。')
    try {
      await fs.lstat(archive)
      throw Error('回滚记录名称已存在，未覆盖任何文件。')
    } catch (error) {
      if (!missing(error)) throw error
    }
    await fs.rename(join(metadata, 'current.json'), archive)
    // Keep the complete archived record and all release directories; never unlink current.
  })
}
