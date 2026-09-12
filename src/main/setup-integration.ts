import { dirname, join } from 'node:path'
import type { SetupRequest, SetupResult } from './setup-action'
import type { CurrentVersionPointer } from './current-version'
import type { RuntimeOwnershipReference } from './setup-runtime-ownership'
import { resumeReceipt, type ReceiptIdentity } from './setup-receipt'
import { setupAbsolute, setupResultFile } from './setup-paths'
import { readSetupFile } from './setup-paths'
import { verifyInstalledRelease } from './installed-release'
import {
  previousRecord,
  installShortcuts,
  rollbackShortcutAttempt,
  type ShortcutAttempt,
  type ShortcutRecord
} from './setup-shortcuts'
import {
  readRegistration,
  recoverRegistration,
  sameRegistration,
  registrationValue,
  validateRegistrationKey,
  withRegistrationValues,
  type Registration,
  type RegistrationChange
} from './setup-registry'

export interface SetupIntegration {
  version: 1
  request: SetupRequest
  registration?: Registration
  receipt: ReceiptIdentity
  runtimeOwner?: RuntimeOwnershipReference
}
export interface SetupIntegrationContext {
  root: string
  profile: string
  source: string
  transaction: string
  before: string | null
  next: CurrentVersionPointer
}
export type SetupIntegrationStage = 'desktop-linked' | 'menu-linked' | 'registered' | 'receipted'
export type SetupIntegrationProgress = (
  stage: SetupIntegrationStage,
  transaction: string
) => void | Promise<void>
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function validateSetupIntegration(
  input: SetupIntegration,
  ctx: SetupIntegrationContext
): void {
  const r = input?.request
  if (
    input?.version !== 1 ||
    !r ||
    !/^\d+$/.test(input.receipt?.dev ?? '') ||
    !/^\d+$/.test(input.receipt?.ino ?? '') ||
    !same(setupAbsolute(r.installRoot), ctx.root) ||
    !same(setupAbsolute(r.source), ctx.source) ||
    !same(setupAbsolute(r.workRoot), dirname(ctx.transaction)) ||
    r.appId !== ctx.next.appId ||
    r.manifestHash !== ctx.next.manifestSha256 ||
    !same(setupAbsolute(r.resultFile), setupResultFile(ctx.source))
  )
    throw Error('安装集成记录与受保护的版本事务不一致。')
  const shortcutFields = [r.desktopDirectory, r.menuDirectory, r.displayName]
  if (
    shortcutFields.some(Boolean) &&
    !shortcutFields.every((v) => typeof v === 'string' && v.length > 0)
  )
    throw Error('安装集成缺少完整快捷方式配置。')
  if (r.desktopDirectory) setupAbsolute(r.desktopDirectory)
  if (r.menuDirectory) setupAbsolute(r.menuDirectory)
  if (r.registryKey || r.uninstaller || input.registration) {
    if (
      !r.registryKey ||
      !r.uninstaller ||
      !r.displayName ||
      !r.desktopDirectory ||
      !r.menuDirectory ||
      !input.registration ||
      !Array.isArray(input.registration.values) ||
      !Array.isArray(input.registration.subkeys) ||
      !same(setupAbsolute(r.uninstaller), join(dirname(ctx.source), 'remove.exe'))
    )
      throw Error('安装集成的系统入口配置不完整。')
    validateRegistrationKey(r.registryKey)
    if (input.registration.values.length) {
      const before = ctx.before ? (JSON.parse(ctx.before) as CurrentVersionPointer) : undefined
      if (
        !before ||
        registrationValue(input.registration, 'InstallLocation')?.toLowerCase() !==
          ctx.root.toLowerCase() ||
        registrationValue(input.registration, 'ManifestHash') !== before.manifestSha256 ||
        (registrationValue(input.registration, 'ZhuMoAppId') !== undefined &&
          registrationValue(input.registration, 'ZhuMoAppId') !== r.appId)
      )
        throw Error('安装之前的系统登记不属于此安装。')
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw Error('安装集成记录过大。')
}
function attemptFor(
  input: SetupIntegration,
  ctx: SetupIntegrationContext,
  progress?: SetupIntegrationProgress
): ShortcutAttempt | undefined {
  const r = input.request
  if (!r.desktopDirectory || !r.menuDirectory || !r.displayName) return undefined
  const previous = ctx.before ? (JSON.parse(ctx.before) as CurrentVersionPointer) : undefined
  return {
    root: ctx.root,
    source: ctx.source,
    manifestHash: r.manifestHash,
    appId: r.appId,
    id: ctx.next.transactionId,
    previousId: previous?.transactionId,
    work: ctx.transaction,
    options: {
      desktopDirectory: r.desktopDirectory,
      menuDirectory: r.menuDirectory,
      displayName: r.displayName
    },
    onPublished: async (kind) =>
      progress?.(kind === 'desktop' ? 'desktop-linked' : 'menu-linked', ctx.transaction)
  }
}
function resultFor(ctx: SetupIntegrationContext, record?: ShortcutRecord | null): SetupResult {
  return {
    root: ctx.root,
    profile: ctx.profile,
    launcher: join(ctx.source, ctx.next.executable),
    transaction: ctx.transaction,
    desktopLink: record?.entries.find((e) => e.kind === 'desktop')?.path,
    menuLink: record?.entries.find((e) => e.kind === 'menu')?.path
  }
}
function registrationFor(
  input: SetupIntegration,
  ctx: SetupIntegrationContext,
  data: SetupResult
): RegistrationChange {
  const r = input.request
  const strings: Record<string, string> = {
    DisplayName: r.displayName!,
    DisplayVersion: ctx.next.appVersion,
    ManifestHash: r.manifestHash,
    ZhuMoAppId: r.appId,
    ZhuMoTransaction: ctx.next.transactionId,
    DesktopShortcut: data.desktopLink!,
    MenuShortcut: data.menuLink!,
    InstallLocation: ctx.root,
    DisplayIcon: data.launcher + ',0',
    UninstallString: '"' + r.uninstaller + '"',
    QuietUninstallString: '"' + r.uninstaller + '" /S',
    Publisher: 'ZhuMo'
  }
  return {
    key: r.registryKey!,
    before: input.registration!,
    after: withRegistrationValues(input.registration!, [
      ...Object.entries(strings).map(([name, value]) => ({ name, kind: 'String', value })),
      { name: 'NoModify', kind: 'DWord', value: '1' },
      { name: 'NoRepair', kind: 'DWord', value: '1' }
    ])
  }
}

/** Read-only verification used when an already completed plan is retried without a writer. */
export async function inspectSetupIntegration(
  input: SetupIntegration,
  ctx: SetupIntegrationContext
): Promise<SetupResult> {
  validateSetupIntegration(input, ctx)
  const attempt = attemptFor(input, ctx)
  const record = attempt
    ? await previousRecord(ctx.root, ctx.next.transactionId, ctx.next.appId)
    : undefined
  if (attempt && !record) throw Error('已提交安装缺少完整的入口记录。')
  for (const entry of record?.entries ?? []) {
    const folder =
      entry.kind === 'desktop' ? input.request.desktopDirectory : input.request.menuDirectory
    if (!folder || !same(dirname(entry.path), folder)) throw Error('已提交安装的入口位置不一致。')
    const { createHash } = await import('node:crypto')
    if (
      createHash('sha256')
        .update(await readSetupFile(entry.path, 1024 * 1024))
        .digest('hex') !== entry.sha256
    )
      throw Error('已提交安装的快捷方式已被修改，未覆盖它。')
    const release = await verifyInstalledRelease(
      entry.source,
      await readSetupFile(join(entry.source, 'program-files.v1.json'), 64 * 1024 * 1024),
      entry.sourceManifestHash
    )
    if (release.manifest.appId !== ctx.next.appId) throw Error('入口启动程序身份不一致。')
  }
  const data = resultFor(ctx, record)
  if (
    input.registration &&
    !sameRegistration(
      await readRegistration(input.request.registryKey!),
      registrationFor(input, ctx, data).after
    )
  )
    throw Error('已提交安装的系统登记已改变，未冒充同一次完成结果。')
  return data
}

/** Called by both the initial update and crash recovery while the same lifecycle is held.
 * The serialized input plus per-link intents are sufficient; no in-memory closure is needed. */
export async function finishSetupIntegration(
  input: SetupIntegration,
  ctx: SetupIntegrationContext,
  action: 'commit' | 'rollback',
  progress?: SetupIntegrationProgress
): Promise<SetupResult> {
  validateSetupIntegration(input, ctx)
  const attempt = attemptFor(input, ctx, progress)
  let record = attempt
    ? await previousRecord(ctx.root, ctx.next.transactionId, ctx.next.appId)
    : undefined
  if (action === 'commit') {
    if (attempt) record = await installShortcuts(attempt)
    const data = resultFor(ctx, record)
    if (input.registration) {
      await recoverRegistration(registrationFor(input, ctx, data), ctx.transaction, 'after')
      await progress?.('registered', ctx.transaction)
    }
    await resumeReceipt(input.request.resultFile, data, 'committed', input.receipt)
    await progress?.('receipted', ctx.transaction)
    return data
  }
  const data = resultFor(ctx, record)
  if (input.registration) {
    if (record)
      await recoverRegistration(registrationFor(input, ctx, data), ctx.transaction, 'before')
    else if (
      !sameRegistration(await readRegistration(input.request.registryKey!), input.registration)
    )
      throw Error('快捷方式记录生成之前系统登记已发生外部变化，未猜测恢复。')
  }
  if (attempt) await rollbackShortcutAttempt(attempt)
  // A missing or replaced receipt is inert and must not prevent restoration of the original installation.
  await resumeReceipt(input.request.resultFile, data, 'incomplete', input.receipt).catch(
    () => undefined
  )
  return data
}
