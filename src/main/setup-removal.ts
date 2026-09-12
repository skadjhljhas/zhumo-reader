import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import {
  readCurrentVersion,
  restoreCurrentVersion,
  type CurrentVersionPointer
} from './current-version'
import { admitUpdate, inspectUpdateAdmission } from './update-admission'
import { assertProgramsClosed } from './update-process-guard'
import { startProfileGuard } from './profile-guard-client'
import { reconnectProfileGuard } from './retained-profile-guard'
import type { VersionUpdateRuntime } from './version-update'
import { verifyInstalledRelease } from './installed-release'
import { setupAbsolute, setupContains, inspectSetupDirectory, readSetupFile } from './setup-paths'
import {
  changeRegistration,
  readRegistration,
  recoverRegistration,
  sameRegistration,
  registrationValue,
  validateRegistrationKey,
  type RegistrationChange
} from './setup-registry'
import {
  previousRecord,
  withdrawShortcuts,
  restoreWithdrawnShortcuts,
  type ShortcutRecord,
  type WithdrawnShortcut
} from './setup-shortcuts'
import { readProgramManifest } from './program-files'
import {
  chooseRetirementStorage,
  planManagedProgramRemoval,
  retireManagedPrograms,
  restoreManagedPrograms,
  validateRemovalPlan,
  writeSetupState,
  type ManagedProgramRemoval
} from './managed-programs'

export interface SetupRemovalPlan {
  root: string
  profile: string
  coordinator: string
  work: string
  source: string
  sourceManifestHash: string
  executable: string
  appId: string
  appName: string
  pointer: string
  registration: RegistrationChange
  shortcuts: ShortcutRecord
}
export type SetupRemovalPhase =
  | 'preparing'
  | 'retiring'
  | 'retired'
  | 'pointer-cleared'
  | 'withdrawn'
  | 'committed'
  | 'rolled-back'
  | 'recovery-needed'
