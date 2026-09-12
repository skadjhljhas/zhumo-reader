import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { physicalFsSync } from './physical-fs'

const execute = promisify(execFile)
/** Resolve beside the executing code, including shared chunks and ASAR unpacking.
 * Never search the user's current manuscript directory for an executable. */
export function nativeFileHelper(): string | undefined {
  const physical = (path: string): string =>
    path.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2')
  const candidates = [
    join(__dirname, 'native', 'ConditionalDelete.exe'),
    join(dirname(__dirname), 'native', 'ConditionalDelete.exe'),
    resolve(__dirname, '../../out/main/native/ConditionalDelete.exe')
  ].map(physical)
  for (const path of candidates) {
    try {
      const stat = physicalFsSync.lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/** False means this code copy predates the native read-only operation. */
export async function inspectNativePathAttributes(paths: string[]): Promise<boolean> {
  const helper = nativeFileHelper()
  if (!helper) return false
  try {
    const { stdout } = await execute(helper, [], {
      windowsHide: true,
      shell: false,
      timeout: 15000,
      maxBuffer: 65536,
      encoding: 'utf8',
      env: {
        ...process.env,
        ZHUMO_FILE_DELETE_PLAN: Buffer.from(
          // Earlier helpers require path before they can report an unknown operation.
          JSON.stringify({ kind: 'zhumo-path-attributes-v1', path: paths[0] ?? '', paths })
        ).toString('base64')
      }
    })
    if (stdout !== 'ok') throw Error('原生路径检查没有返回完整确认。')
    return true
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number }
    if (
      failure.code === 'ENOENT' ||
      (Number(failure.code) === 4 && failure.stderr?.trim() === 'Unknown operation')
    )
      return false
    throw Error('无法确认当前版本路径不含重解析点，未切换版本。')
  }
}
