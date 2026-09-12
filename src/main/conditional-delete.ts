import { spawn } from 'node:child_process'
import { join, isAbsolute, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { readSetupFile } from './setup-paths'
import { physicalFs as fs } from './physical-fs'
export interface OwnedFileIdentity {
  dev: string
  ino: string
}
export interface OwnedDirectoryIdentity extends OwnedFileIdentity {
  path: string
}
function nativeFileOperation(): string {
  return process.versions.electron
    ? join(
        dirname(process.execPath),
        'resources/app.asar.unpacked/out/main/native/ConditionalDelete.exe'
      )
    : join(process.cwd(), 'out/main/native/ConditionalDelete.exe')
}
export async function assertOwnedDeletionSupported(directory: string): Promise<void> {
  if (!(await checkDirectory(directory, 'zhumo-owned-delete-capability-v1')))
    throw Error('快捷方式目标目录不存在。')
}
/** Complete native ancestor inspection, without PowerShell startup for each member. */
export async function inspectDeletionDirectory(directory: string): Promise<boolean> {
  return checkDirectory(directory, 'zhumo-directory-chain-v1')
}
async function checkDirectory(directory: string, kind: string): Promise<boolean> {
  if (process.platform !== 'win32' || !isAbsolute(directory))
    throw Error('快捷方式需要可核对的 Windows 目录。')
  return new Promise<boolean>((done, reject) => {
    const child = spawn(nativeFileOperation(), [], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ZHUMO_FILE_DELETE_PLAN: Buffer.from(JSON.stringify({ kind, path: directory })).toString(
          'base64'
        )
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let error = ''
    child.stderr.on('data', (part) => {
      error += String(part)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) done(true)
      else if (code === 2) done(false)
      else reject(Error('目录包含链接、重解析或不支持所需文件操作：' + error.slice(-1500)))
    })
  })
}

/** The native helper holds one exclusive handle through identity/hash checking and deletion.
 * A replacement at the public path is never deleted merely because an earlier stat matched. */
export async function deleteOwnedFile(
  path: string,
  identity: OwnedFileIdentity,
  sha256: string,
  directories: readonly OwnedDirectoryIdentity[] = []
): Promise<'deleted' | 'missing' | 'changed'> {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(path) ||
    !/^\d+$/.test(identity.dev) ||
    !/^\d+$/.test(identity.ino) ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw Error('受核对文件移除参数无效。')
  const bundled = nativeFileOperation()
  return new Promise((done, reject) => {
    const child = spawn(bundled, [], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ZHUMO_FILE_DELETE_PLAN: Buffer.from(
          JSON.stringify({ kind: 'zhumo-owned-file-v1', path, ...identity, sha256, directories })
        ).toString('base64')
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let error = ''
    child.stderr.on('data', (part) => {
      error += String(part)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) done('deleted')
      else if (code === 2) done('missing')
      else if (code === 3) done('changed')
      else reject(Error('无法移除受核对的文件，已保留：' + error.slice(-1500)))
    })
  })
}
export async function deleteOwnedTemporary(
  path: string,
  identity: OwnedFileIdentity
): Promise<void> {
  const info = await fs.lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info || info.dev.toString() !== identity.dev || info.ino.toString() !== identity.ino) return
  const hash = createHash('sha256')
    .update(await readSetupFile(path, 1024 * 1024))
    .digest('hex')
  await deleteOwnedFile(path, identity, hash)
}
