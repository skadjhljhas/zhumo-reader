import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { inspectSetupDirectory, readSetupFile } from './setup-paths'

export interface RegistryValue {
  name: string
  kind: string
  value: string | string[]
}
export interface Registration {
  exists: boolean
  values: RegistryValue[]
  subkeys: string[]
}
export interface RegistrationChange {
  key: string
  before: Registration
  after: Registration
}
export function validateRegistrationKey(key: string): void {
  if (
    typeof key !== 'string' ||
    !/^Software\\(?:Microsoft\\Windows\\CurrentVersion\\Uninstall|ZhuMoInstallerTests)\\[a-z0-9{}-]{8,80}$/i.test(
      key
    )
  )
    throw Error('系统登记必须位于本用户的独立朱墨卸载项。')
}

// The script is fixed code. Paths and registry values travel as JSON data, never interpolated
// PowerShell. Native values keep their types, including third-party additions on rollback.
const registryScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$p=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZHUMO_REGISTRY_PLAN)))
$view=if([Environment]::Is64BitOperatingSystem){[Microsoft.Win32.RegistryView]::Registry64}else{[Microsoft.Win32.RegistryView]::Registry32}
$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
function Snapshot {
  $k=$base.OpenSubKey($p.key,$false)
  if($null -eq $k){return [ordered]@{exists=$false;values=@();subkeys=@()}}
  try {
    $values=@(foreach($name in @($k.GetValueNames() | Sort-Object)) {
      $kind=$k.GetValueKind($name).ToString()
      $raw=$k.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $v=switch($kind){
        'Binary' {[Convert]::ToBase64String($raw)}
        'None' {[Convert]::ToBase64String($raw)}
        'MultiString' {,@($raw)}
        default {[string]$raw}
      }
      [pscustomobject][ordered]@{name=$name;kind=$kind;value=$v}
    })
    return [ordered]@{exists=$true;values=$values;subkeys=@($k.GetSubKeyNames() | Sort-Object)}
  } finally {$k.Dispose()}
}
function Canonical($s) {
  $values=@(foreach($v in @($s.values | Sort-Object name)) {
    [ordered]@{name=$v.name;kind=$v.kind;value=$v.value}
  })
  return (ConvertTo-Json -InputObject ([ordered]@{exists=[bool]$s.exists;values=$values;subkeys=@($s.subkeys | Sort-Object)}) -Depth 10 -Compress)
}
function Assign($v,$k) {
  $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],$v.kind)
  $raw=switch($v.kind){
    'Binary' {,[Convert]::FromBase64String($v.value)}
    'None' {,[Convert]::FromBase64String($v.value)}
    'DWord' {[int]::Parse($v.value,[Globalization.CultureInfo]::InvariantCulture)}
    'QWord' {[long]::Parse($v.value,[Globalization.CultureInfo]::InvariantCulture)}
    'MultiString' {,[string[]]$v.value}
    default {[string]$v.value}
  }
  $k.SetValue($v.name,$raw,$kind)
}
function Apply($target) {
  if(-not $target.exists) {
    $now=Snapshot
    if($now.subkeys.Count -gt 0){throw 'Registry subkeys appeared; retained'}
    $base.DeleteSubKey($p.key,$false)
    return
  }
  $k=$base.CreateSubKey($p.key,$true)
  try {
    foreach($v in $target.values){Assign $v $k}
    foreach($name in @($k.GetValueNames())){
      if(@($target.values | Where-Object {$_.name -ieq $name}).Count -eq 0){$k.DeleteValue($name,$false)}
    }
    $k.Flush()
  } finally {$k.Dispose()}
}
try {
  $before=Snapshot
  if($p.action -eq 'read'){[Console]::Write((Canonical $before));exit 0}
  if((Canonical $before) -cne (Canonical $p.before)){throw 'System registration changed; not overwritten'}
  if(($before.subkeys -join [char]0) -cne ($p.after.subkeys -join [char]0)){throw 'Registry child keys are not owned by this operation'}
  try {
    Apply $p.after
    if((Canonical (Snapshot)) -cne (Canonical $p.after)){throw 'System registration readback failed'}
  } catch {
    $cause=$_
    # Restore a partial write only when every surviving value is one of the two known versions.
    $now=Snapshot
    $safe=($now.subkeys -join [char]0) -ceq ($before.subkeys -join [char]0)
    foreach($v in $now.values){
      $known=@(@($before.values)+@($p.after.values) | Where-Object {
        $_.name -ieq $v.name -and $_.kind -eq $v.kind -and
        (ConvertTo-Json -InputObject $_.value -Compress) -ceq (ConvertTo-Json -InputObject $v.value -Compress)
      })
      if($known.Count -eq 0){$safe=$false}
    }
    if($safe){Apply $before}
    throw $cause
  }
  [Console]::Write((Canonical (Snapshot)))
} catch {[Console]::Error.Write($_.Exception.Message);exit 1} finally {$base.Dispose()}
`
async function registryCommand(plan: Record<string, unknown>): Promise<Registration> {
  validateRegistrationKey(plan.key as string)
  return new Promise((done, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(registryScript, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          ZHUMO_REGISTRY_PLAN: Buffer.from(JSON.stringify(plan)).toString('base64')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = '',
      error = ''
    child.stdout.on('data', (data) => {
      output += String(data)
    })
    child.stderr.on('data', (data) => {
      error += String(data)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(Error('系统登记未完成：' + error.slice(-2500)))
        return
      }
      try {
        done(JSON.parse(output.replace(/^\ufeff/, '')))
      } catch {
        reject(Error('系统登记回执无效。'))
      }
    })
  })
}
export const readRegistration = (key: string): Promise<Registration> =>
  registryCommand({ key, action: 'read' })
export function sameRegistration(a: Registration, b: Registration): boolean {
  const normalized = (state: Registration): string =>
    JSON.stringify({
      exists: state.exists,
      values: [...state.values]
        .sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()))
        .map((v) => [v.name, v.kind, v.value]),
      subkeys: [...state.subkeys].sort()
    })
  return normalized(a) === normalized(b)
}

/** Persist both native states before changing the registry. Must run inside the installer
 * lifecycle gate; compare-and-swap also rejects intervening user edits. */
export async function changeRegistration(change: RegistrationChange, work: string): Promise<void> {
  if ((await inspectSetupDirectory(work)).missing.length) throw Error('系统登记恢复目录不可用。')
  const bytes = Buffer.from(JSON.stringify(change, null, 2))
  const path = join(work, 'registration-' + randomUUID() + '.json')
  const output = await fs.open(path, 'wx', 0o600)
  try {
    await output.writeFile(bytes)
    await output.sync()
  } finally {
    await output.close()
  }
  if (!(await readSetupFile(path, 1024 * 1024)).equals(bytes))
    throw Error('系统登记恢复记录写入不完整。')
  await registryCommand({ action: 'replace', ...change })
}
export function registrationValue(state: Registration, name: string): string | undefined {
  const entry = state.values.find((v) => v.name.toLowerCase() === name.toLowerCase())
  return entry?.kind === 'String' && typeof entry.value === 'string' ? entry.value : undefined
}
/** A killed native process can leave some fields before and some after. Only that exact
 * combination is eligible; outside edits are retained and require explicit resolution. */
export async function recoverRegistration(
  change: RegistrationChange,
  work: string,
  side: 'before' | 'after'
): Promise<void> {
  const actual = await readRegistration(change.key),
    target = change[side]
  if (sameRegistration(actual, target)) return
  const valueKey = (v: RegistryValue): string => JSON.stringify([v.kind, v.value])
  const before = new Map(change.before.values.map((v) => [v.name.toLowerCase(), v]))
  const after = new Map(change.after.values.map((v) => [v.name.toLowerCase(), v]))
  const now = new Map(actual.values.map((v) => [v.name.toLowerCase(), v]))
  if (JSON.stringify([...actual.subkeys].sort()) !== JSON.stringify([...target.subkeys].sort()))
    throw Error('系统登记的子项已改变，未覆盖恢复。')
  for (const [name, value] of now) {
    const a = before.get(name),
      b = after.get(name)
    if ((!a || valueKey(a) !== valueKey(value)) && (!b || valueKey(b) !== valueKey(value)))
      throw Error('系统登记存在本次操作以外的修改，未覆盖恢复。')
  }
  for (const name of before.keys())
    if (after.has(name) && !now.has(name)) throw Error('系统登记的既有字段被外部删除，未覆盖恢复。')
  await changeRegistration({ key: change.key, before: actual, after: target }, work)
}
export function withRegistrationValues(state: Registration, values: RegistryValue[]): Registration {
  const names = new Set(values.map((v) => v.name.toLowerCase()))
  return {
    exists: true,
    values: [...state.values.filter((v) => !names.has(v.name.toLowerCase())), ...values],
    subkeys: [...state.subkeys]
  }
}
