import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { physicalFs as fs } from './physical-fs'
import { readProgramManifest, type ProgramManifest } from './program-files'
import { fileDigest } from './update-preservation'

const manifestName = 'program-files.v1.json'
const key = (path: string): string => path.toLowerCase()
export interface ReleaseStageOptions {
  signal?: AbortSignal
  /** Copied files/bytes only. Completion of this counter never authorizes publication. */
  progress?: (files: number, bytes: number) => void | Promise<void>
}
export interface StagedRelease {
  directory: string
  manifest: ProgramManifest
  manifestSha256: string
}
type Entry = { path: string; directory: boolean; info: BigIntStats }
type Tree = Map<string, Entry>
type DirectoryChain = Array<{ path: string; info: BigIntStats }>
interface Trusted {
  bytes: Buffer
  hash: string
  manifest: ProgramManifest
  files: Map<string, ProgramManifest['files'][number]>
  directories: Map<string, string>
}
function check(options: ReleaseStageOptions): void {
  options.signal?.throwIfAborted()
}
function inside(parent: string, child: string): boolean {
  const path = relative(key(parent), key(child))
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}
function concrete(path: string): string {
  if (!isAbsolute(path)) throw Error('发行暂存必须使用绝对目录。')
  const absolute = resolve(path)
  if (key(absolute) === key(parse(absolute).root))
    throw Error('不能把盘符或文件系统根目录作为发行目录。')
  return absolute
}
function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return (
    identity(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  )
}
function trust(bytes: string | Buffer, hash: string): Trusted {
  // Copy the caller's Buffer before the first await. Later mutation cannot replace signed input.
  const owned = Buffer.from(bytes)
  const manifest = readProgramManifest(owned, hash)
  const files = new Map(manifest.files.map((file) => [key(file.path), file]))
  const directories = new Map<string, string>()
  for (const file of manifest.files) {
    if (key(file.path) === manifestName || key(file.path).startsWith(manifestName + '/'))
      throw Error('发行清单自身的位置不能列为普通程序文件或目录。')
    let at = ''
    for (const part of file.path.split('/').slice(0, -1)) {
      const path = at ? at + '/' + part : part
      at = directories.get(key(path)) ?? path
      directories.set(key(at), at)
    }
  }
  return { bytes: owned, hash, manifest, files, directories }
}
/** Reject links in any supplied ancestor, rather than silently canonicalizing a junction. */
async function directoryChain(path: string): Promise<DirectoryChain> {
  if (!isAbsolute(path)) throw Error('发行目录祖先必须使用绝对路径。')
  const absolute = resolve(path),
    volume = parse(absolute).root
  const chain: DirectoryChain = []
  let at = volume
  for (const part of ['', ...relative(volume, absolute).split(sep).filter(Boolean)]) {
    if (part) at = join(at, part)
    const info = await fs.lstat(at, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('发行路径不能经过链接或非目录。')
    chain.push({ path: at, info })
  }
  return chain
}
async function assertChain(chain: DirectoryChain): Promise<void> {
  for (const item of chain) {
    const now = await fs.lstat(item.path, { bigint: true })
    if (now.isSymbolicLink() || !now.isDirectory() || !identity(item.info, now))
      throw Error('发行目录或祖先在操作期间被替换，停止暂存。')
  }
}
async function root(path: string): Promise<{ directory: string; chain: DirectoryChain }> {
  const absolute = concrete(path),
    chain = await directoryChain(absolute)
  const directory = await fs.realpath(absolute)
  concrete(directory)
  await assertChain(chain)
  return { directory, chain }
}
async function absent(path: string): Promise<void> {
  try {
    await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw Error('发行目标已经存在，必须使用全新版本目录；未覆盖已有内容。')
}
async function inventory(
  directory: string,
  trusted: Trusted,
  options: ReleaseStageOptions
): Promise<Tree> {
  const result: Tree = new Map()
  const visit = async (path: string): Promise<void> => {
    check(options)
    const absolute = path ? join(directory, path) : directory
    const info = await fs.lstat(absolute, { bigint: true })
    if (info.isSymbolicLink()) throw Error('发行目录包含路径链接，未接受暂存结果。')
    if (!info.isFile() && !info.isDirectory()) throw Error('发行目录包含特殊文件。')
    if (info.isFile() && info.nlink !== 1n)
      throw Error('发行文件包含硬链接，无法确认独立文件归属。')
    const folded = key(path)
    if (result.has(folded)) throw Error('发行目录包含大小写冲突的Windows路径。')
    if (
      path &&
      (info.isDirectory()
        ? !trusted.directories.has(folded)
        : folded !== manifestName && !trusted.files.has(folded))
    )
      throw Error('发行目录包含未声明的文件或目录：' + path)
    result.set(folded, { path, directory: info.isDirectory(), info })
    if (info.isDirectory()) {
      for (const entry of (await fs.readdir(absolute)).sort())
        await visit(path ? path + '/' + entry : entry)
    }
  }
  await visit('')
  for (const expected of trusted.files.keys())
    if (!result.has(expected) || result.get(expected)!.directory)
      throw Error('发行目录缺少清单文件：' + trusted.files.get(expected)!.path)
  return result
}
function sameTree(before: Tree, after: Tree): void {
  if (before.size !== after.size) throw Error('发行目录内容在操作期间发生变动。')
  for (const [path, previous] of before) {
    const current = after.get(path)
    if (
      !current ||
      current.path !== previous.path ||
      current.directory !== previous.directory ||
      !unchanged(previous.info, current.info)
    )
      throw Error('发行文件或目录在操作期间发生变动：' + (previous.path || '.'))
  }
}
async function parents(directory: string, path: string, known: Tree): Promise<void> {
  let at = ''
  for (const part of ['', ...path.split('/').slice(0, -1)]) {
    if (part) at = at ? at + '/' + part : part
    const expected = known.get(key(at))
    const info = await fs.lstat(at ? join(directory, at) : directory, { bigint: true })
    if (
      !expected?.directory ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !identity(expected.info, info)
    )
      throw Error('发行文件的目录被替换或链接，停止暂存。')
  }
}
async function fullVerification(
  directory: string,
  trusted: Trusted,
  options: ReleaseStageOptions,
  requireManifest: boolean
): Promise<Tree> {
  const before = await inventory(directory, trusted, options)
  const ownManifest = before.get(manifestName)
  if (requireManifest && !ownManifest) throw Error('暂存目录缺少受信发行清单，不能启动或发布。')
  const checks = [
    ...trusted.manifest.files.map((file) => ({ ...file, actual: before.get(key(file.path))! })),
    ...(ownManifest
      ? [
          {
            path: manifestName,
            size: trusted.bytes.length,
            sha256: trusted.hash,
            actual: ownManifest
          }
        ]
      : [])
  ]
  for (const expected of checks) {
    check(options)
    await parents(directory, expected.actual.path, before)
    const digest = await fileDigest(join(directory, expected.actual.path), undefined, options)
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256)
      throw Error('发行文件大小或哈希校验失败：' + expected.path)
    await parents(directory, expected.actual.path, before)
  }
  const after = await inventory(directory, trusted, options)
  sameTree(before, after)
  return after
}
/** Verify a complete immutable version before recovery/publication/launch. No directory is
 * created and no source is moved. The caller supplies the independently trusted digest. */
export async function verifyStagedRelease(
  directory: string,
  manifestBytes: string | Buffer,
  trustedManifestSha256: string
): Promise<StagedRelease> {
  const trusted = trust(manifestBytes, trustedManifestSha256),
    location = await root(directory)
  await fullVerification(location.directory, trusted, {}, true)
  await assertChain(location.chain)
  return { directory: location.directory, manifest: trusted.manifest, manifestSha256: trusted.hash }
}

/** Copy one complete release into an exclusively-created directory. A failure intentionally
 * leaves that unpublished directory in place; this module never removes trees or flips current. */
export async function stageRelease(
  sourceDir: string,
  destinationFreshDir: string,
  manifestBytes: string | Buffer,
  trustedManifestSha256: string,
  options: ReleaseStageOptions = {}
): Promise<StagedRelease> {
  const trusted = trust(manifestBytes, trustedManifestSha256)
  check(options)
  const source = await root(sourceDir)
  const requestedDestination = concrete(destinationFreshDir)
  const parentChain = await directoryChain(dirname(requestedDestination))
  const parent = await fs.realpath(dirname(requestedDestination))
  const destination = join(parent, basename(requestedDestination))
  if (
    inside(source.directory, destination) ||
    inside(destination, source.directory) ||
    parentChain.some((part) => identity(part.info, source.chain.at(-1)!.info))
  )
    throw Error('发行源与新版本目录必须彼此独立，不能相互包含。')
  await absent(destination)
  const sourceTree = await fullVerification(source.directory, trusted, options, false)
  await assertChain(source.chain)
  await assertChain(parentChain)
  check(options)
  // No recursive mkdir: the coordinator owns installation-root/versions creation, and an
  // intervening empty directory is a collision, never permission to merge a release into it.
  await fs.mkdir(destination, { mode: 0o700 })
  const destinationChain = await directoryChain(destination)
  const known: Tree = new Map([
    ['', { path: '', directory: true, info: await fs.lstat(destination, { bigint: true }) }]
  ])
  const copied: Tree = new Map()
  for (const path of [...trusted.directories.values()].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  )) {
    check(options)
    await assertChain(destinationChain)
    await parents(destination, path, known)
    await fs.mkdir(join(destination, path))
    known.set(key(path), {
      path,
      directory: true,
      info: await fs.lstat(join(destination, path), { bigint: true })
    })
  }
  let files = 0,
    bytes = 0
  for (const expected of trusted.manifest.files) {
    check(options)
    const original = sourceTree.get(key(expected.path))!
    const folder = expected.path.split('/').slice(0, -1).join('/')
    const path = folder
      ? trusted.directories.get(key(folder))! + '/' + expected.path.split('/').at(-1)!
      : expected.path
    await assertChain(source.chain)
    await assertChain(destinationChain)
    await parents(source.directory, original.path, sourceTree)
    await parents(destination, path, known)
    if (
      !unchanged(
        original.info,
        await fs.lstat(join(source.directory, original.path), { bigint: true })
      )
    )
      throw Error('发行源文件在复制前发生变动：' + expected.path)
    const digest = await fileDigest(
      join(source.directory, original.path),
      join(destination, path),
      options
    )
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256)
      throw Error('复制时的发行源不再匹配受信清单：' + expected.path)
    await parents(source.directory, original.path, sourceTree)
    await parents(destination, path, known)
    const target = join(destination, path)
    await fs.utimes(target, new Date(), new Date(digest.mtimeMs))
    await fs.chmod(target, digest.mode)
    copied.set(key(path), {
      path,
      directory: false,
      info: await fs.lstat(target, { bigint: true })
    })
    files++
    bytes += digest.size
    await options.progress?.(files, bytes)
  }
  check(options)
  const sourceAfterCopy = await fullVerification(source.directory, trusted, options, false)
  sameTree(sourceTree, sourceAfterCopy)
  await assertChain(source.chain)
  await assertChain(destinationChain)
  // Keep the exact trusted bytes, rather than re-serializing the manifest to a new identity.
  const manifestFile = await fs.open(join(destination, manifestName), 'wx', 0o600)
  try {
    await manifestFile.writeFile(trusted.bytes)
    await manifestFile.sync()
  } finally {
    await manifestFile.close()
  }
  const verified = await fullVerification(destination, trusted, options, true)
  for (const [path, previous] of copied) {
    const actual = verified.get(path)
    if (!actual || !unchanged(previous.info, actual.info))
      throw Error('暂存副本在复制后被改变，未发布该目录。')
  }
  sameTree(sourceTree, await inventory(source.directory, trusted, options))
  sameTree(verified, await inventory(destination, trusted, options))
  await assertChain(source.chain)
  await assertChain(destinationChain)
  check(options)
  return { directory: destination, manifest: trusted.manifest, manifestSha256: trusted.hash }
}
