import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, parse, relative, sep } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { admitUpdate, inspectUpdateAdmission, type UpdateAdmission } from './update-admission'
import { assertProgramsClosed } from './update-process-guard'
import {
  startProfileGuard,
  type ProfileGuardClient,
  type ProfileGuardOptions
} from './profile-guard-client'
import {
  createPreservationSnapshot,
  verifyPreservationSnapshot,
  fileDigest
} from './update-preservation'
import { stageRelease, verifyStagedRelease } from './release-stage'
import {
  readCurrentVersion,
  publishCurrentVersion,
  restoreCurrentVersion,
  type CurrentVersionPointer
} from './current-version'
import { reconnectProfileGuard } from './retained-profile-guard'
import { verifyInstalledRelease } from './installed-release'
import { rememberManagedVersion } from './managed-programs'
import {
  finishSetupIntegration,
  validateSetupIntegration,
  type SetupIntegration,
  type SetupIntegrationProgress
} from './setup-integration'
import type { SetupResult } from './setup-action'

export interface VersionUpdatePlan {
  installRoot: string
  profile: string
  /** Explicit manuscript/image roots outside the install root, including the bound library. */
  libraryRoots: string[]
  source: string
  manifestBytes: string
  manifestSha256: string
  expectedAppId: string
  expectedCurrentBytes: string | null
  coordinator: string
  /** Existing private work root outside every protected/source directory. */
  workRoot: string
  appName: string
  setup?: SetupIntegration
}
export type VersionUpdatePhase =
  | 'preparing'
  | 'saved'
  | 'staged'
  | 'publishing'
  | 'published'
  | 'committed'
  | 'cancelled'
  | 'rolled-back'
  | 'recovery-needed'
interface VersionUpdateJournal {
  version: 1 | 2
  id: string
  phase: VersionUpdatePhase
  installRoot: string
  profile: string
  libraryRoots: string[]
  coordinator: string
  source: string
  appName: string
  admissionToken: string
  guardDirectory?: string
  guardToken?: string
  snapshot?: string
  before: string | null
  next: CurrentVersionPointer
  updatedAt: string
  setup?: SetupIntegration
  /** Immutable commit decision; later recovery attempts may change phase but never undo this. */
  decision?: 'commit'
}
export interface VersionUpdateResult {
  transaction: string
  directory: string
  snapshot: string
  pointer: CurrentVersionPointer
  setupResult?: SetupResult
}
export interface VersionUpdateOptions {
  signal?: AbortSignal
  progress?: (phase: VersionUpdatePhase, transaction: string) => void | Promise<void>
  setupProgress?: SetupIntegrationProgress
}
/** Injectable lifecycle only; staging, snapshots and pointer publication are always real IO. */
export interface VersionUpdateRuntime {
  startGuard(options: ProfileGuardOptions): Promise<GuardLease>
  reconnectGuard: typeof reconnectProfileGuard
  assertClosed(roots: string[]): Promise<void>
}
type GuardLease = Pick<
  ProfileGuardClient,
  'pid' | 'directory' | 'signal' | 'assertHeld' | 'release'
>
const defaults: VersionUpdateRuntime = {
  startGuard: startProfileGuard,
  reconnectGuard: reconnectProfileGuard,
  assertClosed: assertProgramsClosed
}
const inside = (a: string, b: string): boolean => {
  const r = relative(a.toLowerCase(), b.toLowerCase())
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
}
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw Error('更新需要明确的绝对目录。')
  const actual = await fs.realpath(path)
  if (actual === parse(actual).root || !(await fs.stat(actual)).isDirectory())
    throw Error('不能更新盘根或非目录。')
  return actual
}
async function writeJournal(transaction: string, data: VersionUpdateJournal): Promise<void> {
  const temp = join(transaction, 'journal.' + randomUUID() + '.tmp')
  const output = await fs.open(temp, 'wx', 0o600)
  try {
    await output.writeFile(JSON.stringify(data, null, 2))
    await output.sync()
  } finally {
    await output.close()
  }
  await fs.rename(temp, join(transaction, 'journal.json'))
}
async function writeExclusive(path: string, text: string): Promise<void> {
  const output = await fs.open(path, 'wx', 0o600)
  try {
    await output.writeFile(text)
    await output.sync()
  } finally {
    await output.close()
  }
}
/** Existing content is never restored over live files: this checks that it was not altered.
 * A current-pointer change is the only permitted change to a pre-existing regular file. */
