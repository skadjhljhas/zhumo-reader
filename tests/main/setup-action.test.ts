import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  lstat,
  symlink,
  rename,
  copyFile
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import {
  installFromSetup,
  parseSetupIni,
  prepareSetup,
  setupDefaultProfile,
  type SetupRequest
} from '../../src/main/setup-action'
import { readCurrentVersion } from '../../src/main/current-version'
import { productIdentity } from '../../src/main/product-identity'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
import type { VersionUpdateRuntime } from '../../src/main/version-update'
import { randomUUID } from 'node:crypto'
import { readRegistration, changeRegistration } from '../../src/main/setup-registry'

const roots: string[] = []
const registryFixtures: { key: string; work: string }[] = []
// These exercise Windows ancestor/reparse checks and real copy/pointer transactions.
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 })
const status = {
  ok: true,
  held: true,
  windows: 0,
  scratchBound: true,
  blocked: 0,
  parentChannelClosed: false
} as const
async function fixture(
  existing = false
): Promise<{ root: string; request: SetupRequest; runtime: VersionUpdateRuntime }> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-setup-action-'))
  roots.push(root)
  const source = join(root, 'runtime', 'payload')
  await mkdir(join(source, 'resources'), { recursive: true })
  await writeFile(join(source, 'ZhuMo.exe'), 'new executable fixture')
  await writeFile(join(source, 'resources/app.asar'), Buffer.from([0, 0, 8, 255, 1]))
  const manifest = await createProgramManifest(
    source,
    { appId: 'fixture.zhumo', appVersion: '2.0.32', executable: 'ZhuMo.exe' },
    ['ZhuMo.exe', 'resources/app.asar']
  )
  const bytes = JSON.stringify(manifest)
  await writeFile(join(source, 'program-files.v1.json'), bytes)
  const request: SetupRequest = {
    source,
    installRoot: join(root, '资料', '朱墨'),
    defaultProfile: join(root, '资料', '设置'),
    workRoot: join(root, 'recovery'),
    coordinator: join(root, 'coord'),
    manifestHash: programManifestHash(bytes),
    appId: 'fixture.zhumo',
    appName: 'fixture-reader',
    resultFile: join(root, 'runtime', 'installed.ini')
  }
  if (existing) {
    await mkdir(request.installRoot, { recursive: true })
    await mkdir(request.defaultProfile)
    await writeFile(join(request.installRoot, '文稿.md'), '\ufeff# 原稿\r\n不能改变。\r\n')
    await writeFile(join(request.installRoot, 'old.exe'), 'old program')
    await writeFile(join(request.defaultProfile, 'settings.json'), '{"fontSize":27}')
  }
  const runtime: VersionUpdateRuntime = {
    assertClosed: async () => {},
    reconnectGuard: async () => {
      throw Error('Unexpected recovery')
    },
    startGuard: async (options) => ({
      pid: process.pid,
      directory: options.workParent,
      signal: new AbortController().signal,
      assertHeld: async () => status,
      release: async () => {
        expect(
          inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
            .writers
        ).toEqual([])
      }
    })
  }
  return { root, request, runtime }
}
it('keeps committed shortcut entries if only the final guard release fails', async () => {
  const { root, request, runtime } = await fixture(true)
  request.desktopDirectory = join(root, 'desktop')
  request.menuDirectory = join(root, 'menu')
  request.displayName = '朱墨事务测试'
  const start = runtime.startGuard
  runtime.startGuard = async (options) => {
    const guard = await start(options)
    return {
      ...guard,
      release: async () => {
        await guard.release()
        throw Error('fixture release failure')
      }
    }
  }
  await expect(installFromSetup(request, undefined, runtime)).rejects.toThrow(
    'fixture release failure'
  )
  const current = await readCurrentVersion(request.installRoot)
  expect(current?.pointer.manifestSha256).toBe(request.manifestHash)
  expect((await lstat(join(root, 'desktop/朱墨事务测试.lnk'))).isFile()).toBe(true)
  expect((await lstat(join(root, 'menu/朱墨事务测试.lnk'))).isFile()).toBe(true)
  expect(await readFile(join(request.installRoot, '文稿.md'), 'utf8')).toBe(
    '\ufeff# 原稿\r\n不能改变。\r\n'
  )
})

