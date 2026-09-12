import type { App } from 'electron'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'
import { READABLE_BOOK_EXTENSIONS } from './args'
import type { CurrentVersionPointer } from './current-version'
import { physicalFs, physicalFsSync } from './physical-fs'
import { readProgramManifest } from './program-files'

const role = '--zhumo-launch-current'
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const within = (parent: string, child: string): boolean => {
  const part = relative(parent, child)
  return Boolean(part) && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
const environmentValue = (environment: NodeJS.ProcessEnv, key: string): string | undefined =>
  Object.entries(environment).find(([name]) => name.toUpperCase() === key)?.[1]

export interface VersionLaunchRequest {
  installRoot: string
  fileArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  /** Relative book paths belong to the launcher's original working directory. */
  workingDirectory?: string
}
export interface VersionLauncherDependencies {
  realpath(path: string): Promise<string>
  resolveCurrentVersion(root: string): Promise<{
    directory: string
    pointer: CurrentVersionPointer
    manifestBytes: Buffer
  }>
  /** Compatibility name for injection; production checks installed program files and permits user additions. */
  verifyStagedRelease(directory: string, manifestBytes: Buffer, hash: string): Promise<unknown>
  spawn(executable: string, args: string[], options: SpawnOptions): ChildProcess
}
export interface VersionLaunchResult {
  executable: string
  installRoot: string
  releaseId: string
  pid: number | undefined
}

function absoluteRoot(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
    throw Error('版本启动器需要明确的绝对安装目录。')
  const root = resolve(value)
  if (samePath(root, parse(root).root)) throw Error('不能把盘根作为朱墨安装目录。')
  return root
}

function profilePath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value))
    throw Error('朱墨资料目录必须是有效的绝对路径。')
  const profile = resolve(value)
  if (samePath(profile, parse(profile).root)) throw Error('不能把盘根作为朱墨资料目录。')
  return profile
}

async function pointerProfile(
  value: string,
  dependencies: VersionLauncherDependencies
): Promise<string> {
  const profile = profilePath(value)
  try {
    return profilePath(await dependencies.realpath(profile))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A first-launch profile need not exist yet. Only inspect its existing parent;
    // actual profile creation remains the normal reader's responsibility.
    return profilePath(join(await dependencies.realpath(dirname(profile)), basename(profile)))
  }
}

/** Only the launcher role is consumed here. No caller-supplied switch reaches the reader. */
export function parseVersionLauncherArgs(argv: readonly string[]): VersionLaunchRequest {
  const at = argv.indexOf(role)
  if (
    at < 1 ||
    argv.filter((arg) => arg === role).length !== 1 ||
    argv.some((arg, index) => index !== at && /^--zhumo-/i.test(arg.trimStart()))
  )
    throw Error('版本启动器参数包含缺失、重复或不允许的角色开关。')
  const installRoot = absoluteRoot(argv[at + 1])
  const tail = argv.slice(at + 2)
  if (tail.length && tail[0] !== '--') throw Error('书籍路径应放在版本启动参数的 -- 之后。')
  const fileArgs = tail.length ? tail.slice(1) : []
  return { installRoot, fileArgs }
}

function bookArguments(values: readonly string[], workingDirectory: string): string[] {
  if (values.length > 64) throw Error('一次打开的书籍路径过多。')
  return values.map((value) => {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      /[\0\r\n]/.test(value) ||
      value.trimStart().startsWith('-') ||
      (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) ||
      !READABLE_BOOK_EXTENSIONS.includes(extname(value).toLowerCase())
    )
      throw Error('版本启动器只转发具体的 Markdown、EPUB 或文本文件路径，不接受开关或网址。')
    return resolve(workingDirectory, value)
  })
}

/** All disk validation completes before spawn. The dependency boundary permits tests to
 * prove ordering and process lifetime without starting Electron or reading a user profile. */