export async function assertUpdateSourcesPreserved(
  snapshot: string,
  installRoot: string,
  profile: string
): Promise<void> {
  const saved = await verifyPreservationSnapshot(snapshot)
  const pointerPath = join(installRoot, '.zhumo', 'current.json').toLowerCase()
  const nativeLock = join(profile, 'lockfile').toLowerCase()
  for (const root of saved.roots)
    for (const item of root.entries) {
      const path = item.path ? join(root.source, item.path) : root.source
      if (path.toLowerCase() === pointerPath || path.toLowerCase() === nativeLock) continue
      const info = await fs.lstat(path)
      if (item.kind === 'file') {
        if (!info.isFile() || info.isSymbolicLink())
          throw Error('更新期间原有文件类型改变，未完成切换验证。')
        const actual = await fileDigest(path)
        if (actual.sha256 !== item.sha256 || actual.size !== item.size)
          throw Error('更新期间原有文件发生改变，已保留现场。')
      } else if (item.kind === 'directory') {
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('更新期间原有目录发生改变。')
      } else if (
        !info.isSymbolicLink() ||
        (await fs.realpath(path)).toLowerCase() !== item.resolved.toLowerCase()
      ) {
        throw Error('更新期间原有链接发生改变。')
      }
    }
}

/** Side-by-side update: preserve originals, verify the new release, then switch one pointer.
 * No old uninstaller, recursive cleanup, profile migration or document overwrite is invoked. */
