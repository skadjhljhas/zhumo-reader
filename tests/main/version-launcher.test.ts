import { describe, expect, it, vi, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import {
  launchCurrentVersion,
  parseVersionLauncherArgs,
  type VersionLauncherDependencies
} from '../../src/main/version-launcher'
import type { CurrentVersionPointer } from '../../src/main/current-version'

const releaseId = '75c98411-bf63-4af3-9e04-111111111111'
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const root = join(tmpdir(), 'zhumo-launcher-unit', '朱墨 安装')
const files = join(tmpdir(), 'zhumo-launcher-unit', '我的 书籍')

interface LauncherFixture {
  directory: string
  executable: string
  manifestBytes: Buffer
  pointer: CurrentVersionPointer
  child: EventEmitter & { pid: number; unref: () => void }
  spawn: Mock<VersionLauncherDependencies['spawn']>
  realpath: Mock<VersionLauncherDependencies['realpath']>
  resolveCurrentVersion: Mock<VersionLauncherDependencies['resolveCurrentVersion']>
  verifyStagedRelease: Mock<VersionLauncherDependencies['verifyStagedRelease']>
  dependencies: VersionLauncherDependencies
}
function fixture(): LauncherFixture {
  const directory = join(root, '.zhumo', 'versions', releaseId)
  const executable = join(directory, '朱墨 Reader.exe')
  const manifestBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      appId: 'com.zhumo.reader.ai-preview',
      appVersion: '2.0.0-preview.ai.28',
      platform: 'win32',
      executable: '朱墨 Reader.exe',
      files: [
        { path: '朱墨 Reader.exe', size: 3, sha256: hash('exe') },
        { path: 'resources/app.asar', size: 4, sha256: hash('asar') }
      ]
    })
  )
  const pointer: CurrentVersionPointer = {
    version: 1,
    releaseId,
    transactionId: '0a9fce4b-5259-4e94-a904-222222222222',
    manifestSha256: hash(manifestBytes),
    appId: 'com.zhumo.reader.ai-preview',
    appVersion: '2.0.0-preview.ai.28',
    executable: '朱墨 Reader.exe'
  }
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void }
  child.pid = 4242
  child.unref = vi.fn()
  const spawn = vi.fn<VersionLauncherDependencies['spawn']>(() => {
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  })
  const realpath = vi.fn<VersionLauncherDependencies['realpath']>(async (path: string) => path)
  const resolveCurrentVersion = vi.fn<VersionLauncherDependencies['resolveCurrentVersion']>(
    async () => ({ directory, pointer, manifestBytes })
  )
  const verifyStagedRelease = vi.fn<VersionLauncherDependencies['verifyStagedRelease']>(
    async () => undefined
  )
  const dependencies: VersionLauncherDependencies = {
    realpath,
    resolveCurrentVersion,
    verifyStagedRelease,
    spawn
  }
  return {
    directory,
    executable,
    manifestBytes,
    pointer,
    child,
    spawn,
    realpath,
    resolveCurrentVersion,
    verifyStagedRelease,
    dependencies
  }
}

describe('version launcher argument boundary', () => {
  it('consumes its role and separator while retaining individual Chinese paths with spaces', () => {
    const book = join(files, '天外之光 一.md')
    expect(
      parseVersionLauncherArgs(['launcher.exe', '--zhumo-launch-current', root, '--', book])
    ).toEqual({
      installRoot: root,
      fileArgs: [book]
    })
    expect(
      parseVersionLauncherArgs(['launcher.exe', '--zhumo-launch-current', root]).fileArgs
    ).toEqual([])
  })

  it('rejects missing roots, relative roots, repeated roles and role injection', () => {
    for (const argv of [
      ['launcher.exe'],
      ['launcher.exe', '--zhumo-launch-current'],
      ['launcher.exe', '--zhumo-launch-current', 'relative'],
      ['launcher.exe', '--zhumo-profile-guard', '--zhumo-launch-current', root],
      ['launcher.exe', '--zhumo-launch-current', root, '--', '--ZHUMO-profile-guard'],
      ['launcher.exe', '--zhumo-launch-current', root, '--', '--zhumo-launch-current', root],
      ['launcher.exe', '--zhumo-launch-current', root, join(files, 'book.md')]
    ])
      expect(() => parseVersionLauncherArgs(argv)).toThrow()
  })
})

