import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { physicalFs } from './physical-fs'
const {
  lstat,
  realpath,
  readdir,
  mkdir,
  readFile,
  open,
  rename,
  unlink,
  chmod,
  utimes,
  stat,
  copyFile
} = physicalFs
import { join, isAbsolute, relative, parse, sep, dirname } from 'node:path'
import { fileDigest } from './update-preservation'
import { moveFileExclusive } from './exclusive-move'

export interface ProgramFile {
  path: string
  size: number
  sha256: string
}
export interface ProgramManifest {
  version: 1
  appId: string
  appVersion: string
  platform: 'win32'
  executable: string
  files: ProgramFile[]
}
export interface ProgramAudit {
  identity: 'matched' | 'missing' | 'changed'
  protectedDocuments: string[]
  unchanged: ProgramFile[]
  changed: string[]
  missing: string[]
  linked: string[]
  unlisted: string[]
}
export interface ProgramRetirementResult extends ProgramAudit {
  retired: string[]
}
async function installationIdentity(
  root: string,
  expectedHash: string
): Promise<ProgramAudit['identity']> {
  const path = join(root, 'program-files.v1.json')
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) return 'changed'
  return programManifestHash(await readFile(path)) === expectedHash ? 'matched' : 'changed'
}
const key = (p: string): string => p.toLowerCase()
const within = (parent: string, child: string): boolean => {
  const p = relative(key(parent), key(child))
  return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep))
}
export const programManifestHash = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')
function validPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[<>:"|?*]/.test(p) ||
          [...p].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)
      )
  )
    throw Error('程序清单含无效或有歧义的Windows相对路径。')
}
export function readProgramManifest(bytes: string | Buffer, expectedHash: string): ProgramManifest {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || programManifestHash(bytes) !== expectedHash)
    throw Error('程序清单不符合受信校验值，未处理任何文件。')
  let m: ProgramManifest
  try {
    m = JSON.parse(bytes.toString())
  } catch {
    throw Error('程序清单内容不是有效JSON。')
  }
  if (
    !m ||
    m.version !== 1 ||
    m.platform !== 'win32' ||
    typeof m.appId !== 'string' ||
    !m.appId ||
    typeof m.appVersion !== 'string' ||
    !m.appVersion ||
    !Array.isArray(m.files) ||
    !m.files.length ||
    m.files.length > 100000
  )
    throw Error('程序清单格式无效。')
  validPath(m.executable)
  const seen = new Set<string>()
  for (const file of m.files) {
    if (!file) throw Error('程序文件记录无效。')
    validPath(file.path)
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      seen.has(key(file.path))
    )
      throw Error('程序文件记录重复或校验信息无效。')
    seen.add(key(file.path))
  }
  if (!seen.has(key(m.executable)) || !seen.has('resources/app.asar'))
    throw Error('程序清单缺少入口或应用包。')
  for (const path of seen) {
    const parts = path.split('/')
    parts.pop()
    while (parts.length) {
      if (seen.has(parts.join('/'))) throw Error('程序清单存在文件与目录冲突。')
      parts.pop()
    }
  }
  return m
}
async function rootDirectory(root: string): Promise<string> {
  if (!isAbsolute(root)) throw Error('必须使用绝对程序目录。')
  const path = await realpath(root)
  if (path === parse(path).root || !(await stat(path)).isDirectory())
    throw Error('不能把盘符或非目录作为程序目录。')
  return path
}
async function member(
  root: string,
  path: string
): Promise<'file' | 'missing' | 'linked' | 'other'> {
  validPath(path)
  let at = root
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    at = join(at, part)
    let s
    try {
      s = await lstat(at)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
    if (s.isSymbolicLink()) return 'linked'
    if (index < parts.length - 1 ? !s.isDirectory() : !s.isFile()) return 'other'
  }
  return 'file'
}
/** Build-time only: allowed paths must come from the trusted runtime/source build, never
 * by enumerating an existing user installation and declaring everything there to be ours. */