export async function installVersion(
  plan: VersionUpdatePlan,
  options: VersionUpdateOptions = {},
  runtime: VersionUpdateRuntime = defaults
): Promise<VersionUpdateResult> {
  const input = {
    ...plan,
    libraryRoots: [...plan.libraryRoots],
    setup: plan.setup ? structuredClone(plan.setup) : undefined
  }
  options.signal?.throwIfAborted()
  const [installRoot, profile, source, workRoot, coordinator, ...libraryRoots] = await Promise.all(
    [
      input.installRoot,
      input.profile,
      input.source,
      input.workRoot,
      input.coordinator,
      ...input.libraryRoots
    ].map(directory)
  )
  const bindingText = await fs
    .readFile(join(profile, 'manuscript-library.v1.json'), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
  if (bindingText !== undefined) {
    const binding = JSON.parse(bindingText)
    if (binding.version !== 1 || typeof binding.path !== 'string' || !isAbsolute(binding.path))
      throw Error('文稿位置记录无效。')
    libraryRoots.push(await directory(binding.path))
  }
  const protectedRoots = [...new Set([installRoot, profile, ...libraryRoots])]
  if (
    protectedRoots.some(
      (root) =>
        inside(root, workRoot) ||
        inside(workRoot, root) ||
        inside(root, source) ||
        inside(source, root)
    )
  )
    throw Error('更新暂存程序与恢复记录必须位于原程序、设置和文稿之外。')
  const staged = await verifyStagedRelease(source, input.manifestBytes, input.manifestSha256)
  if (staged.manifest.appId !== input.expectedAppId) throw Error('新程序身份与本次更新产品不一致。')
  const current = await readCurrentVersion(installRoot)
  if ((current?.bytes ?? null) !== input.expectedCurrentBytes)
    throw Error('当前版本已改变，未执行更新。')
  if (current && current.pointer.appId !== input.expectedAppId)
    throw Error('不能把另一个产品的资料静默改为本产品。')
  if (
    current?.pointer.profile &&
    (await directory(current.pointer.profile)).toLowerCase() !== profile.toLowerCase()
  )
    throw Error('当前安装使用另一份设置，本次未迁移或替换它。')
  await runtime.assertClosed([installRoot])
  options.signal?.throwIfAborted()
  const id = randomUUID(),
    transaction = join(workRoot, 'update-' + id)
  await fs.mkdir(transaction, { mode: 0o700 })
  await writeExclusive(join(transaction, 'release-manifest.json'), input.manifestBytes)
  const next: CurrentVersionPointer = {
    version: 1,
    releaseId: id,
    transactionId: id,
    manifestSha256: input.manifestSha256,
    appId: input.expectedAppId,
    appVersion: staged.manifest.appVersion,
    executable: staged.manifest.executable,
    profile
  }
  const journal: VersionUpdateJournal = {
    version: input.setup ? 2 : 1,
    id,
    phase: 'preparing',
    installRoot,
    profile,
    libraryRoots,
    coordinator,
    source,
    appName: input.appName,
    admissionToken: '',
    before: input.expectedCurrentBytes,
    next,
    updatedAt: new Date().toISOString(),
    setup: input.setup
  }
  const setupContext = {
    root: installRoot,
    profile,
    source,
    transaction,
    before: journal.before,
    next
  }
  if (journal.setup) validateSetupIntegration(journal.setup, setupContext)
  let setupResult: SetupResult | undefined
  let admission: UpdateAdmission | undefined,
    guard: GuardLease | undefined,
    mutating = false,
    settled = false
  const checkpoint = async (phase: VersionUpdatePhase): Promise<void> => {
    const nextState = {
      ...journal,
      phase,
      updatedAt: new Date().toISOString(),
      ...(phase === 'committed' && journal.setup ? { decision: 'commit' as const } : {})
    }
    await writeJournal(transaction, nextState)
    Object.assign(journal, nextState)
    await options.progress?.(phase, transaction)
  }
  const check = async (): Promise<void> => {
    options.signal?.throwIfAborted()
    guard?.signal.throwIfAborted()
    if (guard) await guard.assertHeld()
  }
  try {
    admission = admitUpdate([installRoot, profile], coordinator)
    journal.admissionToken = admission.token
    await checkpoint('preparing')
    if (((await readCurrentVersion(installRoot))?.bytes ?? null) !== input.expectedCurrentBytes)
      throw Error('取得更新准入时当前版本已改变，请重新核对。')
    guard = await runtime.startGuard({
      executable: join(source, staged.manifest.executable),
      profile,
      programRoots: [installRoot],
      coordinator,
      workParent: transaction,
      appName: input.appName,
      admission,
      signal: options.signal
    })
    journal.guardDirectory = guard.directory
    journal.guardToken = admission.token
    await writeJournal(transaction, journal)
    await check()
    journal.snapshot = await createPreservationSnapshot(
      protectedRoots,
      join(transaction, 'snapshot'),
      {
        signal: options.signal,
        progress: async () => check()
      }
    )
    await checkpoint('saved')
    await check()
    // Metadata is our reserved namespace; links must never redirect its creation elsewhere.
    for (const path of [join(installRoot, '.zhumo'), join(installRoot, '.zhumo', 'versions')]) {
      await fs.mkdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const info = await fs.lstat(path)
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (await fs.realpath(path)).toLowerCase() !== path.toLowerCase()
      )
        throw Error('版本目录被链接或其它文件占用。')
    }
    const destination = join(installRoot, '.zhumo', 'versions', id)
    await stageRelease(source, destination, input.manifestBytes, input.manifestSha256, {
      signal: options.signal,
      progress: async () => check()
    })
    await checkpoint('staged')
    await check()
    if (current) await rememberManagedVersion(installRoot, { ...current.pointer, profile })
    await rememberManagedVersion(installRoot, next)
    await assertUpdateSourcesPreserved(journal.snapshot, installRoot, profile)
    await checkpoint('publishing')
    await check()
    admission.markMutating(transaction)
    mutating = true
    await publishCurrentVersion(installRoot, next, journal.before)
    await checkpoint('published')
    await admission.complete(async () => {
      await check()
      const published = await readCurrentVersion(installRoot)
      if (!published || !samePointer(published.pointer, next)) throw Error('新版本入口未通过核验。')
      await verifyStagedRelease(destination, input.manifestBytes, input.manifestSha256)
      await assertUpdateSourcesPreserved(journal.snapshot!, installRoot, profile)
      if (journal.setup)
        setupResult = await finishSetupIntegration(
          journal.setup,
          setupContext,
          'commit',
          options.setupProgress
        )
      await checkpoint('committed')
      await check()
    })
    mutating = false
    settled = true
    await guard.release()
    return {
      transaction,
      directory: destination,
      snapshot: journal.snapshot,
      pointer: next,
      setupResult
    }
  } catch (error) {
    if (settled || journal.decision === 'commit') {
      // The pointer is committed; failure to clean up/release must not rewrite history
      // as a cancelled installation. Recovery can finish releasing the retained guard.
    } else if (!mutating) {
      admission?.cancel()
      await guard?.release().catch(() => undefined)
      await checkpoint('cancelled').catch(() => undefined)
    } else {
      try {
        await guard!.assertHeld()
        await restorePreviousPointer(journal)
        if (journal.setup) await finishSetupIntegration(journal.setup, setupContext, 'rollback')
        await admission!.complete(async () => {
          await guard!.assertHeld()
          if (((await readCurrentVersion(installRoot))?.bytes ?? null) !== journal.before)
            throw Error('回滚入口校验失败。')
          await checkpoint('rolled-back')
        })
        settled = true
        await guard!.release()
      } catch {
        if (!settled) await checkpoint('recovery-needed').catch(() => undefined)
      }
    }
    throw Object.assign(new Error(error instanceof Error ? error.message : '更新未完成。'), {
      transaction,
      committed: settled || journal.decision === 'commit'
    })
  }
}