describe('verified reader launch', () => {
  it('fully verifies the release before spawning and does not wait for reader exit', async () => {
    const f = fixture()
    let releaseVerification!: () => void
    let enteredVerification!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredVerification = resolve
    })
    f.verifyStagedRelease.mockImplementation(() => {
      enteredVerification()
      return new Promise<void>((resolve) => {
        releaseVerification = resolve
      })
    })
    const result = launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
    await entered
    expect(f.spawn).not.toHaveBeenCalled()
    releaseVerification()
    await expect(result).resolves.toEqual({
      executable: f.executable,
      installRoot: root,
      releaseId,
      pid: 4242
    })
    expect(f.verifyStagedRelease).toHaveBeenCalledWith(
      f.directory,
      f.manifestBytes,
      f.pointer.manifestSha256
    )
    expect(f.child.unref).toHaveBeenCalledOnce()
    expect(f.child.listenerCount('exit')).toBe(0)
  })

  it('passes book paths as an argv array without shell interpretation or role flags', async () => {
    const f = fixture()
    const relativeBook = '光与 文字 & 阅读.md'
    const absoluteBook = join(files, "读者的 O'Brien.markdown")
    const epub = join(files, '书页之间.EPUB')
    await launchCurrentVersion(
      {
        installRoot: root,
        fileArgs: [relativeBook, absoluteBook, epub],
        workingDirectory: files,
        environment: {}
      },
      f.dependencies
    )
    const [executable, args, options] = f.spawn.mock.calls[0]
    expect(executable).toBe(f.executable)
    expect(args).toEqual([resolve(files, relativeBook), absoluteBook, epub])
    expect(args.some((arg) => arg.startsWith('--'))).toBe(false)
    expect(options).toMatchObject({
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: f.directory
    })
    expect(options.windowsVerbatimArguments).toBeUndefined()
  })

  it('preserves profile and user configuration while removing Node/dev mode environment switches', async () => {
    const f = fixture()
    const environment = {
      ZHUMO_USER_DATA: join(files, 'isolated-profile'),
      ZHUMO_TEST_BACKGROUND: '1',
      HTTPS_PROXY: 'http://localhost:8888',
      CUSTOM_READER_SETTING: 'unchanged',
      ELECTRON_RUN_AS_NODE: '',
      electron_renderer_url: 'http://localhost:5173',
      zhumo_install_root: join(root, 'obsolete')
    }
    const original = { ...environment }
    await launchCurrentVersion({ installRoot: root, environment }, f.dependencies)
    const options = f.spawn.mock.calls[0][2]
    expect(options.windowsHide).toBe(true)
    expect(options.env).toEqual({
      ZHUMO_USER_DATA: environment.ZHUMO_USER_DATA,
      ZHUMO_TEST_BACKGROUND: '1',
      HTTPS_PROXY: environment.HTTPS_PROXY,
      CUSTOM_READER_SETTING: 'unchanged',
      ZHUMO_INSTALL_ROOT: root
    })
    expect(environment).toEqual(original)
  })

  it('binds the child to the real installation root returned by the filesystem', async () => {
    const f = fixture(),
      alias = join(tmpdir(), 'launcher-root-alias')
    f.realpath.mockImplementation(async (value) => (value === alias ? root : value))
    await launchCurrentVersion({ installRoot: alias, environment: {} }, f.dependencies)
    expect(f.resolveCurrentVersion).toHaveBeenCalledWith(root)
    expect(f.spawn.mock.calls[0][2].env?.ZHUMO_INSTALL_ROOT).toBe(root)
  })

  it('rejects background tests when neither the environment nor pointer supplies a usable profile', async () => {
    for (const profile of [undefined, '', 'relative-profile']) {
      const f = fixture()
      await expect(
        launchCurrentVersion(
          {
            installRoot: root,
            environment: { ZHUMO_TEST_BACKGROUND: '1', ZHUMO_USER_DATA: profile }
          },
          f.dependencies
        )
      ).rejects.toThrow(/独立|绝对/)
      expect(f.resolveCurrentVersion).toHaveBeenCalledOnce()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  })

  it('inherits the update-protected profile from the current pointer before checking background mode', async () => {
    const f = fixture(),
      protectedProfile = join(files, '更新保护的资料')
    f.pointer.profile = protectedProfile
    await launchCurrentVersion(
      { installRoot: root, environment: { ZHUMO_TEST_BACKGROUND: '1' } },
      f.dependencies
    )
    expect(f.realpath).toHaveBeenCalledWith(protectedProfile)
    expect(f.spawn.mock.calls[0][2]).toMatchObject({
      windowsHide: true,
      env: { ZHUMO_TEST_BACKGROUND: '1', ZHUMO_USER_DATA: protectedProfile }
    })
  })

  it('keeps an explicit profile instead of substituting the pointer profile', async () => {
    const f = fixture(),
      explicit = join(files, '另一个用户资料')
    f.pointer.profile = join(files, '更新保护的资料')
    await launchCurrentVersion(
      { installRoot: root, environment: { zhumo_user_data: explicit } },
      f.dependencies
    )
    expect(f.spawn.mock.calls[0][2].env?.zhumo_user_data).toBe(explicit)
    expect(f.spawn.mock.calls[0][2].env?.ZHUMO_USER_DATA).toBeUndefined()
    expect(f.realpath).not.toHaveBeenCalledWith(f.pointer.profile)
  })

  it('keeps the reader default for old pointers without a profile', async () => {
    const f = fixture()
    await launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
    expect(f.spawn.mock.calls[0][2].env?.ZHUMO_USER_DATA).toBeUndefined()
    expect(f.spawn.mock.calls[0][2].windowsHide).toBe(false)
  })

  it('confirms a new pointer profile through its existing parent without creating it', async () => {
    const f = fixture(),
      profile = join(files, '首次初始化的资料')
    f.pointer.profile = profile
    f.realpath.mockImplementation(async (path) => {
      if (path === profile) throw Object.assign(Error('not created'), { code: 'ENOENT' })
      return path
    })
    await launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
    expect(f.realpath).toHaveBeenCalledWith(dirname(profile))
    expect(f.spawn.mock.calls[0][2].env?.ZHUMO_USER_DATA).toBe(profile)
  })

  it('rejects unsafe or inaccessible pointer profiles without falling back to different settings', async () => {
    for (const profile of ['relative', '', parse(root).root, join(files, 'bad\0profile')]) {
      const f = fixture()
      f.pointer.profile = profile
      await expect(
        launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
    const f = fixture(),
      profile = join(files, '不可读取的资料')
    f.pointer.profile = profile
    f.realpath.mockImplementation(async (path) => {
      if (path === profile) throw Object.assign(Error('access denied'), { code: 'EACCES' })
      return path
    })
    await expect(
      launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
    ).rejects.toThrow('access denied')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('rejects every forwarded switch, URL, control character and non-book argument', async () => {
    for (const value of [
      '--zhumo-profile-guard',
      '--inspect',
      ' --zhumo-launch-current',
      '--',
      'https://example.test/book.md',
      'file:///book.md',
      'book.md\0',
      'book.md\n',
      'config.js',
      ''
    ]) {
      const f = fixture()
      await expect(
        launchCurrentVersion(
          { installRoot: root, fileArgs: [value], environment: {} },
          f.dependencies
        )
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  })

  it('does not spawn when pointer resolution or full release verification fails', async () => {
    for (const phase of ['pointer', 'verify']) {
      const f = fixture()
      if (phase === 'pointer') f.resolveCurrentVersion.mockRejectedValue(Error('pointer rejected'))
      else f.verifyStagedRelease.mockRejectedValue(Error('file digest changed'))
      await expect(
        launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  })

  it('does not spawn a pointer whose metadata contradicts its trusted manifest', async () => {
    for (const key of ['appId', 'appVersion', 'executable', 'manifestSha256'] as const) {
      const f = fixture()
      f.pointer[key] = 'mismatched'
      await expect(
        launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  })

  it('rejects release path escapes and an entry replaced by a link after verification', async () => {
    for (const moved of ['directory', 'executable']) {
      const f = fixture()
      f.realpath.mockImplementation(async (path) =>
        path === (moved === 'directory' ? f.directory : f.executable)
          ? join(tmpdir(), 'outside-installation', moved)
          : path
      )
      await expect(
        launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
      ).rejects.toThrow()
      expect(f.spawn).not.toHaveBeenCalled()
    }
  })

  it('reports synchronous and asynchronous spawn failure without killing any process', async () => {
    for (const asynchronous of [false, true]) {
      const f = fixture()
      f.spawn.mockImplementation(() => {
        if (!asynchronous) throw Error('EACCES')
        queueMicrotask(() => f.child.emit('error', Error('ENOENT')))
        return f.child as unknown as ChildProcess
      })
      await expect(
        launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
      ).rejects.toThrow('未能启动')
      expect(f.child.unref).not.toHaveBeenCalled()
    }
  })

  it('does not turn a late child process error into an unhandled launcher exception', async () => {
    const f = fixture()
    await launchCurrentVersion({ installRoot: root, environment: {} }, f.dependencies)
    expect(() => f.child.emit('error', Error('late error'))).not.toThrow()
  })
})
