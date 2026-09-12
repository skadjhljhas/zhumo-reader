import { basename, dirname, join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { writeReceipt, verifyReceipt } from './setup-receipt'
import { readProgramManifest } from './program-files'
import { readCurrentVersion } from './current-version'
import {
  installVersion,
  recoverVersionUpdate,
  type VersionUpdateRuntime,
  type VersionUpdatePhase
} from './version-update'
import type { SetupIntegrationStage } from './setup-integration'
import { inspectSetupIntegration } from './setup-integration'
import { verifyInstalledRelease } from './installed-release'
import { recordOwnedRuntime, validateOwnedRuntime } from './setup-runtime-ownership'
import {
  verifyCleanupExecution,
  findRemovalReceipt,
  recordRemovalReceipt,
  cleanupCompletedRemoval,
  type CleanupResult
} from './setup-cleanup'
import { verifyStagedRelease } from './release-stage'
import { withdrawSetup } from './setup-withdrawal'
import { readRetainedProfile } from './managed-programs'
import { inspectUpdateAdmission } from './update-admission'
import { recoverSetupRemoval } from './setup-removal'
import {
  readRegistration,
  registrationValue,
  validateRegistrationKey,
  type Registration
} from './setup-registry'
import { inspectShortcuts, previousRecord } from './setup-shortcuts'
import { productIdentity } from './product-identity'
import { assertOutsideLegacyInstall } from './legacy-installation'
import {
  boundReaderProfile,
  chooseNativeProfile,
  selectReaderProfile,
  type ProfileOption
} from './profile-selection'
import {
  setupAbsolute,
  setupContains,
  setupResultFile,
  readSetupFile,
  inspectSetupDirectory,
  createSetupDirectory,
  type SetupDirectory
} from './setup-paths'

export interface SetupRequest {
  source: string
  installRoot: string
  defaultProfile: string
  workRoot: string
  coordinator: string
  manifestHash: string
  appId: string
  appName: string
  resultFile: string
  desktopDirectory?: string
  menuDirectory?: string
  displayName?: string
  registryKey?: string
  uninstaller?: string
  runtimeId?: string
}
export interface SetupResult {
  root: string
  profile: string
  launcher: string
  transaction: string
  desktopLink?: string
  menuLink?: string
}
const FIELDS = [
  'source',
  'installRoot',
  'defaultProfile',
  'workRoot',
  'coordinator',
  'manifestHash',
  'appId',
  'appName',
  'resultFile'
] as const
const SHORTCUT_FIELDS = ['desktopDirectory', 'menuDirectory', 'displayName'] as const
const OPTIONAL_FIELDS = [...SHORTCUT_FIELDS, 'registryKey', 'uninstaller', 'runtimeId'] as const

export function parseSetupArguments(args: readonly string[]): SetupRequest {
  const values: Record<string, string> = {}
  if (args.length % 2 || args.length > 64) throw Error('安装参数不完整。')
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    if (
      !args[i].startsWith('--') ||
      ![...FIELDS, ...OPTIONAL_FIELDS].includes(key as never) ||
      Object.hasOwn(values, key)
    )
      throw Error('安装参数重复或无效。')
    values[key] = args[i + 1]
  }
  if (!FIELDS.every((key) => typeof values[key] === 'string' && values[key].length > 0))
    throw Error('安装参数缺失。')
  if (
    SHORTCUT_FIELDS.some((key) => key in values) &&
    !SHORTCUT_FIELDS.every((key) => values[key]?.length)
  )
    throw Error('快捷方式参数不完整。')
  if (
    (values.registryKey || values.uninstaller) &&
    (!values.registryKey || !values.uninstaller || !values.displayName)
  )
    throw Error('系统登记参数不完整。')
  return values as unknown as SetupRequest
}