function samePointer(a: CurrentVersionPointer, b: CurrentVersionPointer): boolean {
  return [
    'version',
    'releaseId',
    'transactionId',
    'manifestSha256',
    'appId',
    'appVersion',
    'executable',
    'profile'
  ].every((key) => a[key as keyof CurrentVersionPointer] === b[key as keyof CurrentVersionPointer])
}
async function restorePreviousPointer(journal: VersionUpdateJournal): Promise<void> {
  const current = await readCurrentVersion(journal.installRoot)
  if ((current?.bytes ?? null) === journal.before) return
  if (!current || !samePointer(current.pointer, journal.next))
    throw Error('当前入口已被其它操作改变，不覆盖冲突。')
  if (journal.before) {
    const old = JSON.parse(journal.before) as CurrentVersionPointer
    const oldDir = join(journal.installRoot, '.zhumo', 'versions', old.releaseId)
    const bytes = await fs.readFile(join(oldDir, 'program-files.v1.json'))
    await verifyInstalledRelease(oldDir, bytes, old.manifestSha256)
  }
  await restoreCurrentVersion(journal.installRoot, journal.before, current.bytes)
}

/** Explicit crash recovery never writes a snapshot over the user's present documents.
 * It either verifies/publishes the already copied release or restores the prior pointer. */