afterEach(async () => {
  for (const { key, work } of registryFixtures.splice(0)) {
    expect(key).toMatch(/^Software\\ZhuMoInstallerTests\\[a-f0-9-]{36}$/)
    await changeRegistration(
      {
        key,
        before: await readRegistration(key),
        after: { exists: false, values: [], subkeys: [] }
      },
      work
    )
  }
  for (const root of roots.splice(0)) {
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-setup-action-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  }
})
const ini = (request: SetupRequest): Buffer =>
  Buffer.from(
    '\ufeff[Setup]\r\n' +
      Object.entries(request)
        .map(([k, v]) => k + '=' + v)
        .join('\r\n') +
      '\r\n',
    'utf16le'
  )
it('binds a first stable installation to the chosen complete profile and keeps that binding on reinstall', async () => {
  const { root, request, runtime } = await fixture()
  const product = productIdentity({ zhumoChannel: 'stable' })
  request.appId = product.appId
  request.defaultProfile = join(root, 'appData', product.profileFolder)
  const ai = join(root, 'appData/ZhuMo-AI-preview'),
    old = join(root, 'appData/zhumo')
  for (const path of [ai, old]) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'settings.json'), JSON.stringify({ profile: path, fontSize: 27 }))
  }
  await writeFile(join(ai, 'Local State'), 'profile crypto context fixture')
  await writeFile(join(ai, 'ai-models.v1.json'), 'encrypted fixture bytes')
  const manifest = await createProgramManifest(
    request.source,
    { appId: product.appId, appVersion: '2.0.0-rc.1', executable: 'ZhuMo.exe' },
    ['ZhuMo.exe', 'resources/app.asar']
  )
  const bytes = JSON.stringify(manifest)
  await writeFile(join(request.source, 'program-files.v1.json'), bytes)
  request.manifestHash = programManifestHash(bytes)
  const result = await installFromSetup(request, undefined, runtime, {
    selectProfile: (options) => options.findIndex((option) => option.path === ai)
  })
  expect(result.profile).toBe(ai)
  expect(setupDefaultProfile(request)).toBe(ai)
  expect((await readCurrentVersion(request.installRoot))?.pointer.profile).toBe(ai)
  expect(await readFile(join(ai, 'Local State'), 'utf8')).toBe('profile crypto context fixture')
  expect(await readFile(join(ai, 'ai-models.v1.json'), 'utf8')).toBe('encrypted fixture bytes')
  expect(JSON.parse(await readFile(join(old, 'settings.json'), 'utf8')).profile).toBe(old)
  // Existing installation binding wins even if the caller supplies a different default.
  const nextSource = join(root, 'second-runtime/payload')
  await mkdir(join(nextSource, 'resources'), { recursive: true })
  for (const file of ['ZhuMo.exe', 'resources/app.asar', 'program-files.v1.json'])
    await copyFile(join(request.source, file), join(nextSource, file))
  const prepared = await prepareSetup({
    ...request,
    source: nextSource,
    resultFile: join(root, 'second-runtime/installed.ini'),
    defaultProfile: old
  })
  expect(prepared.profileOrigin).toBe('existing')
  expect(prepared.directories[1].path).toBe(ai)
}, 120000)
describe('installer plan and preflight', () => {
  it('roundtrips long Unicode paths without shell parsing or a single long command', async () => {
    const { request } = await fixture()
    const input = {
      ...request,
      installRoot: request.installRoot + " & = '阅读' " + '书架'.repeat(150)
    }
    const bytes = ini(input)
    expect(bytes.length).toBeGreaterThan(1024)
    expect(parseSetupIni(bytes)).toEqual(input)
    expect(() => parseSetupIni(Buffer.concat([bytes, Buffer.from([0])]))).toThrow()
    expect(() => parseSetupIni(Buffer.from('[Setup]', 'utf8'))).toThrow()
    expect(() =>
      parseSetupIni(Buffer.from(bytes.toString('utf16le') + '\r\nsource=duplicate', 'utf16le'))
    ).toThrow('重复')
    expect(() =>
      parseSetupIni(Buffer.from(bytes.toString('utf16le') + '\r\n__proto__=bad', 'utf16le'))
    ).toThrow('无效')
  })
  it('inspects missing shared parents without creating any target or profile', async () => {
    const { request } = await fixture()
    const prepared = await prepareSetup(request)
    expect(prepared.directories.map((p) => p.path)).toContain(request.defaultProfile)
    for (const path of [
      request.installRoot,
      request.defaultProfile,
      request.workRoot,
      request.coordinator,
      request.resultFile
    ])
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a wrong/occupied receipt, overlapping roots and damaged payload before creating directories', async () => {
    const { request, root } = await fixture()
    await expect(prepareSetup({ ...request, resultFile: join(root, 'wrong.ini') })).rejects.toThrow(
      'installed.ini'
    )
    await expect(
      prepareSetup({ ...request, workRoot: join(request.defaultProfile, 'updates') })
    ).rejects.toThrow('独立')
    await writeFile(request.resultFile, 'user file')
    await expect(prepareSetup(request)).rejects.toThrow('已存在')
    expect(await readFile(request.resultFile, 'utf8')).toBe('user file')
    await expect(lstat(request.installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a bad source hash and an already-cancelled install before preparing output', async () => {
    const { request, runtime } = await fixture()
    await writeFile(join(request.source, 'resources/app.asar'), 'changed')
    await expect(prepareSetup(request)).rejects.toThrow()
    await expect(installFromSetup(request, AbortSignal.abort(), runtime)).rejects.toThrow()
    await expect(lstat(request.resultFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(request.installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a linked ancestor before creating anything through it', async () => {
    const { request, root } = await fixture()
    const real = join(root, 'real'),
      linked = join(root, 'linked')
    await mkdir(real)
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareSetup({ ...request, installRoot: join(linked, 'new') })).rejects.toThrow(
      '链接'
    )
    await expect(lstat(join(real, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
describe('installer entry uses the real version transaction', () => {
  it('creates a first install under shared missing parents and publishes a readable committed receipt', async () => {
    const { request, runtime } = await fixture()
    const result = await installFromSetup(request, undefined, runtime)
    const current = await readCurrentVersion(request.installRoot)
    expect(current?.pointer.profile).toBe(request.defaultProfile)
    const receipt = (await readFile(request.resultFile)).toString('utf16le')
    expect(receipt).toContain('Status=committed\r\n')
    expect(receipt).toContain('Root=' + request.installRoot)
    expect(receipt).toContain('Transaction=' + result.transaction)
    expect(JSON.parse(await readFile(join(result.transaction, 'journal.json'), 'utf8')).phase).toBe(
      'committed'
    )
  })
  it('keeps original Markdown, old program and settings byte-for-byte when installing over an existing directory', async () => {
    const { request, runtime } = await fixture(true)
    const paths = [
      join(request.installRoot, '文稿.md'),
      join(request.installRoot, 'old.exe'),
      join(request.defaultProfile, 'settings.json')
    ]
    const before = await Promise.all(paths.map((p) => readFile(p)))
    await installFromSetup(request, undefined, runtime)
    expect(await Promise.all(paths.map((p) => readFile(p)))).toEqual(before)
  })
  it('rolls back the new pointer if its result path is replaced before the guarded commit', async () => {
    const { request, runtime, root } = await fixture(true)
    request.registryKey = 'Software\\ZhuMoInstallerTests\\' + randomUUID()
    request.uninstaller = join(root, 'runtime/remove.exe')
    await writeFile(request.uninstaller, 'uninstaller fixture, not executed')
    request.desktopDirectory = join(root, 'desktop')
    request.menuDirectory = join(root, 'menu')
    request.displayName = '朱墨登记回滚验证'
    registryFixtures.push({ key: request.registryKey, work: root })
    const start = runtime.startGuard
    let replaced = false
    runtime.startGuard = async (options) => {
      const lease = await start(options)
      return {
        ...lease,
        release: async () => {
          // The native registry has already returned to its original state before gate release.
          expect(await readRegistration(request.registryKey!)).toEqual({
            exists: false,
            values: [],
            subkeys: []
          })
          await lease.release()
        },
        assertHeld: async () => {
          if (
            !replaced &&
            (await lstat(join(request.installRoot, '.zhumo/current.json')).catch(() => undefined))
          ) {
            replaced = true
            const aside = join(root, 'runtime', 'first-receipt.ini')
            expect(relative(root, request.resultFile).startsWith('..')).toBe(false)
            expect(relative(root, aside).startsWith('..')).toBe(false)
            await rename(request.resultFile, aside)
            await writeFile(request.resultFile, 'a newer file')
          }
          return status
        }
      }
    }
    await expect(installFromSetup(request, undefined, runtime)).rejects.toThrow('回执文件')
    expect(replaced).toBe(true)
    expect(await readCurrentVersion(request.installRoot)).toBeNull()
    expect(await readRegistration(request.registryKey)).toEqual({
      exists: false,
      values: [],
      subkeys: []
    })
    expect(await readFile(request.resultFile, 'utf8')).toBe('a newer file')
    expect(await readFile(join(request.installRoot, '文稿.md'), 'utf8')).toBe(
      '\ufeff# 原稿\r\n不能改变。\r\n'
    )
  })
})
