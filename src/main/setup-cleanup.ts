import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import type { SetupRequest } from './setup-action'
import { readCurrentVersion } from './current-version'
import { admitUpdate } from './update-admission'
import { assertProgramsClosed } from './update-process-guard'
import {
  readCompletedRemoval,
  readSettledRemoval,
  type RemovalExpected,
  type RemovalJournal
} from './setup-removal'
import { readOwnedRuntime, type CleanupOwnedFile } from './setup-runtime-ownership'
import { readProgramManifest } from './program-files'
import { publishSetupState, writeSetupState } from './managed-programs'
import { setupAbsolute, setupContains, inspectSetupDirectory, readSetupFile } from './setup-paths'
import {
  deleteOwnedFile,
  assertOwnedDeletionSupported,
  inspectDeletionDirectory
} from './conditional-delete'
import { fileDigest } from './update-preservation'
import { readRegistration, sameRegistration } from './setup-registry'
import { verifyStagedRelease } from './release-stage'

export interface CleanupResult {
  deleted: number
  missing: number
  retained: { path: string; reason: string }[]
}
export interface CleanupPlan {
  version: 1
  id: string
  removal: string
  removals: string[]
  expected: RemovalExpected
  roots: string[]
  files: CleanupOwnedFile[]
  retained: { path: string; reason: string }[]
}
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
async function protectedDirectories(expected: RemovalExpected): Promise<string[]> {
  const roots = [expected.root, expected.profile]
  let bytes: Buffer
  try {
    bytes = await readSetupFile(join(expected.profile, 'manuscript-library.v1.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return roots
    throw error
  }
  const binding = JSON.parse(bytes.toString())
  if (binding.version !== 1 || typeof binding.path !== 'string')
    throw Error('文稿目录绑定无法核对。')
  roots.push(await fs.realpath(setupAbsolute(binding.path)))
  return roots
}
async function cleanupRecords(
  record: RemovalJournal,
  removal: string,
  expected: RemovalExpected
): Promise<string[]> {
  const records = [removal]
  for (const file of await fs.readdir(record.work, { withFileTypes: true })) {
    if (
      !file.isDirectory() ||
      file.isSymbolicLink() ||
      !/^withdraw-[a-f0-9-]{36}$/i.test(file.name)
    )
      continue
    const path = join(record.work, file.name)
    if (same(path, removal)) continue
    let other
    try {
      other = JSON.parse(
        (await readSetupFile(join(path, 'withdrawal.json'), 64 * 1024 * 1024)).toString()
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (
      other.root !== expected.root ||
      other.profile !== expected.profile ||
      other.coordinator !== expected.coordinator ||
      other.appId !== expected.appId ||
      !['committed', 'rolled-back'].includes(other.phase)
    )
      continue
    await readSettledRemoval(path, expected)
    records.push(path)
  }
  return records
}
async function cleanupPrograms(
  paths: string[],
  record: RemovalJournal,
  expected: RemovalExpected
): Promise<RemovalJournal['programs']> {
  const programs = new Map<string, RemovalJournal['programs'][number]>()
  for (const path of paths) {
    if (!same(dirname(path), record.work) || !/^withdraw-[a-f0-9-]{36}$/i.test(basename(path)))
      throw Error('清理计划引用了未知移出事务。')
    for (const program of (await readSettledRemoval(path, expected)).programs)
      programs.set(program.storage.toLowerCase(), program)
  }
  return [...programs.values()]
}
interface CleanupCandidate {
  path: string
  sha256: string
  dev?: string
  ino?: string
  directories: { path: string; dev: string; ino: string }[]
}
interface CleanupInventory {
  roots: string[]
  files: Map<string, CleanupCandidate>
}
async function cleanupInventory(
  removals: string[],
  record: RemovalJournal,
  expected: RemovalExpected
): Promise<CleanupInventory> {
  const files = new Map<string, CleanupCandidate>(),
    roots = new Map<string, string>()
  const add = async (
    candidate: Omit<CleanupCandidate, 'directories'>,
    anchor?: CleanupCandidate['directories'][number]
  ): Promise<void> => {
    const parent = dirname(candidate.path)
    const exists = await inspectDeletionDirectory(parent)
    const directories = anchor ? [anchor] : []
    if (exists) {
      const identity = await fs.lstat(parent, { bigint: true })
      directories.push({ path: parent, dev: identity.dev.toString(), ino: identity.ino.toString() })
    }
    files.set(candidate.path.toLowerCase(), { ...candidate, directories })
  }
  for (const program of await cleanupPrograms(removals, record, expected)) {
    const manifest = readProgramManifest(program.manifestBytes, program.manifestHash)
    const retirement = JSON.parse(
      (await readSetupFile(join(program.storage, 'retirement.json'), 64 * 1024 * 1024)).toString()
    )
    if (
      !['retired', 'rolled-back'].includes(retirement.state) ||
      retirement.manifestHash !== program.manifestHash ||
      !same(retirement.root, program.directory)
    )
      throw Error('原程序移出记录无法核对。')
    const folder = join(program.storage, 'files')
    await inspectSetupDirectory(folder)
    roots.set(folder.toLowerCase(), folder)
    for (const item of retirement.files as { path: string; state: string; sha256: string }[]) {
      if (!['moved', 'restored'].includes(item.state)) continue
      const known = manifest.files.find(
        (file) => file.path === item.path && file.sha256 === item.sha256
      )
      if (!known || /\.(md|markdown|epub)$/i.test(known.path)) continue
      await add({ path: join(folder, known.path), sha256: known.sha256 })
    }
    let update
    try {
      update = JSON.parse(
        (
          await readSetupFile(
            join(record.work, 'update-' + program.id, 'journal.json'),
            1024 * 1024
          )
        ).toString()
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!update.setup?.runtimeOwner) continue
    if (
      update.version !== 2 ||
      update.id !== program.id ||
      update.next?.manifestSha256 !== program.manifestHash ||
      !same(update.installRoot, expected.root) ||
      !same(update.profile, expected.profile) ||
      update.next?.appId !== expected.appId
    )
      throw Error('运行副本的安装事务不一致。')
    const owned = await readOwnedRuntime(update.setup.runtimeOwner, expected.root, expected.appId)
    if (
      !same(owned.source, setupAbsolute(update.source)) ||
      !same(owned.source, setupAbsolute(update.setup.request?.source)) ||
      owned.runtimeId !== update.setup.request?.runtimeId ||
      owned.manifestHash !== update.next.manifestSha256 ||
      owned.manifestHash !== update.setup.request?.manifestHash ||
      update.setup.request?.appId !== expected.appId
    )
      throw Error('运行副本与其原安装请求不一致。')
    if ((await inspectSetupDirectory(owned.source)).missing.length)
      throw Error('原运行副本目录不可用。')
    const identity = await fs.lstat(owned.source, { bigint: true })
    if (
      identity.dev.toString() !== owned.sourceIdentity.dev ||
      identity.ino.toString() !== owned.sourceIdentity.ino
    )
      throw Error('程序运行副本目录已被替代，未清理它。')
    const original = readProgramManifest(
      await readSetupFile(join(owned.source, 'program-files.v1.json'), 64 * 1024 * 1024),
      owned.manifestHash
    )
    if (original.appId !== expected.appId) throw Error('程序运行副本属于另一产品。')
    roots.set(owned.source.toLowerCase(), owned.source)
    for (const file of owned.files) {
      const member = original.files.find(
        (entry) => same(join(owned.source, entry.path), file.path) && entry.sha256 === file.sha256
      )
      if (
        (!member && !same(file.path, join(dirname(owned.source), 'remove.exe'))) ||
        /\.(md|markdown|epub)$/i.test(file.path)
      )
        throw Error('运行副本清理项不属于原始清单。')
      await add(file, member ? { path: owned.source, ...owned.sourceIdentity } : undefined)
    }
  }
  return { roots: [...roots.values()], files }
}
async function validateCleanupFiles(
  plan: CleanupPlan,
  record: RemovalJournal
): Promise<CleanupInventory> {
  const inventory = await cleanupInventory(plan.removals, record, plan.expected)
  if (plan.roots.some((root) => !inventory.roots.some((allowed) => same(root, allowed))))
    throw Error('清理计划添加了原记录之外的目录。')
  for (const file of plan.files) {
    const known = inventory.files.get(file.path.toLowerCase())
    if (
      !known ||
      known.sha256 !== file.sha256 ||
      (known.dev !== undefined && (known.dev !== file.dev || known.ino !== file.ino))
    )
      throw Error('清理计划包含原记录之外的文件。')
  }
  return inventory
}
export async function verifyCleanupExecution(
  executionSource: string,
  request: SetupRequest
): Promise<void> {
  const source = setupAbsolute(executionSource)
  if (
    same(source, request.source) ||
    setupContains(request.installRoot, source) ||
    setupContains(request.defaultProfile, source) ||
    setupContains(request.workRoot, source)
  )
    throw Error('最终清理需要位于原程序和资料之外的独立运行环境。')
  const release = await verifyStagedRelease(
    source,
    await readSetupFile(join(source, 'program-files.v1.json'), 64 * 1024 * 1024),
    request.manifestHash
  )
  if (release.manifest.appId !== request.appId) throw Error('最终清理运行环境与安装包身份不一致。')
}
async function ownFile(path: string, hash: string): Promise<CleanupOwnedFile | undefined> {
  if (!(await inspectDeletionDirectory(dirname(path)))) return undefined
  const before = await fs.lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    return undefined
  if ((await fileDigest(path)).sha256 !== hash) return undefined
  const after = await fs.lstat(path, { bigint: true })
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  )
    return undefined
  return { path, sha256: hash, dev: before.dev.toString(), ino: before.ino.toString() }
}
export async function prepareCleanup(
  removal: string,
  expected: RemovalExpected,
  executionSource: string
): Promise<CleanupPlan> {
  const record = await readCompletedRemoval(removal, expected)
  const files: CleanupOwnedFile[] = [],
    retained: CleanupResult['retained'] = []
  const removals = await cleanupRecords(record, removal, expected)
  const inventory = await cleanupInventory(removals, record, expected)
  const roots = inventory.roots
  for (const candidate of inventory.files.values()) {
    const current = await ownFile(candidate.path, candidate.sha256)
    if (
      current &&
      (candidate.dev === undefined ||
        (current.dev === candidate.dev && current.ino === candidate.ino))
    )
      files.push(current)
    else retained.push({ path: candidate.path, reason: 'missing, changed or linked' })
  }
  const protectedRoots = await protectedDirectories(expected)
  for (const path of roots) {
    if (
      setupContains(expected.root, path) ||
      setupContains(expected.profile, path) ||
      setupContains(path, executionSource) ||
      setupContains(executionSource, path)
    )
      throw Error('清理范围与原资料或当前运行环境重叠。')
    await inspectSetupDirectory(path)
    if (protectedRoots.some((root) => setupContains(root, path) || setupContains(path, root))) {
      for (const file of files.filter((file) => setupContains(path, file.path)))
        retained.push({ path: file.path, reason: 'manuscript library preserved' })
      continue
    }
    try {
      await assertOwnedDeletionSupported(path)
    } catch {
      for (const file of files.filter((file) => setupContains(path, file.path)))
        retained.push({ path: file.path, reason: 'unsupported cleanup volume' })
    }
  }
  const excluded = new Set(retained.map((f) => f.path.toLowerCase()))
  return {
    version: 1,
    id: randomUUID(),
    removal,
    removals,
    expected,
    roots: [...new Set(roots)],
    files: [
      ...new Map(
        files
          .filter((f) => !excluded.has(f.path.toLowerCase()))
          .map((f) => [f.path.toLowerCase(), f])
      ).values()
    ],
    retained
  }
}

/** Forward-only housekeeping of already removed program copies. Keep document/profile
 * snapshots intact. A live admission covers every source, including public bootstraps. */
export async function cleanupCompletedRemoval(
  removal: string,
  expected: RemovalExpected,
  executionSource: string,
  afterFile?: (path: string) => void | Promise<void>
): Promise<CleanupResult> {
  const planFile = join(removal, 'cleanup-plan.json')
  let plan: CleanupPlan
  try {
    plan = JSON.parse((await readSetupFile(planFile, 64 * 1024 * 1024)).toString())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    plan = await prepareCleanup(removal, expected, executionSource)
    await publishSetupState(planFile, plan)
  }
  if (
    plan.version !== 1 ||
    plan.removal !== removal ||
    !(['root', 'profile', 'coordinator', 'appId', 'registryKey'] as const).every(
      (key) => plan.expected[key] === expected[key]
    )
  )
    throw Error('清理计划不属于本次卸载。')
  const record = await readCompletedRemoval(removal, expected)
  const protectedRoots = await protectedDirectories(expected)
  const inventory = await validateCleanupFiles(plan, record)
  if (
    plan.roots.some(
      (root) => setupContains(root, executionSource) || setupContains(executionSource, root)
    )
  )
    throw Error('已保存清理计划越出原范围。')
  const admission = admitUpdate([...protectedRoots, ...plan.roots], expected.coordinator)
  const result: CleanupResult = { deleted: 0, missing: 0, retained: [...plan.retained] }
  try {
    const acquiredProtection = await protectedDirectories(expected)
    if (
      JSON.stringify(acquiredProtection.map((path) => path.toLowerCase()).sort()) !==
      JSON.stringify(protectedRoots.map((path) => path.toLowerCase()).sort())
    )
      throw Error('取得清理准入前文稿库绑定发生改变，未删除任何文件，请重新准备。')
    await assertProgramsClosed(plan.roots)
    if (await readCurrentVersion(expected.root)) throw Error('已经出现新的安装，未继续旧清理计划。')
    if (!sameRegistration(await readRegistration(expected.registryKey), record.registration.after))
      throw Error('系统登记已经改变，未继续旧清理计划。')
    for (const file of plan.files) {
      const permitted = plan.roots.some(
        (root) =>
          setupContains(root, file.path) || same(join(dirname(root), 'remove.exe'), file.path)
      )
      if (!permitted || /\.(md|markdown|epub)$/i.test(file.path))
        throw Error('清理文件越出受管程序范围。')
      if (protectedRoots.some((root) => setupContains(root, file.path))) {
        result.retained.push({ path: file.path, reason: 'current manuscript library preserved' })
        continue
      }
      try {
        // deleteOwnedFile holds the complete native ancestor chain through final deletion.
        const status = await deleteOwnedFile(
          file.path,
          { dev: file.dev, ino: file.ino },
          file.sha256,
          inventory.files.get(file.path.toLowerCase())!.directories
        )
        if (status === 'deleted') result.deleted++
        else if (status === 'missing') result.missing++
        else result.retained.push({ path: file.path, reason: 'changed identity or content' })
      } catch (error) {
        result.retained.push({
          path: file.path,
          reason: error instanceof Error ? error.message : 'unavailable'
        })
      }
      await afterFile?.(file.path)
    }
    await writeSetupState(join(removal, 'cleanup-result.json'), result)
    return result
  } finally {
    admission.cancel()
  }
}

export async function recordRemovalReceipt(
  request: SetupRequest,
  result: { transaction: string; removedFiles: number }
): Promise<void> {
  await publishSetupState(join(dirname(setupAbsolute(request.source)), 'removed.v1.json'), {
    version: 1,
    request,
    ...result
  })
}
export async function findRemovalReceipt(
  request: SetupRequest
): Promise<{ transaction: string; removedFiles: number } | undefined> {
  let bytes: Buffer
  try {
    bytes = await readSetupFile(join(dirname(setupAbsolute(request.source)), 'removed.v1.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record = JSON.parse(bytes.toString())
  if (record.version !== 1 || JSON.stringify(record.request) !== JSON.stringify(request))
    throw Error('原卸载完成记录与本入口不一致。')
  return { transaction: record.transaction, removedFiles: record.removedFiles }
}