export async function recoverVersionUpdate(
  transactionInput: string,
  expected: { installRoot: string; profile: string; coordinator: string; appId: string },
  action: 'commit' | 'rollback',
  options: VersionUpdateOptions = {},
  runtime: VersionUpdateRuntime = defaults
): Promise<{ transaction: string; phase: VersionUpdatePhase }> {
  const transaction = await directory(transactionInput)
  const file = join(transaction, 'journal.json'),
    info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw Error('更新恢复记录无效。')
  const journal = JSON.parse(await fs.readFile(file, 'utf8')) as VersionUpdateJournal
  const roots = await Promise.all(
    [expected.installRoot, expected.profile, expected.coordinator].map(directory)
  )
  if (
    ![1, 2].includes(journal.version) ||
    (journal.version === 2 && !journal.setup) ||
    (journal.version === 1 && journal.setup !== undefined) ||
    (journal.decision !== undefined && (journal.version !== 2 || journal.decision !== 'commit')) ||
    !/^update-[a-f0-9-]{36}$/.test(basename(transaction)) ||
    basename(transaction) !== 'update-' + journal.id ||
    [journal.installRoot, journal.profile, journal.coordinator].some(
      (value, i) => typeof value !== 'string' || value.toLowerCase() !== roots[i].toLowerCase()
    ) ||
    !journal.next ||
    journal.next.appId !== expected.appId ||
    journal.next.profile !== journal.profile ||
    journal.next.transactionId !== journal.id ||
    journal.next.releaseId !== journal.id ||
    !Array.isArray(journal.libraryRoots) ||
    journal.libraryRoots.some((path) => typeof path !== 'string' || !isAbsolute(path)) ||
    !['commit', 'rollback'].includes(action)
  )
    throw Error('恢复记录与指定安装和资料不一致。')
  const setupContext = {
    root: journal.installRoot,
    profile: journal.profile,
    source: journal.source,
    transaction,
    before: journal.before,
    next: journal.next
  }
  if (journal.setup) validateSetupIntegration(journal.setup, setupContext)
  const committedSetup =
    journal.version === 2 && (journal.decision === 'commit' || journal.phase === 'committed')
  if (committedSetup && action !== 'commit')
    throw Error('安装决定已经提交，恢复只能完成收尾；不能将其降级为未提交。')
  const update = (phase: VersionUpdatePhase): Promise<void> => {
    journal.phase = phase
    journal.updatedAt = new Date().toISOString()
    return writeJournal(transaction, journal)
  }
  const published = await readCurrentVersion(journal.installRoot)
  const writers = inspectUpdateAdmission(
    [journal.installRoot, journal.profile],
    journal.coordinator
  ).writers
  const unfinished = writers.filter(
    (writer) =>
      writer.phase === 'mutating' && writer.transaction?.toLowerCase() === transaction.toLowerCase()
  )
  if (
    !unfinished.length &&
    (committedSetup || ['committed', 'rolled-back', 'cancelled'].includes(journal.phase))
  ) {
    const matches =
      committedSetup || journal.phase === 'committed'
        ? published && samePointer(published.pointer, journal.next)
        : (published?.bytes ?? null) === journal.before
    if (!matches) throw Error('已完成事务的当前入口不一致，不能自动处理。')
    if (journal.guardDirectory) {
      try {
        const retained = await runtime.reconnectGuard(journal.guardDirectory, {
          profile: journal.profile,
          programRoots: [journal.installRoot],
          coordinator: journal.coordinator,
          originalToken: journal.guardToken ?? journal.admissionToken
        })
        await retained.release()
      } catch {
        /* No data mutation or lock removal is authorized by an already settled journal. */
      }
    }
    return { transaction, phase: committedSetup ? 'committed' : journal.phase }
  }
  const admission = admitUpdate(
    [journal.installRoot, journal.profile],
    journal.coordinator,
    unfinished.length ? journal.admissionToken : undefined
  )
  let guard: GuardLease | undefined,
    settled = false
  try {
    // Persist legacy v2 committed evidence before any fallible recovery work.
    if (committedSetup) {
      journal.decision = 'commit'
      await writeJournal(transaction, journal)
    }
    await runtime.assertClosed([journal.installRoot])
    if (journal.guardDirectory) {
      try {
        guard = await runtime.reconnectGuard(journal.guardDirectory, {
          profile: journal.profile,
          programRoots: [journal.installRoot],
          coordinator: journal.coordinator,
          originalToken: journal.guardToken ?? journal.admissionToken
        })
      } catch {
        /* A new native guard must prove ownership before any publication below. */
      }
    }
    if (!guard) {
      const bytes = await fs.readFile(join(transaction, 'release-manifest.json'))
      const verifyBootstrap = committedSetup ? verifyInstalledRelease : verifyStagedRelease
      const release = await verifyBootstrap(journal.source, bytes, journal.next.manifestSha256)
      guard = await runtime.startGuard({
        executable: join(release.directory, release.manifest.executable),
        profile: journal.profile,
        programRoots: [journal.installRoot],
        coordinator: journal.coordinator,
        workParent: transaction,
        appName: journal.appName,
        admission,
        signal: options.signal
      })
      journal.guardDirectory = guard.directory
      journal.guardToken = admission.token
      await writeJournal(transaction, journal)
    }
    await guard.assertHeld()
    if (!unfinished.length) admission.markMutating(transaction)
    if (action === 'rollback') await restorePreviousPointer(journal)
    else {
      const bytes = await fs.readFile(join(transaction, 'release-manifest.json'))
      const sealedSetup = committedSetup
      const verify = sealedSetup ? verifyInstalledRelease : verifyStagedRelease
      await verify(
        join(journal.installRoot, '.zhumo', 'versions', journal.id),
        bytes,
        journal.next.manifestSha256
      )
      if (!journal.snapshot || !inside(transaction, journal.snapshot))
        throw Error('缺少本事务的完整保存点。')
      // A v2 committed marker follows native integration and source verification. A later
      // user edit is not an installation failure; recovery never restores old document bytes.
      if (!sealedSetup)
        await assertUpdateSourcesPreserved(journal.snapshot, journal.installRoot, journal.profile)
      const current = await readCurrentVersion(journal.installRoot)
      if (!current || !samePointer(current.pointer, journal.next))
        await publishCurrentVersion(journal.installRoot, journal.next, journal.before)
    }
    await admission.complete(async () => {
      await guard!.assertHeld()
      const current = await readCurrentVersion(journal.installRoot)
      const matches =
        action === 'commit'
          ? current && samePointer(current.pointer, journal.next)
          : (current?.bytes ?? null) === journal.before
      if (!matches) throw Error('恢复后的入口核验失败。')
      if (journal.setup)
        await finishSetupIntegration(journal.setup, setupContext, action, options.setupProgress)
      if (action === 'commit' && journal.setup) journal.decision = 'commit'
      await update(action === 'commit' ? 'committed' : 'rolled-back')
      await guard!.assertHeld()
    })
    settled = true
    await guard.release()
    return { transaction, phase: journal.phase }
  } catch (error) {
    if (!settled) await update('recovery-needed').catch(() => undefined)
    throw Object.assign(new Error(error instanceof Error ? error.message : '更新恢复未完成。'), {
      transaction
    })
  }
}
