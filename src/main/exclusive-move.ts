import { spawn, spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
const moveScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $plan=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZHUMO_MOVE_PLAN)))
  function Extended([string]$path) { if($path.StartsWith('\\')) { return '\\?\UNC\'+$path.Substring(2) }; return '\\?\'+$path }
  [IO.File]::Move((Extended $plan.source),(Extended $plan.target))
  [Console]::Out.Write('moved')
} catch { [Console]::Error.Write($_.Exception.Message);exit 1 }
`
/** One atomic, non-replacing move before Electron ready. Only used for a first profile choice. */
export function moveFileExclusiveSync(source: string, target: string): void {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(source) ||
    !isAbsolute(target) ||
    dirname(source).toLowerCase() !== dirname(target).toLowerCase()
  )
    throw Error('独占文件发布需要 Windows 上的同一目录。')
  const result = spawnSync(
    join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(moveScript, 'utf16le').toString('base64')
    ],
    {
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        ZHUMO_MOVE_PLAN: Buffer.from(JSON.stringify({ source, target })).toString('base64')
      }
    }
  )
  if (result.error || result.status !== 0 || result.stdout !== 'moved')
    throw Error('独占文件发布未完成：' + (result.error?.message ?? result.stderr).slice(-1500))
}

/** Same-directory Windows publication without replacement. File.Move uses the native move
 * operation: no link/unlink gap and no overwrite of a destination created by another writer. */
export async function moveFileExclusive(source: string, target: string): Promise<void> {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(source) ||
    !isAbsolute(target) ||
    dirname(source).toLowerCase() !== dirname(target).toLowerCase()
  )
    throw Error('独占文件发布需要 Windows 上的同一目录。')
  await new Promise<void>((done, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(moveScript, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          ZHUMO_MOVE_PLAN: Buffer.from(JSON.stringify({ source, target })).toString('base64')
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
    child.once('close', (code) =>
      code === 0 && output === 'moved'
        ? done()
        : reject(Error('独占文件发布未完成：' + error.slice(-1500)))
    )
  })
}
