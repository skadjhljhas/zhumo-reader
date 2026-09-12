import { physicalFs as fs } from './physical-fs'
import { registrationValue, type Registration } from './setup-registry'
import { setupAbsolute, setupContains } from './setup-paths'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// electron-builder NSIS UUID v5 for the original com.zhumo.reader product.
export const LEGACY_REGISTRY_KEY =
  'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\fa225784-1b1d-5dcc-b8b8-c3dae1894bff'
/** Read both original installation modes and views. This never opens a writable key. */
export async function readLegacyInstallations(): Promise<Registration[]> {
  if (process.platform !== 'win32') return []
  const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$items=@(foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try {
      $key=$base.OpenSubKey($env:ZHUMO_LEGACY_REGISTRY_KEY,$false)
      if($null -eq $key){continue}
      try {
        $values=@(foreach($name in @('InstallLocation','UninstallString')) {
          $value=$key.GetValue($name,$null)
          if($null -ne $value){[ordered]@{name=$name;kind='String';value=[string]$value}}
        })
        [ordered]@{exists=$true;values=$values;subkeys=@()}
      } finally {$key.Dispose()}
    } finally {$base.Dispose()}
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Depth 6 -Compress))
`
  const result = await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, ZHUMO_LEGACY_REGISTRY_KEY: LEGACY_REGISTRY_KEY }
    }
  )
  const records = JSON.parse(result.stdout)
  if (!Array.isArray(records)) throw Error('原版安装位置记录无法读取。')
  return records
}
export async function assertOutsideLegacyInstall(
  target: string,
  read: () => Promise<Registration | Registration[]> = readLegacyInstallations
): Promise<void> {
  if (process.platform !== 'win32') return
  const records = await read()
  for (const previous of Array.isArray(records) ? records : [records]) {
    if (!previous.exists) continue
    const uninstall = registrationValue(previous, 'UninstallString')
    // Original 1.1.x NSIS did not always write InstallLocation. Read its quoted command
    // as data only; never execute the original recursive uninstaller during adoption.
    const executable = uninstall?.match(/^"([^"\r\n]+\.exe)"(?:\s+.*)?$/i)?.[1]
    const location =
      registrationValue(previous, 'InstallLocation') ||
      (executable ? dirname(executable) : undefined)
    if (!location) throw Error('原版朱墨的安装位置记录不完整，请先核对原安装位置。')
    const root = setupAbsolute(location)
    let actual = root
    try {
      actual = await fs.realpath(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if ([root, actual].some((path) => setupContains(path, target) || setupContains(target, path)))
      throw Error(
        '原版朱墨的卸载器会处理它的整个安装目录。请为朱墨 2.0 选择独立目录；原阅读资料可以继续沿用。'
      )
  }
}