export async function launchCurrentVersion(
  request: VersionLaunchRequest,
  dependencies: VersionLauncherDependencies
): Promise<VersionLaunchResult> {
  const root = absoluteRoot(request.installRoot)
  const args = bookArguments(request.fileArgs ?? [], request.workingDirectory ?? process.cwd())
  const environment = { ...(request.environment ?? process.env) }
  const background = environmentValue(environment, 'ZHUMO_TEST_BACKGROUND') === '1'
  const installRoot = absoluteRoot(await dependencies.realpath(root))
  const current = await dependencies.resolveCurrentVersion(installRoot)
  const { pointer, manifestBytes } = current
  if (
    pointer.version !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      pointer.releaseId
    )
  )
    throw Error('当前版本指针不合法，未启动程序。')
  const explicitProfile = environmentValue(environment, 'ZHUMO_USER_DATA')
  if (explicitProfile) profilePath(explicitProfile)
  else if (pointer.profile !== undefined) {
    const inheritedProfile = await pointerProfile(pointer.profile, dependencies)
    for (const key of Object.keys(environment))
      if (key.toUpperCase() === 'ZHUMO_USER_DATA') delete environment[key]
    environment.ZHUMO_USER_DATA = inheritedProfile
  }
  if (background && !environmentValue(environment, 'ZHUMO_USER_DATA'))
    throw Error('后台版本启动测试必须提供独立的绝对 ZHUMO_USER_DATA 目录。')
  const directory = await dependencies.realpath(current.directory)
  const expectedDirectory = join(installRoot, '.zhumo', 'versions', pointer.releaseId)
  if (!samePath(directory, expectedDirectory) || !within(installRoot, directory))
    throw Error('当前版本不在安装目录的受管版本路径中，未启动程序。')
  const manifest = readProgramManifest(manifestBytes, pointer.manifestSha256)
  if (
    manifest.appId !== pointer.appId ||
    manifest.appVersion !== pointer.appVersion ||
    manifest.executable !== pointer.executable ||
    extname(manifest.executable).toLowerCase() !== '.exe'
  )
    throw Error('当前版本指针与程序身份不一致，未启动程序。')
  await dependencies.verifyStagedRelease(directory, manifestBytes, pointer.manifestSha256)
  const expectedExecutable = join(directory, manifest.executable)
  const executable = await dependencies.realpath(expectedExecutable)
  if (!samePath(executable, expectedExecutable) || !within(directory, executable))
    throw Error('已验证版本的入口发生变化，未启动程序。')
  for (const key of Object.keys(environment))
    if (
      ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ZHUMO_INSTALL_ROOT'].includes(
        key.toUpperCase()
      )
    )
      delete environment[key]
  environment.ZHUMO_INSTALL_ROOT = installRoot

  let child: ChildProcess
  try {
    child = dependencies.spawn(executable, args, {
      cwd: directory,
      env: environment,
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: background
    })
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      // Keep a handler after spawn, too: a late process error must not crash the launcher.
      child.on('error', rejectSpawn)
      child.once('spawn', () => {
        try {
          child.unref()
          resolveSpawn()
        } catch (error) {
          rejectSpawn(error)
        }
      })
    })
  } catch (error) {
    throw new Error(
      '已验证的朱墨版本未能启动：' +
        (error instanceof Error ? error.message : '系统未能创建进程。'),
      { cause: error }
    )
  }
  return { executable, installRoot, releaseId: pointer.releaseId, pid: child.pid }
}

/** Main dispatch calls this before any normal reader startup. Bind Chromium to scratch
 * synchronously, before the first await can allow Electron's ready lifecycle to run. */
export async function runVersionLauncher(): Promise<void> {
  const { app } = createRequire(process.execPath)('electron') as { app: App }
  const scratch = physicalFsSync.mkdtempSync(join(tmpdir(), 'zhumo-version-launcher-'))
  app.setPath('userData', scratch)
  app.setPath('sessionData', scratch)
  app.disableHardwareAcceleration()
  const request = parseVersionLauncherArgs(process.argv)
  const [{ resolveCurrentVersion }, { verifyInstalledRelease }] = await Promise.all([
    import('./current-version'),
    import('./installed-release')
  ])
  await launchCurrentVersion(request, {
    realpath: physicalFs.realpath,
    resolveCurrentVersion,
    verifyStagedRelease: verifyInstalledRelease,
    spawn
  })
  app.exit(0)
}
