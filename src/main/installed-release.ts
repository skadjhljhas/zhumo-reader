import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { readProgramManifest, type ProgramManifest } from './program-files'
import { fileDigest } from './update-preservation'

const manifestName = 'program-files.v1.json'
const key = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.ino === b.ino && a.dev === b.dev
const unchangedFile = (a: BigIntStats, b: BigIntStats): boolean =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  a.nlink === b.nlink

export interface InstalledRelease {
  directory: string
  manifest: ProgramManifest
  manifestSha256: string
}
interface DirectoryIdentity {
  path: string
  info: BigIntStats
}
interface KnownFile {
  path: string
  size: number
  sha256: string
  parents: DirectoryIdentity[]
  info: BigIntStats
}

function absoluteDirectory(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
    throw Error('已安装版本必须使用有效的绝对目录。')
  const directory = resolve(value)
  if (key(directory) === key(parse(directory).root)) throw Error('不能把盘根作为已安装版本目录。')
  return directory
}
async function regularFile(path: string): Promise<BigIntStats> {
  const info = await fs.lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
    throw Error('已知程序文件不是独立普通文件，可能含链接或类型已改变。')
  return info
}
async function assertDirectories(items: DirectoryIdentity[]): Promise<void> {
  for (const item of items) {
    const now = await fs.lstat(item.path, { bigint: true })
    if (now.isSymbolicLink() || !now.isDirectory() || !sameIdentity(item.info, now))
      throw Error('已安装程序的目录或祖先已被替换，不能继续启动。')
  }
}

/** Installed releases may coexist with personal books and assets. Only manifest-listed
 * program paths are inspected: no inventory, read, ownership claim or deletion of extras. */
export async function verifyInstalledRelease(
  directory: string,
  manifestBytes: string | Buffer,
  trustedManifestSha256: string
): Promise<InstalledRelease> {
  // Own the trusted bytes before any asynchronous filesystem operation.
  const bytes = Buffer.from(manifestBytes)
  const manifest = readProgramManifest(bytes, trustedManifestSha256)
  for (const file of manifest.files)
    if (
      file.path.toLowerCase() === manifestName ||
      file.path.toLowerCase().startsWith(manifestName + '/')
    )
      throw Error('发行清单自身的位置不能登记为普通程序路径。')
  const location = absoluteDirectory(directory)
  const directories = new Map<string, DirectoryIdentity>()
  const remember = async (path: string): Promise<DirectoryIdentity> => {
    const existing = directories.get(key(path))
    if (existing) return existing
    const info = await fs.lstat(path, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory() || key(await fs.realpath(path)) !== key(path))
      throw Error('已安装程序路径经过链接、别名或非目录，不能继续启动。')
    const item = { path, info }
    directories.set(key(path), item)
    return item
  }
  const ancestors: DirectoryIdentity[] = []
  const volume = parse(location).root
  let at = volume
  for (const part of ['', ...relative(volume, location).split(sep).filter(Boolean)]) {
    if (part) at = join(at, part)
    ancestors.push(await remember(at))
  }
  const checks: KnownFile[] = []
  for (const expected of [
    ...manifest.files,
    { path: manifestName, size: bytes.length, sha256: trustedManifestSha256 }
  ]) {
    const parents = [...ancestors]
    let folder = location
    for (const part of expected.path.split('/').slice(0, -1)) {
      folder = join(folder, part)
      parents.push(await remember(folder))
    }
    await assertDirectories(parents)
    const path = join(location, expected.path)
    checks.push({ ...expected, path, parents, info: await regularFile(path) })
  }
  for (const expected of checks) {
    await assertDirectories(expected.parents)
    if (!unchangedFile(expected.info, await regularFile(expected.path)))
      throw Error('已知程序文件在验证前发生改变，不能继续启动。')
    const digest = await fileDigest(expected.path)
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256)
      throw Error('已知程序文件的大小或哈希与发行清单不符，不能继续启动。')
    await assertDirectories(expected.parents)
    if (!unchangedFile(expected.info, await regularFile(expected.path)))
      throw Error('已知程序文件在验证期间发生改变，不能继续启动。')
  }
  // Directory mtime/ctime is deliberately irrelevant: saving an unlisted book must not
  // invalidate intact program bytes. Directory identity and known-file identity still matter.
  await assertDirectories([...directories.values()])
  for (const expected of checks)
    if (!unchangedFile(expected.info, await regularFile(expected.path)))
      throw Error('已知程序文件在完成校验前再次改变，不能继续启动。')
  return { directory: location, manifest, manifestSha256: trustedManifestSha256 }
}