/** NSIS sends a short --plan command, not nine potentially truncated filesystem arguments. */
export function parseSetupIni(bytes: Buffer): SetupRequest {
  if (
    bytes.length > 65536 ||
    bytes.length < 2 ||
    bytes.length % 2 ||
    bytes.readUInt16LE(0) !== 0xfeff
  )
    throw Error('安装计划需要带BOM的UTF-16LE文件。')
  let text: string
  try {
    text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  } catch {
    throw Error('安装计划包含无效的Unicode。')
  }
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.shift() !== '[Setup]') throw Error('安装计划节名无效。')
  const args = lines.flatMap((line) => {
    const at = line.indexOf('=')
    if (at < 1) throw Error('安装计划字段无效。')
    return ['--' + line.slice(0, at), line.slice(at + 1)]
  })
  return parseSetupArguments(args)
}

function independent(paths: string[]): void {
  for (let i = 0; i < paths.length; i++)
    for (let j = 0; j < i; j++)
      if (setupContains(paths[i], paths[j]) || setupContains(paths[j], paths[i]))
        throw Error('程序、配置、协调和恢复目录必须各自独立，不能互相包含。')
}
export interface PreparedSetup {
  input: SetupRequest
  source: string
  directories: SetupDirectory[]
  manifestBytes: Buffer
  executable: string
  currentBytes: string | null
  registration?: Registration
  profileOrigin: 'existing' | 'default'
}
/** A choice is persisted before installation mutates anything. Recovery before the first
 * current pointer exists must still use that selected profile, rather than the empty default. */
