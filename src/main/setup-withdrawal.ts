import { dirname, join } from 'node:path'
import type { SetupRequest } from './setup-action'
import type { VersionUpdateRuntime } from './version-update'
import { readCurrentVersion } from './current-version'
import { setupAbsolute, setupContains, inspectSetupDirectory, readSetupFile } from './setup-paths'
import { verifyInstalledRelease } from './installed-release'
import { readRegistration, registrationValue, type RegistrationChange } from './setup-registry'
import { previousRecord } from './setup-shortcuts'
import { removeSetupPrograms, type RemovalOptions } from './setup-removal'

/** Remove recorded program files and native integration under one recoverable lifecycle. */
export async function withdrawSetup(
  request: SetupRequest,
  signal?: AbortSignal,
  runtime?: VersionUpdateRuntime,
  options?: Omit<RemovalOptions, 'signal'>
): Promise<{ transaction: string; removedFiles: number }> {
  const root = setupAbsolute(request.installRoot),
    source = setupAbsolute(request.source),
    coordinator = setupAbsolute(request.coordinator),
    work = setupAbsolute(request.workRoot)
  if (
    !request.registryKey ||
    !request.uninstaller ||
    setupAbsolute(request.uninstaller).toLowerCase() !==
      join(dirname(source), 'remove.exe').toLowerCase()
  )
    throw Error('卸载入口与本次安装计划不一致。')
  for (const path of [root, source, coordinator, work])
    if ((await inspectSetupDirectory(path)).missing.length)
      throw Error('卸载所需的安装记录不可用。')
  if (
    setupContains(root, source) ||
    setupContains(root, work) ||
    setupContains(source, root) ||
    setupContains(work, root)
  )
    throw Error('卸载运行目录与恢复目录必须位于程序之外。')
  const current = await readCurrentVersion(root)
  if (
    !current?.pointer.profile ||
    current.pointer.appId !== request.appId ||
    current.pointer.manifestSha256 !== request.manifestHash
  )
    throw Error('此卸载入口不属于当前安装。')
  const profile = setupAbsolute(current.pointer.profile)
  if ((await inspectSetupDirectory(profile)).missing.length)
    throw Error('原有设置目录不可用，未卸载。')
  const release = await verifyInstalledRelease(
    source,
    await readSetupFile(join(source, 'program-files.v1.json'), 64 * 1024 * 1024),
    request.manifestHash
  )
  if (release.manifest.appId !== request.appId) throw Error('卸载帮助程序身份不一致。')
  const before = await readRegistration(request.registryKey)
  if (
    registrationValue(before, 'UninstallString') !== '"' + request.uninstaller + '"' ||
    registrationValue(before, 'ZhuMoTransaction') !== current.pointer.transactionId ||
    registrationValue(before, 'InstallLocation')?.toLowerCase() !== root.toLowerCase() ||
    registrationValue(before, 'ZhuMoAppId') !== request.appId
  )
    throw Error('此卸载入口已被后续安装替代。')
  const record = await previousRecord(root, current.pointer.transactionId, request.appId)
  if (!record) throw Error('本次安装的快捷方式归属记录不可用。')
  const owned = new Set(
    [
      'DisplayName',
      'DisplayVersion',
      'ManifestHash',
      'ZhuMoAppId',
      'ZhuMoTransaction',
      'DesktopShortcut',
      'MenuShortcut',
      'InstallLocation',
      'DisplayIcon',
      'UninstallString',
      'QuietUninstallString',
      'Publisher',
      'NoModify',
      'NoRepair'
    ].map((name) => name.toLowerCase())
  )
  const retained = before.values.filter((v) => !owned.has(v.name.toLowerCase()))
  const change: RegistrationChange = {
    key: request.registryKey,
    before,
    after: {
      exists: retained.length > 0 || before.subkeys.length > 0,
      values: retained,
      subkeys: before.subkeys
    }
  }
  return removeSetupPrograms(
    {
      root,
      profile,
      source,
      coordinator,
      work,
      sourceManifestHash: request.manifestHash,
      executable: release.manifest.executable,
      appId: request.appId,
      appName: request.appName,
      pointer: current.bytes,
      registration: change,
      shortcuts: record
    },
    { ...options, signal },
    runtime
  )
}