export async function createProgramManifest(
  stage: string,
  identity: Omit<ProgramManifest, 'version' | 'files' | 'platform'>,
  allowed: string[]
): Promise<ProgramManifest> {
  const root = await rootDirectory(stage),
    permitted = new Set(
      allowed.map((path) => {
        validPath(path)
        return key(path)
      })
    )
  const files: ProgramFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir ? dir + '/' + entry.name : entry.name
      if (path === 'program-files.v1.json') continue
      validPath(path)
      if (entry.isSymbolicLink()) throw Error('发行暂存目录不能含链接。')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        if (!permitted.has(key(path)))
          throw Error('发行目录混入了未声明的文件，拒绝把它登记为程序文件：' + path)
        const hash = await fileDigest(join(root, path))
        files.push({ path, size: hash.size, sha256: hash.sha256 })
      } else throw Error('发行目录含特殊文件。')
    }
  }
  await walk('')
  const result: ProgramManifest = {
    version: 1,
    ...identity,
    platform: 'win32',
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  }
  const bytes = JSON.stringify(result)
  readProgramManifest(bytes, programManifestHash(bytes))
  return result
}
export async function auditProgramFiles(
  directory: string,
  manifestBytes: string | Buffer,
  expectedHash: string
): Promise<ProgramAudit> {
  const manifest = readProgramManifest(manifestBytes, expectedHash),
    root = await rootDirectory(directory)
  const audit: ProgramAudit = {
    identity: await installationIdentity(root, expectedHash),
    protectedDocuments: [],
    unchanged: [],
    changed: [],
    missing: [],
    linked: [],
    unlisted: []
  }
  const names = new Set(manifest.files.map((f) => key(f.path)))
  for (const file of manifest.files) {
    const kind = await member(root, file.path)
    if (kind !== 'missing' && /\.(md|markdown|epub)$/i.test(file.path))
      audit.protectedDocuments.push(file.path)
    if (kind !== 'file') {
      audit[kind === 'other' ? 'changed' : kind].push(file.path)
      continue
    }
    const current = await fileDigest(join(root, file.path))
    if (current.sha256 === file.sha256 && current.size === file.size) audit.unchanged.push(file)
    else audit.changed.push(file.path)
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir ? dir + '/' + entry.name : entry.name
      if (names.has(key(path))) continue
      // Never follow an unlisted link or inventory private books merely to retain them.
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        [...names].some((p) => p.startsWith(key(path) + '/'))
      )
        await walk(path)
      else if (!entry.isDirectory() || ![...names].some((p) => p.startsWith(key(path) + '/')))
        audit.unlisted.push(path)
    }
  }
  await walk('')
  return audit
}
interface RetiredFile extends ProgramFile {
  mode: number
  mtimeMs: number
  state: 'pending' | 'moved' | 'kept' | 'restored'
}
interface Retirement {
  version: 1
  root: string
  manifestHash: string
  state: 'moving' | 'retired' | 'rolled-back' | 'recovery-needed'
  files: RetiredFile[]
  audit: ProgramAudit
}
async function journal(directory: string, value: Retirement): Promise<void> {
  const pending = join(directory, 'journal-' + randomUUID() + '.tmp'),
    file = await open(pending, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(pending, join(directory, 'retirement.json'))
}
async function publishOriginal(root: string, storage: string, file: RetiredFile): Promise<boolean> {
  const state = await member(root, file.path)
  if (state === 'file') {
    const current = await fileDigest(join(root, file.path))
    return current.sha256 === file.sha256 && current.size === file.size
  }
  if (state !== 'missing') return false
  // Retire never deletes directories, so missing parents indicate outside changes. Do not
  // reconstruct them through a replaced symlink or overwrite another writer's new file.
  const target = join(root, file.path),
    parent = dirname(target)
  if (key(await realpath(parent)) !== key(parent)) return false
  const temp = join(parent, '.zhumo-restore-' + randomUUID() + '.tmp')
  try {
    // Native Windows copying also retains named streams, unlike a manual default-stream
    // byte loop. The exclusive temporary name and hash readback still protect publication.
    await copyFile(storage, temp, constants.COPYFILE_EXCL)
    await chmod(temp, 0o600)
    const copied = await fileDigest(temp)
    if (copied.sha256 !== file.sha256 || copied.size !== file.size)
      throw Error('暂存程序文件校验失败。')
    const check = await fileDigest(temp)
    if (check.sha256 !== file.sha256) throw Error('恢复副本写入不完整。')
    await moveFileExclusive(temp, target)
    await utimes(target, new Date(), new Date(file.mtimeMs))
    await chmod(target, file.mode)
    return true
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
export async function restoreRetiredProgramFiles(
  directory: string,
  manifestBytes: string | Buffer,
  expectedHash: string,
  storage: string
): Promise<{ restored: string[]; conflicts: string[] }> {
  const manifest = readProgramManifest(manifestBytes, expectedHash),
    root = await rootDirectory(directory),
    store = await rootDirectory(storage)
  if (within(root, store) || within(store, root)) throw Error('恢复暂存位置不能与程序目录重叠。')
  if ((await installationIdentity(root, expectedHash)) !== 'matched')
    throw Error('程序目录缺少匹配的发行身份，或已经切换版本，不能合并回滚。')
  if ((await lstat(join(store, 'retirement.json'))).isSymbolicLink())
    throw Error('暂存日志不能是链接。')
  const record = JSON.parse(await readFile(join(store, 'retirement.json'), 'utf8')) as Retirement
  if (
    !record ||
    record.version !== 1 ||
    typeof record.root !== 'string' ||
    key(record.root) !== key(root) ||
    record.manifestHash !== expectedHash ||
    !Array.isArray(record.files) ||
    record.files.length > manifest.files.length
  )
    throw Error('暂存日志与本次程序目录或受信清单不匹配。')
  const allowed = new Set(manifest.files.map((f) => key(f.path))),
    seen = new Set<string>()
  for (const file of record.files) {
    if (!file) throw Error('暂存文件记录无效。')
    validPath(file.path)
    if (
      !allowed.has(key(file.path)) ||
      seen.has(key(file.path)) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      !Number.isFinite(file.mtimeMs) ||
      !['pending', 'moved', 'kept', 'restored'].includes(file.state)
    )
      throw Error('暂存文件不属于受信程序清单。')
    seen.add(key(file.path))
  }
  const restored: string[] = [],
    conflicts: string[] = []
  for (const file of [...record.files].reverse()) {
    try {
      const stored = await member(store, 'files/' + file.path)
      if (
        stored === 'missing' &&
        (file.state === 'pending' || file.state === 'kept') &&
        (await member(root, file.path)) !== 'missing'
      ) {
        file.state = 'kept'
        continue
      }
      if (stored !== 'file') {
        conflicts.push(file.path)
        continue
      }
      const current = await fileDigest(join(store, 'files', file.path))
      if (current.sha256 !== file.sha256 || current.size !== file.size) {
        conflicts.push(file.path)
        continue
      }
      if (await publishOriginal(root, join(store, 'files', file.path), file)) {
        file.state = 'restored'
        restored.push(file.path)
      } else conflicts.push(file.path)
    } catch {
      conflicts.push(file.path)
    }
  }
  record.state = conflicts.length ? 'recovery-needed' : 'rolled-back'
  await journal(store, record)
  return { restored, conflicts }
}
/** Reversible retirement only. A higher-level updater must close writers and hold its
 * lifecycle gate. Unlisted, modified, missing and linked files are never moved/deleted. */
export async function retireProgramFiles(
  directory: string,
  manifestBytes: string | Buffer,
  expectedHash: string,
  destination: string,
  afterMove?: (path: string) => void | Promise<void>
): Promise<ProgramRetirementResult> {
  const root = await rootDirectory(directory),
    audit = await auditProgramFiles(root, manifestBytes, expectedHash)
  if (audit.identity !== 'matched') throw Error('程序目录与受信发行身份不匹配，不能移出文件。')
  if (!isAbsolute(destination)) throw Error('暂存目录必须为绝对路径。')
  const parent = await rootDirectory(dirname(destination)),
    store = join(parent, parse(destination).base)
  if (
    within(root, store) ||
    within(store, root) ||
    (await stat(root)).dev !== (await stat(parent)).dev
  )
    throw Error('可恢复暂存必须位于程序目录之外的同一卷。')
  await mkdir(store, { mode: 0o700 }) // Refuse an existing destination.
  await mkdir(join(store, 'files'))
  const record: Retirement = {
    version: 1,
    root,
    manifestHash: expectedHash,
    state: 'moving',
    files: [],
    audit
  }
  await journal(store, record)
  try {
    for (const file of [...audit.unchanged]) {
      // Markdown remains user-readable material even if originally bundled with the app.
      if (audit.protectedDocuments.includes(file.path)) continue
      if ((await member(root, file.path)) !== 'file') throw Error('程序路径在处理前发生改变。')
      const current = await fileDigest(join(root, file.path))
      if (current.sha256 !== file.sha256 || current.size !== file.size) {
        audit.changed.push(file.path)
        audit.unchanged = audit.unchanged.filter((other) => other.path !== file.path)
        continue
      }
      const entry: RetiredFile = {
        ...file,
        mode: current.mode,
        mtimeMs: current.mtimeMs,
        state: 'pending'
      }
      record.files.push(entry)
      await journal(store, record)
      const stored = join(store, 'files', file.path)
      await mkdir(dirname(stored), { recursive: true })
      await rename(join(root, file.path), stored)
      entry.state = 'moved'
      await journal(store, record)
      const moved = await fileDigest(stored)
      if (moved.sha256 !== file.sha256 || moved.size !== file.size) {
        // A last-moment writer changed the file: retain its latest bytes and restore them.
        entry.sha256 = moved.sha256
        entry.size = moved.size
        entry.mode = moved.mode
        entry.mtimeMs = moved.mtimeMs
        await journal(store, record)
        throw Error('文件在移入暂存时发生改变，开始恢复。')
      }
      await afterMove?.(file.path)
    }
    record.state = 'retired'
    await journal(store, record)
    return { ...audit, retired: record.files.filter((f) => f.state === 'moved').map((f) => f.path) }
  } catch (error) {
    let restored = await installationIdentity(root, expectedHash)
      .then((identity) => identity === 'matched')
      .catch(() => false)
    for (const file of restored ? [...record.files].reverse() : []) {
      if (file.state !== 'moved') continue
      try {
        if (await publishOriginal(root, join(store, 'files', file.path), file))
          file.state = 'restored'
        else restored = false
      } catch {
        restored = false
      }
    }
    record.state = restored ? 'rolled-back' : 'recovery-needed'
    await journal(store, record)
    throw error
  }
}