export interface RemovalJournal extends SetupRemovalPlan {
  version: 2 | 3
  id: string
  phase: SetupRemovalPhase
  admissionToken: string
  guardToken?: string
  guardDirectory?: string
  storage: string
  programs: ManagedProgramRemoval[]
  retainedBefore: string | null
  retainedAfter: string
  removedFiles: number
  decision?: 'commit'
}
export interface RemovalOptions {
  signal?: AbortSignal
  progress?: (phase: SetupRemovalPhase, transaction: string) => void | Promise<void>
  committed?: (transaction: string, removedFiles: number) => void | Promise<void>
}
const defaults: VersionUpdateRuntime = {
  assertClosed: assertProgramsClosed,
  startGuard: startProfileGuard,
  reconnectGuard: reconnectProfileGuard
}
type Lease = Awaited<ReturnType<VersionUpdateRuntime['startGuard']>>
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const statePath = (transaction: string): string => join(transaction, 'withdrawal.json')
const retainedPath = (root: string): string => join(root, '.zhumo', 'retained-profile.json')
async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readSetupFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function removedShortcuts(
  transaction: string,
  record: ShortcutRecord
): Promise<WithdrawnShortcut[]> {
  const entries: WithdrawnShortcut[] = []
  for (const file of await fs.readdir(transaction, { withFileTypes: true })) {
    const match = /^removed-shortcut-([a-f0-9-]{36})\.json$/i.exec(file.name)
    if (!match) continue
    if (!file.isFile() || file.isSymbolicLink()) throw Error('快捷方式恢复记录类型无效。')
    const entry = JSON.parse(
      (await readSetupFile(join(transaction, file.name))).toString('utf8')
    ) as WithdrawnShortcut
    const prior = record.entries.find((item) => same(item.path, entry.path))
    if (
      !prior ||
      prior.sha256 !== entry.sha256 ||
      !same(entry.backup, join(transaction, 'removed-shortcut-' + match[1] + '.lnk')) ||
      !same(entry.temporary, join(dirname(entry.path), '.zhumo-shortcut-' + match[1] + '.tmp'))
    )
      throw Error('快捷方式恢复记录越出本次安装范围。')
    entries.push(entry)
  }
  return entries
}
async function restoreRetained(journal: RemovalJournal): Promise<void> {
  const current = await optionalFile(retainedPath(journal.root))
  const before =
    journal.retainedBefore === null ? null : Buffer.from(journal.retainedBefore, 'base64')
  if (current?.equals(before ?? Buffer.alloc(0)) || (!current && !before)) return
  if (!current?.equals(Buffer.from(journal.retainedAfter)))
    throw Error('保留设置的记录已改变，未覆盖恢复。')
  if (before) await writeSetupState(retainedPath(journal.root), before)
  else await fs.unlink(retainedPath(journal.root))
}
async function rollbackRemoval(
  journal: RemovalJournal,
  transaction: string,
  check: () => Promise<void>
): Promise<void> {
  await restoreManagedPrograms(journal.programs, check)
  await check()
  const current = await readCurrentVersion(journal.root)
  if ((current?.bytes ?? null) !== journal.pointer) {
    if (current) throw Error('卸载之后已出现另一个当前版本，未覆盖恢复。')
    await restoreCurrentVersion(journal.root, journal.pointer, null)
  }
  await restoreRetained(journal)
  await restoreWithdrawnShortcuts(await removedShortcuts(transaction, journal.shortcuts))
  await recoverRegistration(journal.registration, transaction, 'before')
  if ((await readCurrentVersion(journal.root))?.bytes !== journal.pointer)
    throw Error('程序入口未恢复完整。')
  await check()
}
async function verifyRemoval(journal: RemovalJournal, transaction: string): Promise<void> {
  if (await readCurrentVersion(journal.root)) throw Error('卸载后的程序入口仍存在。')
  if (
    !sameRegistration(await readRegistration(journal.registration.key), journal.registration.after)
  )
    throw Error('卸载后的系统登记不一致。')
  if (!(await readSetupFile(retainedPath(journal.root))).equals(Buffer.from(journal.retainedAfter)))
    throw Error('原设置位置未完整保留。')
  for (const plan of journal.programs) {
    const retirement = JSON.parse(
      (await readSetupFile(join(plan.storage, 'retirement.json'), 64 * 1024 * 1024)).toString(
        'utf8'
      )
    ) as { state: string; files: { path: string; state: string }[] }
    if (retirement.state !== 'retired') throw Error('程序文件尚未全部完成移除。')
    for (const entry of retirement.files.filter((entry) => entry.state === 'moved')) {
      // Membership is checked against the already authenticated program manifest.
      const allowed = readProgramManifest(plan.manifestBytes, plan.manifestHash).files.find(
        (file) => file.path === entry.path
      )
      if (!allowed) throw Error('程序移除记录出现清单外的路径。')
      try {
        await fs.lstat(join(plan.directory, entry.path))
        throw Error('程序位置出现了新文件，保留现场。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  for (const entry of await removedShortcuts(transaction, journal.shortcuts)) {
    try {
      await fs.lstat(entry.path)
      throw Error('快捷方式位置出现了新文件，保留现场。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function removeSetupPrograms(
  plan: SetupRemovalPlan,
  options: RemovalOptions = {},
  runtime: VersionUpdateRuntime = defaults
): Promise<{ transaction: string; removedFiles: number }> {
  options.signal?.throwIfAborted()
  await runtime.assertClosed([plan.root])
  const id = randomUUID(),
    transaction = join(plan.work, 'withdraw-' + id)
  await fs.mkdir(transaction)
  const storage = await chooseRetirementStorage(plan.root, transaction, [plan.profile, plan.source])
  const pointer = JSON.parse(plan.pointer) as CurrentVersionPointer
  const journal: RemovalJournal = {
    ...plan,
    version: 3,
    id,
    phase: 'preparing',
    admissionToken: '',
    storage,
    programs: await planManagedProgramRemoval(plan.root, pointer, storage),
    retainedBefore: (await optionalFile(retainedPath(plan.root)))?.toString('base64') ?? null,
    retainedAfter: JSON.stringify(
      { version: 1, id, root: plan.root, profile: plan.profile, appId: plan.appId },
      null,
      2
    ),
    removedFiles: 0
  }
  const admission = admitUpdate([plan.root, plan.profile], plan.coordinator)
  journal.admissionToken = admission.token
  let guard: Lease | undefined,
    mutating = false,
    settled = false
  const checkpoint = async (phase: SetupRemovalPhase): Promise<void> => {
    const state = {
      ...journal,
      phase,
      ...(phase === 'committed' ? { decision: 'commit' as const } : {})
    }
    await writeSetupState(statePath(transaction), state)
    Object.assign(journal, state)
    await options.progress?.(phase, transaction)
  }
  const check = async (): Promise<void> => {
    options.signal?.throwIfAborted()
    guard?.signal.throwIfAborted()
    await guard?.assertHeld()
  }
  try {
    await checkpoint('preparing')
    guard = await runtime.startGuard({
      executable: join(plan.source, plan.executable),
      profile: plan.profile,
      programRoots: [plan.root],
      coordinator: plan.coordinator,
      workParent: transaction,
      appName: plan.appName,
      admission,
      signal: options.signal
    })
    journal.guardDirectory = guard.directory
    journal.guardToken = admission.token
    await writeSetupState(statePath(transaction), journal)
    await check()
    if ((await readCurrentVersion(plan.root))?.bytes !== plan.pointer)
      throw Error('当前版本已改变，未开始卸载。')
    if (!sameRegistration(await readRegistration(plan.registration.key), plan.registration.before))
      throw Error('系统登记已改变，未开始卸载。')
    admission.markMutating(transaction)
    mutating = true
    await checkpoint('retiring')
    journal.removedFiles = await retireManagedPrograms(journal.programs, check)
    await checkpoint('retired')
    await check()
    await writeSetupState(retainedPath(plan.root), Buffer.from(journal.retainedAfter))
    await restoreCurrentVersion(plan.root, null, plan.pointer)
    await checkpoint('pointer-cleared')
    await withdrawShortcuts(plan.shortcuts, transaction)
    await check()
    await changeRegistration(plan.registration, transaction)
    await checkpoint('withdrawn')
    await admission.complete(async () => {
      await check()
      await verifyRemoval(journal, transaction)
      await checkpoint('committed')
      await options.committed?.(transaction, journal.removedFiles)
      await check()
    })
    settled = true
    await guard.release()
    return { transaction, removedFiles: journal.removedFiles }
  } catch (error) {
    if (!settled && journal.decision !== 'commit') {
      if (!mutating) {
        admission.cancel()
        await guard?.release().catch(() => undefined)
      } else
        try {
          // Cancellation stops forward work, but must not cancel restoration of the original state.
          const held = async (): Promise<void> => {
            await guard!.assertHeld()
          }
          await rollbackRemoval(journal, transaction, held)
          await admission.complete(async () => {
            await held()
            await checkpoint('rolled-back')
          })
          settled = true
          await guard!.release()
        } catch {
          if (!settled) await checkpoint('recovery-needed').catch(() => undefined)
        }
    }
    throw Object.assign(new Error(error instanceof Error ? error.message : '卸载未完成。'), {
      transaction
    })
  }
}

export interface RemovalExpected {
  root: string
  profile: string
  coordinator: string
  appId: string
  registryKey: string
}
async function readRemoval(
  transaction: string,
  expected: RemovalExpected
): Promise<RemovalJournal> {
  await inspectSetupDirectory(transaction)
  const record = JSON.parse(
    (await readSetupFile(statePath(transaction), 64 * 1024 * 1024)).toString('utf8')
  ) as RemovalJournal
  if (
    ![2, 3].includes(record.version) ||
    (record.decision !== undefined && record.decision !== 'commit') ||
    !uuid.test(record.id) ||
    basename(transaction) !== 'withdraw-' + record.id ||
    !same(record.root, expected.root) ||
    !same(record.profile, expected.profile) ||
    !same(record.coordinator, expected.coordinator) ||
    record.appId !== expected.appId ||
    record.registration?.key !== expected.registryKey ||
    !uuid.test(record.admissionToken) ||
    !same(dirname(transaction), record.work) ||
    !Array.isArray(record.programs) ||
    ![
      'preparing',
      'retiring',
      'retired',
      'pointer-cleared',
      'withdrawn',
      'committed',
      'rolled-back',
      'recovery-needed'
    ].includes(record.phase)
  )
    throw Error('卸载恢复记录与指定安装不一致。')
  validateRegistrationKey(record.registration.key)
  for (const path of [
    record.root,
    record.profile,
    record.coordinator,
    record.source,
    record.work,
    record.storage
  ]) {
    setupAbsolute(path)
    if ((await inspectSetupDirectory(path)).missing.length) throw Error('卸载恢复所需目录不可用。')
  }
  const allowedStorageParent =
    same(dirname(record.storage), transaction) ||
    same(dirname(record.storage), join(dirname(record.root), '.zhumo-program-recovery'))
  if (
    !allowedStorageParent ||
    !/^programs-[a-f0-9-]{36}$/.test(basename(record.storage)) ||
    setupContains(record.root, record.storage) ||
    setupContains(record.profile, record.storage) ||
    setupContains(record.root, record.source) ||
    setupContains(record.profile, record.source)
  )
    throw Error('程序恢复目录越出本次独立记录范围。')
  const pointer = JSON.parse(record.pointer) as CurrentVersionPointer
  const retained = JSON.parse(record.retainedAfter)
  if (
    retained.version !== 1 ||
    retained.id !== record.id ||
    retained.appId !== expected.appId ||
    !same(retained.root, record.root) ||
    !same(retained.profile, record.profile) ||
    (record.retainedBefore !== null && typeof record.retainedBefore !== 'string')
  )
    throw Error('保留设置的恢复记录与本次卸载不一致。')
  if (
    pointer.appId !== expected.appId ||
    !pointer.profile ||
    !same(pointer.profile, expected.profile) ||
    record.shortcuts.id !== pointer.transactionId ||
    !same(record.shortcuts.root, record.root) ||
    record.shortcuts.appId !== expected.appId ||
    registrationValue(record.registration.before, 'ZhuMoTransaction') !== pointer.transactionId ||
    registrationValue(record.registration.before, 'InstallLocation')?.toLowerCase() !==
      record.root.toLowerCase() ||
    registrationValue(record.registration.before, 'UninstallString') !==
      '"' + join(dirname(record.source), 'remove.exe') + '"'
  )
    throw Error('卸载恢复记录的程序或系统入口归属不一致。')
  if (
    JSON.stringify(await previousRecord(record.root, record.shortcuts.id, expected.appId)) !==
    JSON.stringify(record.shortcuts)
  )
    throw Error('原快捷方式归属记录发生改变，未自动恢复。')
  for (const plan of record.programs)
    validateRemovalPlan(plan, record.root, record.storage, expected.appId)
  return record
}

export async function readCompletedRemoval(
  transaction: string,
  expected: RemovalExpected
): Promise<RemovalJournal> {
  const record = await readRemoval(transaction, expected)
  if (record.phase !== 'committed' && record.decision !== 'commit')
    throw Error('尚未提交的卸载不能清理程序恢复副本。')
  return record
}
export async function readSettledRemoval(
  transaction: string,
  expected: RemovalExpected
): Promise<RemovalJournal> {
  const record = await readRemoval(transaction, expected)
  if (!['committed', 'rolled-back'].includes(record.phase))
    throw Error('未结束的程序移出事务不能清理。')
  return record
}

/** Resume only a dead writer. The native guard is reconnected, or reacquired before any IO.
 * A verified committed removal is finalized; every earlier interruption rolls back. */
export async function recoverSetupRemoval(
  transactionInput: string,
  expected: RemovalExpected,
  options: RemovalOptions = {},
  runtime: VersionUpdateRuntime = defaults
): Promise<{
  transaction: string
  phase: SetupRemovalPhase
  uninstaller?: string
  removedFiles: number
}> {
  const transaction = setupAbsolute(transactionInput),
    journal = await readRemoval(transaction, expected)
  const committedDecision = journal.decision === 'commit' || journal.phase === 'committed'
  const writers = inspectUpdateAdmission(
    [journal.root, journal.profile],
    journal.coordinator
  ).writers
  const pending = writers.filter(
    (w) => w.phase === 'mutating' && w.transaction && same(w.transaction, transaction)
  )
  if (!pending.length && (committedDecision || journal.phase === 'rolled-back')) {
    if (journal.guardDirectory) {
      try {
        const retained = await runtime.reconnectGuard(journal.guardDirectory, {
          profile: journal.profile,
          programRoots: [journal.root],
          coordinator: journal.coordinator,
          originalToken: journal.guardToken ?? journal.admissionToken
        })
        await retained.release()
      } catch {
        /* An already settled transaction does not authorize further changes. */
      }
    }
    return {
      transaction,
      phase: committedDecision ? 'committed' : journal.phase,
      uninstaller: registrationValue(journal.registration.before, 'UninstallString'),
      removedFiles: journal.removedFiles
    }
  }
  const admission = admitUpdate(
    [journal.root, journal.profile],
    journal.coordinator,
    pending.length ? journal.admissionToken : undefined
  )
  let guard: Lease | undefined,
    settled = false
  const checkpoint = async (phase: SetupRemovalPhase): Promise<void> => {
    journal.phase = phase
    await writeSetupState(statePath(transaction), journal)
    await options.progress?.(phase, transaction)
  }
  const check = async (): Promise<void> => {
    options.signal?.throwIfAborted()
    guard?.signal.throwIfAborted()
    await guard?.assertHeld()
  }
  try {
    if (committedDecision) {
      journal.decision = 'commit'
      await writeSetupState(statePath(transaction), journal)
    }
    await runtime.assertClosed([journal.root])
    if (journal.guardDirectory) {
      try {
        guard = await runtime.reconnectGuard(journal.guardDirectory, {
          profile: journal.profile,
          programRoots: [journal.root],
          coordinator: journal.coordinator,
          originalToken: journal.guardToken ?? journal.admissionToken
        })
      } catch {
        /* A fresh native lock below must prove ownership. */
      }
    }
    if (!guard) {
      const release = await verifyInstalledRelease(
        journal.source,
        await readSetupFile(join(journal.source, 'program-files.v1.json'), 64 * 1024 * 1024),
        journal.sourceManifestHash
      )
      if (release.manifest.appId !== expected.appId) throw Error('卸载恢复程序不属于此产品。')
      guard = await runtime.startGuard({
        executable: join(journal.source, release.manifest.executable),
        profile: journal.profile,
        programRoots: [journal.root],
        coordinator: journal.coordinator,
        workParent: transaction,
        appName: journal.appName,
        admission,
        signal: options.signal
      })
      journal.guardDirectory = guard.directory
      journal.guardToken = admission.token
      await writeSetupState(statePath(transaction), journal)
    }
    await check()
    if (!pending.length) admission.markMutating(transaction)
    const committed = committedDecision
    if (committed) await verifyRemoval(journal, transaction)
    else await rollbackRemoval(journal, transaction, check)
    await admission.complete(async () => {
      await check()
      await checkpoint(committed ? 'committed' : 'rolled-back')
      await check()
    })
    settled = true
    await guard.release()
    return {
      transaction,
      phase: journal.phase,
      uninstaller: registrationValue(journal.registration.before, 'UninstallString'),
      removedFiles: journal.removedFiles
    }
  } catch (error) {
    if (!settled) await checkpoint('recovery-needed').catch(() => undefined)
    throw Object.assign(new Error(error instanceof Error ? error.message : '卸载恢复未完成。'), {
      transaction
    })
  }
}
