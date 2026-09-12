import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { readProgramManifest } from './program-files'
import { publishSetupState } from './managed-programs'
import { readSetupFile, setupAbsolute } from './setup-paths'
import { fileDigest } from './update-preservation'
import type { SetupRequest } from './setup-action'
import type { OwnedFileIdentity } from './conditional-delete'
export interface CleanupOwnedFile extends OwnedFileIdentity {
  path: string
  sha256: string
}
export interface RuntimeOwnership {
  version: 1
  appId: string
  root: string
  source: string
  runtimeId: string
  sourceIdentity: OwnedFileIdentity
  manifestHash: string
  files: CleanupOwnedFile[]
}
export interface RuntimeOwnershipReference {
  path: string
  sha256: string
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function validateOwnedRuntime(request: SetupRequest): void {
  if (!request.runtimeId) return
  if (
    !/^\{[a-f0-9-]{36}\}$/i.test(request.runtimeId) ||
    basename(dirname(setupAbsolute(request.source))).toLowerCase() !==
      request.runtimeId.toLowerCase() ||
    basename(request.source).toLowerCase() !== 'payload' ||
    !request.uninstaller ||
    setupAbsolute(request.uninstaller).toLowerCase() !==
      join(dirname(setupAbsolute(request.source)), 'remove.exe').toLowerCase()
  )
    throw Error('安装运行目录的归属声明无效。')
}
/** NSIS supplies this only for its freshly and exclusively created runtime directory.
 * A user-selected generic update source without that declaration is never reclaimed. */
export async function recordOwnedRuntime(
  request: SetupRequest,
  manifestBytes: Buffer
): Promise<RuntimeOwnershipReference | undefined> {
  validateOwnedRuntime(request)
  if (!request.runtimeId) return undefined
  const source = setupAbsolute(request.source),
    manifest = readProgramManifest(manifestBytes, request.manifestHash)
  const sourceInfo = await fs.lstat(source, { bigint: true })
  const files: CleanupOwnedFile[] = []
  for (const item of [
    ...manifest.files.map((f) => ({ path: join(source, f.path), sha256: f.sha256 })),
    { path: request.uninstaller!, sha256: (await fileDigest(request.uninstaller!)).sha256 }
  ]) {
    const before = await fs.lstat(item.path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw Error('程序运行副本不是独立文件。')
    if ((await fileDigest(item.path)).sha256 !== item.sha256)
      throw Error('程序运行副本在登记归属时改变。')
    const after = await fs.lstat(item.path, { bigint: true })
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    )
      throw Error('程序运行副本身份发生变化。')
    files.push({ ...item, dev: before.dev.toString(), ino: before.ino.toString() })
  }
  const data: RuntimeOwnership = {
    version: 1,
    appId: request.appId,
    root: setupAbsolute(request.installRoot),
    source,
    runtimeId: request.runtimeId,
    sourceIdentity: { dev: sourceInfo.dev.toString(), ino: sourceInfo.ino.toString() },
    manifestHash: request.manifestHash,
    files
  }
  const path = join(dirname(source), 'runtime-owned.v1.json'),
    bytes = Buffer.from(JSON.stringify(data, null, 2))
  await publishSetupState(path, bytes)
  return { path, sha256: hash(bytes) }
}
export async function readOwnedRuntime(
  reference: RuntimeOwnershipReference,
  root: string,
  appId: string
): Promise<RuntimeOwnership> {
  const bytes = await readSetupFile(reference.path, 32 * 1024 * 1024)
  if (hash(bytes) !== reference.sha256) throw Error('程序运行副本归属记录不符合原校验值。')
  const value = JSON.parse(bytes.toString()) as RuntimeOwnership
  if (
    value.version !== 1 ||
    value.appId !== appId ||
    value.root.toLowerCase() !== root.toLowerCase() ||
    !Array.isArray(value.files) ||
    reference.path.toLowerCase() !==
      join(dirname(value.source), 'runtime-owned.v1.json').toLowerCase()
  )
    throw Error('程序运行副本归属记录不属于该安装。')
  validateOwnedRuntime({
    runtimeId: value.runtimeId,
    source: value.source,
    uninstaller: join(dirname(value.source), 'remove.exe')
  } as SetupRequest)
  return value
}
