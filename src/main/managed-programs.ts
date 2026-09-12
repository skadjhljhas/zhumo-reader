import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import type { CurrentVersionPointer } from './current-version'
import { moveFileExclusive } from './exclusive-move'
import {
  setupAbsolute,
  inspectSetupDirectory,
  createSetupDirectory,
  readSetupFile,
  setupContains
} from './setup-paths'
import {
  readProgramManifest,
  retireProgramFiles,
  restoreRetiredProgramFiles
} from './program-files'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const setupDigest = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')

/** Private metadata is published completely and read back; no data file is opened for truncation. */
export async function writeSetupState(path: string, value: unknown): Promise<void> {
  await inspectSetupDirectory(dirname(path))
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2))
  const temporary = join(dirname(path), '.pending-' + randomUUID() + '.json')
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!(await readSetupFile(temporary, 64 * 1024 * 1024)).equals(bytes))
    throw Error('安装状态保存不完整。')
  await fs.rename(temporary, path)
  if (!(await readSetupFile(path, 64 * 1024 * 1024)).equals(bytes))
    throw Error('安装状态读回不一致。')
}

export async function publishSetupState(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2))
  try {
    if (!(await readSetupFile(path, 64 * 1024 * 1024)).equals(bytes))
      throw Error('安装记录已存在且内容不同。')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await inspectSetupDirectory(dirname(path))
  const temporary = join(dirname(path), '.record-' + randomUUID() + '.tmp')
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!(await readSetupFile(temporary, 64 * 1024 * 1024)).equals(bytes))
    throw Error('安装记录暂存不完整。')
  await moveFileExclusive(temporary, path)
}

/** A record is introduced only by a guarded update that already knows this pointer's identity. */
export async function rememberManagedVersion(
  root: string,
  pointer: CurrentVersionPointer
): Promise<void> {
  if (!uuid.test(pointer.releaseId) || !uuid.test(pointer.transactionId))
    throw Error('版本归属编号无效。')
  const folder = join(setupAbsolute(root), '.zhumo', 'version-records')
  await createSetupDirectory(await inspectSetupDirectory(folder))
  const path = join(folder, pointer.releaseId + '.json')
  const bytes = Buffer.from(JSON.stringify(pointer) + '\n')
  try {
    const existing = await readSetupFile(path)
    if (!existing.equals(bytes)) throw Error('版本归属记录已存在且内容不同。')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(folder, '.version-' + randomUUID() + '.tmp')
  const output = await fs.open(temporary, 'wx', 0o600)
  try {
    await output.writeFile(bytes)
    await output.sync()
  } finally {
    await output.close()
  }
  if (!(await readSetupFile(temporary)).equals(bytes)) throw Error('版本归属记录暂存不完整。')
  await moveFileExclusive(temporary, path)
  if (!(await readSetupFile(path)).equals(bytes)) throw Error('版本归属记录保存不完整。')
}

export interface ManagedProgramRemoval {
  id: string
  directory: string
  manifestBytes: string
  manifestHash: string
  storage: string
}
export async function planManagedProgramRemoval(
  root: string,
  current: CurrentVersionPointer,
  storage: string
): Promise<ManagedProgramRemoval[]> {
  const records = new Map<string, CurrentVersionPointer>([[current.releaseId, current]])
  const folder = join(root, '.zhumo', 'version-records')
  if (!(await inspectSetupDirectory(folder)).missing.length) {
    for (const file of await fs.readdir(folder, { withFileTypes: true })) {
      if (!file.name.endsWith('.json') || !uuid.test(file.name.slice(0, -5))) continue
      if (!file.isFile() || file.isSymbolicLink()) throw Error('版本归属记录包含无效文件。')
      const pointer = JSON.parse(
        (await readSetupFile(join(folder, file.name))).toString('utf8')
      ) as CurrentVersionPointer
      if (
        pointer.version !== 1 ||
        pointer.releaseId !== file.name.slice(0, -5) ||
        !uuid.test(pointer.transactionId) ||
        pointer.appId !== current.appId ||
        !pointer.profile ||
        !current.profile ||
        !same(pointer.profile, current.profile) ||
        !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)
      )
        throw Error('版本归属记录与当前安装不一致。')
      records.set(pointer.releaseId, pointer)
    }
  }
  const plans: ManagedProgramRemoval[] = []
  for (const pointer of records.values()) {
    const directory = join(root, '.zhumo', 'versions', pointer.releaseId)
    if ((await inspectSetupDirectory(directory)).missing.length) continue
    const bytes = await readSetupFile(join(directory, 'program-files.v1.json'), 64 * 1024 * 1024)
    const manifest = readProgramManifest(bytes, pointer.manifestSha256)
    if (
      manifest.appId !== current.appId ||
      manifest.appVersion !== pointer.appVersion ||
      manifest.executable !== pointer.executable
    )
      throw Error('受管程序清单与归属记录不一致。')
    plans.push({
      id: pointer.releaseId,
      directory,
      manifestBytes: bytes.toString('utf8'),
      manifestHash: pointer.manifestSha256,
      storage: join(storage, pointer.releaseId)
    })
  }
  return plans
}

