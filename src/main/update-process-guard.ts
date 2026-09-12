import { spawn } from 'node:child_process'
import { physicalFs } from './physical-fs'
const { realpath } = physicalFs
import { relative, isAbsolute, sep, join } from 'node:path'

export interface RunningProgram {
  pid: number
  name: string
  executable: string | null
}
const WINDOWS_QUERY = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $taskProcesses = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; executable = $_.ExecutablePath } })
  ConvertTo-Json -InputObject $taskProcesses -Compress
} catch { [Console]::Error.WriteLine('Process inventory unavailable'); exit 1 }`
export async function windowsPrograms(): Promise<RunningProgram[]> {
  if (process.platform !== 'win32') throw Error('此更新进程检查当前只支持Windows。')
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_QUERY],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const chunks: Buffer[] = []
    let size = 0
    const timeout = setTimeout(() => child.kill(), 15000)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) return reject(Error('无法确认旧朱墨已经退出，停止更新。'))
      try {
        const list = JSON.parse(
          Buffer.concat(chunks)
            .toString('utf8')
            .replace(/^\uFEFF/, '')
        )
        if (
          !Array.isArray(list) ||
          list.some(
            (p) =>
              !Number.isInteger(p.pid) ||
              typeof p.name !== 'string' ||
              (p.executable !== null && typeof p.executable !== 'string')
          )
        )
          throw Error()
        resolve(list)
      } catch {
        reject(Error('进程清单无效，停止更新。'))
      }
    })
  })
}
/** Fail closed; never kill a reader to make an update proceed. The inventory is a preflight
 * check, not a lifetime lock. The installer still has to hold its update gate across replacement. */
export async function assertProgramsClosed(
  roots: string[],
  query: () => Promise<RunningProgram[]> = windowsPrograms
): Promise<void> {
  if (!roots.length || roots.some((root) => !isAbsolute(root))) throw Error('必须指定旧程序目录。')
  const canonical = await Promise.all(roots.map((root) => realpath(root)))
  for (const program of await query()) {
    if (!program.executable) {
      if (/^(zhumo.*|electron)\.exe$/i.test(program.name))
        throw Error('无法读取一个朱墨相关进程的位置，停止更新。')
      continue
    }
    const path = await realpath(program.executable).catch(() => program.executable!)
    if (
      canonical.some((root) => {
        const rel = relative(root.toLowerCase(), path.toLowerCase())
        return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
      })
    )
      throw Error('旧朱墨仍在运行，请正常保存并退出后再更新。')
  }
}