export function setupDefaultProfile(request: SetupRequest): string {
  const stable = productIdentity({ zhumoChannel: 'stable' })
  return request.appId === stable.appId
    ? (boundReaderProfile(dirname(request.defaultProfile), stable) ?? request.defaultProfile)
    : request.defaultProfile
}
/** All checks here are read-only, including a complete source-package check. */
export async function prepareSetup(
  request: SetupRequest,
  firstProfile?: string
): Promise<PreparedSetup> {
  validateOwnedRuntime(request)
  if (
    !request ||
    !FIELDS.every((field) => typeof request[field] === 'string' && request[field].length)
  )
    throw Error('安装请求字段缺失。')
  if (
    !/^[a-f0-9]{64}$/.test(request.manifestHash) ||
    !request.appId.trim() ||
    request.appId.length > 256 ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in persisted INI identities.
    /[\x00-\x1f\x7f]/.test(request.appId) ||
    request.appId !== request.appId.trim() ||
    !request.appName.trim() ||
    request.appName.length > 128 ||
    request.appName !== request.appName.trim() ||
    // eslint-disable-next-line no-control-regex -- Reject path separators and control characters in the product name.
    /[\\/\x00-\x1f\x7f]/.test(request.appName)
  )
    throw Error('安装包摘要或产品身份无效。')
  const source = setupAbsolute(request.source),
    target = setupAbsolute(request.installRoot),
    work = setupAbsolute(request.workRoot),
    coordinator = setupAbsolute(request.coordinator),
    resultFile = setupAbsolute(request.resultFile)
  setupAbsolute(request.defaultProfile)
  if (resultFile.toLowerCase() !== setupResultFile(source).toLowerCase())
    throw Error('安装结果必须写入本次独立运行目录的installed.ini。')
  const sourceDirectory = await inspectSetupDirectory(source)
  if (request.desktopDirectory || request.menuDirectory || request.displayName) {
    if (!request.desktopDirectory || !request.menuDirectory || !request.displayName)
      throw Error('快捷方式参数不完整。')
    await inspectShortcuts({
      desktopDirectory: request.desktopDirectory,
      menuDirectory: request.menuDirectory,
      displayName: request.displayName
    })
  }
  if (sourceDirectory.missing.length) throw Error('安装包运行目录不存在。')
  const targetDirectory = await inspectSetupDirectory(target)
  if (request.appId === productIdentity({ zhumoChannel: 'stable' }).appId)
    await assertOutsideLegacyInstall(target)
  const current = targetDirectory.missing.length ? null : await readCurrentVersion(target)
  if (current && current.pointer.appId !== request.appId)
    throw Error('该文件夹属于另一套朱墨安装，请选择独立目录。')
  let registration: Registration | undefined
  if (request.registryKey || request.uninstaller) {
    if (
      !request.registryKey ||
      !request.uninstaller ||
      !request.displayName ||
      !request.desktopDirectory ||
      !request.menuDirectory
    )
      throw Error('系统登记参数不完整。')
    validateRegistrationKey(request.registryKey)
    if (
      setupAbsolute(request.uninstaller).toLowerCase() !==
      join(dirname(source), 'remove.exe').toLowerCase()
    )
      throw Error('卸载入口必须属于本次独立运行目录。')
    await readSetupFile(request.uninstaller, 512 * 1024 * 1024)
    registration = await readRegistration(request.registryKey)
    if (
      registration.values.length &&
      (!current ||
        registrationValue(registration, 'InstallLocation')?.toLowerCase() !==
          target.toLowerCase() ||
        registrationValue(registration, 'ManifestHash') !== current.pointer.manifestSha256 ||
        (registrationValue(registration, 'ZhuMoAppId') !== undefined &&
          registrationValue(registration, 'ZhuMoAppId') !== request.appId))
    )
      throw Error('系统登记属于另一处安装或已经改变，未覆盖它。')
  }
  const retainedProfile =
    !current && !targetDirectory.missing.length
      ? await readRetainedProfile(target, request.appId)
      : undefined
  const profile = current?.pointer.profile
    ? setupAbsolute(current.pointer.profile)
    : (retainedProfile ??
      (firstProfile ? setupAbsolute(firstProfile) : setupAbsolute(setupDefaultProfile(request))))
  const profileDirectory = await inspectSetupDirectory(profile)
  if ((current?.pointer.profile || retainedProfile) && profileDirectory.missing.length)
    throw Error('当前安装的设置目录不可用，不能用空设置替代。')
  independent([source, target, work, coordinator, profile])
  if ([target, work, coordinator, profile].some((p) => setupContains(p, resultFile)))
    throw Error('安装结果不能写入程序、设置或恢复目录。')
  const directories = [
    targetDirectory,
    profileDirectory,
    await inspectSetupDirectory(work),
    await inspectSetupDirectory(coordinator)
  ]
  try {
    await fs.lstat(resultFile)
    throw Error('本次安装结果文件已存在，未覆盖或执行安装。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const bytes = await readSetupFile(join(source, 'program-files.v1.json'), 64 * 1024 * 1024)
  const manifest = readProgramManifest(bytes, request.manifestHash)
  if (manifest.appId !== request.appId) throw Error('安装包身份与指定产品不一致。')
  await verifyStagedRelease(source, bytes, request.manifestHash)
  return {
    input: { ...request, resultFile },
    source,
    directories,
    manifestBytes: bytes,
    executable: manifest.executable,
    currentBytes: current?.bytes ?? null,
    registration,
    profileOrigin: current?.pointer.profile || retainedProfile ? 'existing' : 'default'
  }
}

/** Native integration is serialized into the guarded version journal, so another process
 * can finish or roll back the same operation after interruption. */
export async function installFromSetup(
  request: SetupRequest,
  signal?: AbortSignal,
  runtime?: VersionUpdateRuntime,
  options: {
    selectProfile?: (profiles: readonly ProfileOption[]) => number | undefined
    progress?: (
      stage: VersionUpdatePhase | SetupIntegrationStage,
      transaction: string
    ) => void | Promise<void>
  } = {}
): Promise<SetupResult> {
  signal?.throwIfAborted()
  let prepared = await prepareSetup(request)
  const stable = productIdentity({ zhumoChannel: 'stable' })
  if (request.appId === stable.appId && prepared.profileOrigin === 'default') {
    if (basename(request.defaultProfile) !== stable.profileFolder)
      throw Error('正式产品的默认阅读资料位置与发行身份不一致。')
    const helper = join(
      prepared.source,
      'resources/app.asar.unpacked/out/main/native/ProfileChooser.exe'
    )
    const selected = selectReaderProfile({
      product: stable,
      appData: dirname(request.defaultProfile),
      choose:
        options.selectProfile ??
        (process.env.ZHUMO_TEST_BACKGROUND === '1' || process.env.ZHUMO_SETUP_NO_UI === '1'
          ? () => {
              throw Error('存在多套阅读资料；请先在安装界面选择一次，再使用静默安装。')
            }
          : (choices) => chooseNativeProfile(helper, choices))
    })
    prepared = await prepareSetup(request, selected)
  }
  signal?.throwIfAborted()
  const [install, profile, work, coordinator] = prepared.directories
  const data: SetupResult = {
    root: install.path,
    profile: profile.path,
    launcher: join(prepared.source, prepared.executable),
    transaction: ''
  }
  const output = await fs.open(prepared.input.resultFile, 'wx+', 0o600)
  try {
    await writeReceipt(output, prepared.input.resultFile, data, 'preparing')
    const receipt = await output.stat({ bigint: true })
    const created = new Set<string>()
    for (const directory of prepared.directories) {
      signal?.throwIfAborted()
      await createSetupDirectory(directory, created)
    }
    const result = await installVersion(
      {
        source: prepared.source,
        installRoot: install.path,
        profile: profile.path,
        workRoot: work.path,
        coordinator: coordinator.path,
        libraryRoots: [],
        manifestBytes: prepared.manifestBytes.toString('utf8'),
        manifestSha256: request.manifestHash,
        expectedAppId: request.appId,
        expectedCurrentBytes: prepared.currentBytes,
        appName: request.appName,
        setup: {
          version: 1,
          request: prepared.input,
          registration: prepared.registration,
          receipt: { dev: receipt.dev.toString(), ino: receipt.ino.toString() },
          runtimeOwner: await recordOwnedRuntime(prepared.input, prepared.manifestBytes)
        }
      },
      {
        signal,
        setupProgress: async (stage, transaction) => {
          data.transaction = transaction
          await options.progress?.(stage, transaction)
        },
        progress: async (phase, transaction) => {
          data.transaction = transaction
          process.stdout.write(JSON.stringify({ phase }) + '\n')
          await options.progress?.(phase, transaction)
        }
      },
      runtime
    )
    if (!result.setupResult) throw Error('安装集成未返回完成结果。')
    return result.setupResult
  } catch (error) {
    if (!(error as { committed?: boolean }).committed)
      await writeReceipt(output, prepared.input.resultFile, data, 'incomplete').catch(
        () => undefined
      )
    throw error
  } finally {
    await output.close()
  }
}

export async function runSetupCommand(
  args: readonly string[],
  signal?: AbortSignal,
  runtime?: VersionUpdateRuntime
): Promise<SetupResult | { transaction: string; removedFiles: number; cleanup?: CleanupResult }> {
  const executionSource =
    args.length === 4 && args[0] === '--uninstall' && args[2] === '--execution-source'
      ? setupAbsolute(args[3])
      : undefined
  if (executionSource) args = args.slice(0, 2)
  const input =
    args.length === 2 && ['--plan', '--uninstall'].includes(args[0])
      ? parseSetupIni(await readSetupFile(args[1]))
      : parseSetupArguments(args)
  if (
    ['--plan', '--uninstall'].includes(args[0]) &&
    setupAbsolute(args[1]).toLowerCase() !==
      join(dirname(setupAbsolute(input.source)), 'setup.ini').toLowerCase()
  )
    throw Error('安装计划应来自本次独立运行目录。')
  if (executionSource) {
    if (!runtime && process.versions.electron && !sameExecutionSource(executionSource))
      throw Error('清理环境并非实际执行的帮助程序。')
    await verifyCleanupExecution(executionSource, input)
    const previous = await findRemovalReceipt(input)
    if (previous) {
      const profile = await readRetainedProfile(input.installRoot, input.appId)
      if (!profile || !input.registryKey) throw Error('原卸载资料身份无法核对。')
      await recoverSetupRemoval(
        previous.transaction,
        {
          root: setupAbsolute(input.installRoot),
          profile,
          coordinator: setupAbsolute(input.coordinator),
          appId: input.appId,
          registryKey: input.registryKey
        },
        { signal },
        runtime
      )
      return completeCleanup(input, previous, executionSource)
    }
  }
  if (args[0] === '--plan') {
    const done = await completedSetupResult(input, signal, runtime)
    if (done) return done
  }
  const root = setupAbsolute(input.installRoot)
  if (input.registryKey && !(await inspectSetupDirectory(root)).missing.length) {
    const current = await readCurrentVersion(root)
    const profile =
      current?.pointer.profile ??
      (await readRetainedProfile(root, input.appId)) ??
      setupDefaultProfile(input)
    for (const writer of inspectUpdateAdmission([root, profile], input.coordinator).writers) {
      if (writer.phase !== 'mutating' || writer.ownerAlive || !writer.transaction) continue
      if (/^update-[a-f0-9-]{36}$/i.test(basename(writer.transaction))) {
        const record = JSON.parse(
          (await readSetupFile(join(writer.transaction, 'journal.json'), 1024 * 1024)).toString(
            'utf8'
          )
        )
        if (
          record.version !== 2 ||
          !record.setup ||
          record.setup.request?.registryKey !== input.registryKey
        )
          throw Error('之前的更新缺少相符的系统入口恢复记录，未仅切换程序来代替恢复。')
        const action =
          record.decision === 'commit' || record.phase === 'committed' ? 'commit' : 'rollback'
        await recoverVersionUpdate(
          writer.transaction,
          { installRoot: root, profile, coordinator: input.coordinator, appId: input.appId },
          action,
          { signal },
          runtime
        )
        if (
          args[0] === '--plan' &&
          action === 'commit' &&
          setupAbsolute(record.setup.request.source).toLowerCase() ===
            setupAbsolute(input.source).toLowerCase()
        ) {
          const current = await readCurrentVersion(root)
          if (!current || current.pointer.transactionId !== record.id)
            throw Error('已恢复安装的当前入口不一致。')
          const links = await previousRecord(root, record.id, input.appId)
          return {
            root,
            profile,
            launcher: join(input.source, current.pointer.executable),
            transaction: writer.transaction,
            desktopLink: links?.entries.find((e) => e.kind === 'desktop')?.path,
            menuLink: links?.entries.find((e) => e.kind === 'menu')?.path
          }
        }
        continue
      }
      if (!/^withdraw-[a-f0-9-]{36}$/i.test(basename(writer.transaction)))
        throw Error('存在无法识别的未完成安装操作，未覆盖其记录。')
      const recovered = await recoverSetupRemoval(
        writer.transaction,
        {
          root,
          profile,
          coordinator: input.coordinator,
          appId: input.appId,
          registryKey: input.registryKey
        },
        { signal },
        runtime
      )
      if (
        args[0] === '--uninstall' &&
        recovered.phase === 'committed' &&
        recovered.uninstaller === '"' + input.uninstaller + '"'
      ) {
        const result = { transaction: recovered.transaction, removedFiles: recovered.removedFiles }
        if (executionSource) {
          await recordRemovalReceipt(input, result)
          return completeCleanup(input, result, executionSource)
        }
        return result
      }
    }
  }
  if (args[0] !== '--uninstall') return installFromSetup(input, signal, runtime)
  const result = await withdrawSetup(
    input,
    signal,
    runtime,
    executionSource
      ? {
          committed: async (transaction, removedFiles) =>
            recordRemovalReceipt(input, { transaction, removedFiles })
        }
      : undefined
  )
  if (executionSource) {
    await recordRemovalReceipt(input, result)
    return completeCleanup(input, result, executionSource)
  }
  return result
}
function sameExecutionSource(source: string): boolean {
  return source.toLowerCase() === dirname(process.execPath).toLowerCase()
}
async function completeCleanup(
  input: SetupRequest,
  result: { transaction: string; removedFiles: number },
  executionSource: string
): Promise<{ transaction: string; removedFiles: number; cleanup: CleanupResult }> {
  if (!input.registryKey) throw Error('清理缺少本次系统登记身份。')
  const profile = await readRetainedProfile(input.installRoot, input.appId)
  if (!profile) throw Error('卸载后的原资料位置记录不可用。')
  const cleanup = await cleanupCompletedRemoval(
    result.transaction,
    {
      root: setupAbsolute(input.installRoot),
      profile,
      coordinator: setupAbsolute(input.coordinator),
      appId: input.appId,
      registryKey: input.registryKey
    },
    executionSource
  )
  return { ...result, cleanup }
}

/** A completed operation has no mutating writer. Its original receipt, request and current
 * version must still agree before the same command may return its existing result. */
async function completedSetupResult(
  input: SetupRequest,
  signal?: AbortSignal,
  runtime?: VersionUpdateRuntime
): Promise<SetupResult | undefined> {
  const root = setupAbsolute(input.installRoot)
  if ((await inspectSetupDirectory(root)).missing.length) return undefined
  const current = await readCurrentVersion(root)
  if (!current?.pointer.profile || current.pointer.appId !== input.appId) return undefined
  const transaction = join(setupAbsolute(input.workRoot), 'update-' + current.pointer.transactionId)
  let bytes: Buffer
  try {
    bytes = await readSetupFile(join(transaction, 'journal.json'), 1024 * 1024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record = JSON.parse(bytes.toString('utf8'))
  if (
    record.version !== 2 ||
    !record.setup ||
    !(record.decision === 'commit' || record.phase === 'committed')
  )
    return undefined
  const paths = new Set([
    'source',
    'installRoot',
    'defaultProfile',
    'workRoot',
    'coordinator',
    'resultFile',
    'desktopDirectory',
    'menuDirectory',
    'uninstaller'
  ])
  for (const name of [...FIELDS, ...OPTIONAL_FIELDS]) {
    const a = input[name],
      b = record.setup.request?.[name]
    if (a === undefined && b === undefined) continue
    if (typeof a !== 'string' || typeof b !== 'string') return undefined
    if (
      paths.has(name) ? setupAbsolute(a).toLowerCase() !== setupAbsolute(b).toLowerCase() : a !== b
    )
      return undefined
  }
  const profile = current.pointer.profile
  const recovered = await recoverVersionUpdate(
    transaction,
    { installRoot: root, profile, coordinator: input.coordinator, appId: input.appId },
    'commit',
    { signal },
    runtime
  )
  if (recovered.phase !== 'committed') throw Error('原安装尚未完成提交。')
  await verifyInstalledRelease(
    join(root, '.zhumo', 'versions', current.pointer.releaseId),
    await readSetupFile(join(transaction, 'release-manifest.json'), 64 * 1024 * 1024),
    current.pointer.manifestSha256
  )
  const data = await inspectSetupIntegration(record.setup, {
    root,
    profile,
    source: setupAbsolute(input.source),
    transaction,
    before: record.before,
    next: record.next
  })
  await verifyReceipt(input.resultFile, data, record.setup.receipt)
  if ((await readCurrentVersion(root))?.bytes !== current.bytes)
    throw Error('核对完成结果时当前版本已改变。')
  return data
}
if (process.argv[1] && basename(process.argv[1]) === 'setup-action.js') {
  const abort = new AbortController()
  process.on('SIGINT', () => abort.abort())
  void runSetupCommand(process.argv.slice(2), abort.signal)
    .then((result) => {
      process.stdout.write(
        JSON.stringify({
          operation: process.argv[2] === '--uninstall' ? 'uninstall' : 'install',
          ...result
        }) + '\n'
      )
    })
    .catch((error) => {
      process.stderr.write(
        JSON.stringify({
          error: error instanceof Error ? error.message : '安装未完成。',
          ...(error?.transaction ? { transaction: error.transaction } : {})
        }) + '\n'
      )
      process.exitCode = 1
    })
}