export async function chooseRetirementStorage(
  root: string,
  transaction: string,
  protectedPaths: readonly string[] = []
): Promise<string> {
  const sameVolume = (await fs.stat(root)).dev === (await fs.stat(transaction)).dev
  const parent = sameVolume ? transaction : join(dirname(root), '.zhumo-program-recovery')
  const storage = join(parent, 'programs-' + randomUUID())
  if (
    [root, ...protectedPaths].some(
      (path) => setupContains(path, storage) || setupContains(storage, path)
    )
  )
    throw Error('程序恢复位置必须位于程序和资料目录之外。')
  if (!sameVolume) await createSetupDirectory(await inspectSetupDirectory(parent))
  await fs.mkdir(storage)
  return storage
}
export async function retireManagedPrograms(
  plans: ManagedProgramRemoval[],
  check: () => Promise<void>
): Promise<number> {
  let count = 0
  for (const plan of plans) {
    await check()
    const result = await retireProgramFiles(
      plan.directory,
      plan.manifestBytes,
      plan.manifestHash,
      plan.storage,
      check
    )
    count += result.retired.length
  }
  return count
}
export async function restoreManagedPrograms(
  plans: ManagedProgramRemoval[],
  check: () => Promise<void>
): Promise<void> {
  for (const plan of [...plans].reverse()) {
    await check()
    try {
      await fs.lstat(join(plan.storage, 'retirement.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const restored = await restoreRetiredProgramFiles(
      plan.directory,
      plan.manifestBytes,
      plan.manifestHash,
      plan.storage
    )
    if (restored.conflicts.length)
      throw Error('部分程序位置已有新内容，未覆盖；程序恢复副本已保留。')
  }
}

export async function readRetainedProfile(
  root: string,
  appId: string
): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readSetupFile(join(root, '.zhumo', 'retained-profile.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record = JSON.parse(bytes.toString('utf8'))
  if (
    record.version !== 1 ||
    record.appId !== appId ||
    !same(record.root, root) ||
    !uuid.test(record.id) ||
    typeof record.profile !== 'string'
  )
    throw Error('保留设置的安装记录无效。')
  return setupAbsolute(record.profile)
}
export function validateRemovalPlan(
  plan: ManagedProgramRemoval,
  root: string,
  storage: string,
  appId: string
): void {
  if (
    !uuid.test(plan.id) ||
    !same(plan.directory, join(root, '.zhumo', 'versions', plan.id)) ||
    !same(plan.storage, join(storage, plan.id)) ||
    basename(plan.storage) !== plan.id ||
    readProgramManifest(plan.manifestBytes, plan.manifestHash).appId !== appId
  )
    throw Error('程序清理恢复记录越出本次安装范围。')
}
