import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import {
  installFromSetup,
  prepareSetup,
  runSetupCommand,
  type SetupRequest
} from '../../src/main/setup-action'
import { withdrawSetup } from '../../src/main/setup-withdrawal'
import { recoverSetupRemoval } from '../../src/main/setup-removal'
import { readCurrentVersion } from '../../src/main/current-version'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
import {
  readRegistration,
  changeRegistration,
  sameRegistration
} from '../../src/main/setup-registry'
import type { VersionUpdateRuntime } from '../../src/main/version-update'
import { chooseRetirementStorage } from '../../src/main/managed-programs'
import { physicalFs } from '../../src/main/physical-fs'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })
const roots: { root: string; request: SetupRequest }[] = []
const status = {
  ok: true,
  held: true,
  windows: 0,
  scratchBound: true,
  blocked: 0,
  parentChannelClosed: false
} as const
const runtime: VersionUpdateRuntime = {
  assertClosed: async () => {},
  reconnectGuard: async () => {
    throw Error('No real guard in this unit fixture')
  },
  startGuard: async (options) => ({
    pid: process.pid,
    directory: options.workParent,
    signal: new AbortController().signal,
    assertHeld: async () => status,
    release: async () => {}
  })
}
async function source(
  root: string,
  name: string
): Promise<{ source: string; hash: string; uninstaller: string }> {
  const folder = join(root, name),
    source = join(folder, 'payload')
  await mkdir(join(source, 'resources'), { recursive: true })
  await writeFile(join(source, 'ZhuMo.exe'), 'fixture executable, never run natively ' + name)
  await writeFile(join(source, 'resources/app.asar'), 'fixture program archive ' + name)
  await writeFile(join(source, 'resources/extension.dll'), 'fixture extension ' + name)
  await writeFile(join(source, 'resources/help.txt'), 'Reader text remains readable')
  await writeFile(join(source, 'resources/sample.epub'), 'Bundled reading material')
  const manifest = await createProgramManifest(
    source,
    { appId: 'fixture.removal', appVersion: '2.0-' + name, executable: 'ZhuMo.exe' },
    [
      'ZhuMo.exe',
      'resources/app.asar',
      'resources/extension.dll',
      'resources/help.txt',
      'resources/sample.epub'
    ]
  )
  const bytes = JSON.stringify(manifest)
  await writeFile(join(source, 'program-files.v1.json'), bytes)
  const uninstaller = join(folder, 'remove.exe')
  await writeFile(uninstaller, 'uninstaller fixture, never run natively')
  return { source, uninstaller, hash: programManifestHash(bytes) }
}
async function fixture(): Promise<{
  root: string
  request: SetupRequest
  book: string
  image: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-removal-unit-'))
  const release = await source(root, 'runtime-one')
  const request: SetupRequest = {
    source: release.source,
    manifestHash: release.hash,
    uninstaller: release.uninstaller,
    installRoot: join(root, '朱墨'),
    defaultProfile: join(root, '保留设置'),
    workRoot: join(root, 'work'),
    coordinator: join(root, 'coord'),
    appId: 'fixture.removal',
    appName: 'fixture-reader',
    resultFile: join(dirname(release.source), 'installed.ini'),
    desktopDirectory: join(root, 'desktop'),
    menuDirectory: join(root, 'menu'),
    displayName: '朱墨移除验证',
    registryKey: 'Software\\ZhuMoInstallerTests\\' + randomUUID()
  }
  roots.push({ root, request })
  await mkdir(join(request.installRoot, '文稿'), { recursive: true })
  await mkdir(request.defaultProfile)
  const book = join(request.installRoot, '文稿', '原稿.md'),
    image = join(request.installRoot, '文稿', '图片.png')
  await writeFile(book, '\ufeff# 保留原稿\r\n原文。\r\n')
  await writeFile(image, Buffer.from([1, 0, 255, 20]))
  await writeFile(
    join(request.defaultProfile, 'manuscript-library.v1.json'),
    JSON.stringify({ version: 1, path: dirname(book) })
  )
  await writeFile(join(request.defaultProfile, 'settings.json'), '{"fontSize":25}')
  await installFromSetup(request, undefined, runtime)
  return { root, request, book, image }
}
afterEach(async () => {
  for (const { root, request } of roots.splice(0)) {
    const state = inspectUpdateAdmission(
      [request.installRoot, request.defaultProfile],
      request.coordinator
    )
    if (state.writers.some((w) => w.phase === 'mutating'))
      throw Error('Unfinished unit fixture retained: ' + root)
    expect(request.registryKey).toMatch(/^Software\\ZhuMoInstallerTests\\[a-f0-9-]{36}$/)
    await changeRegistration(
      {
        key: request.registryKey!,
        before: await readRegistration(request.registryKey!),
        after: { exists: false, values: [], subkeys: [] }
      },
      root
    )
    const path = relative(await realpath(tmpdir()), await realpath(root))
    expect(path.startsWith('zhumo-removal-unit-') && !path.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

it('removes only recorded unchanged programs, preserves manuscripts and modified files, and reuses the retained profile on reinstall', async () => {
  const { root, request, book, image } = await fixture()
  const pointer = (await readCurrentVersion(request.installRoot))!.pointer
  const directory = join(request.installRoot, '.zhumo/versions', pointer.releaseId)
  await writeFile(join(directory, 'resources/extension.dll'), 'user modified this file')
  await writeFile(join(directory, '私人.md'), '用户放在程序版本里的文稿')
  await writeFile(join(directory, '私人.txt'), '用户自己的纯文本')
  const beforeBook = await readFile(book),
    beforeImage = await readFile(image)
  const removed = await withdrawSetup(request, undefined, runtime)
  expect(removed.removedFiles).toBe(3)
  expect(await readCurrentVersion(request.installRoot)).toBeNull()
  await expect(lstat(join(directory, 'ZhuMo.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(directory, 'resources/extension.dll'), 'utf8')).toBe(
    'user modified this file'
  )
  expect(await readFile(join(directory, '私人.md'), 'utf8')).toContain('用户')
  expect(await readFile(join(directory, '私人.txt'), 'utf8')).toContain('用户自己的纯文本')
  expect(await readFile(join(directory, 'resources/sample.epub'), 'utf8')).toContain(
    'reading material'
  )
  expect(await readFile(book)).toEqual(beforeBook)
  expect(await readFile(image)).toEqual(beforeImage)
  expect(await readRegistration(request.registryKey!)).toEqual({
    exists: false,
    values: [],
    subkeys: []
  })
  const next = await source(root, 'runtime-two')
  const reinstall: SetupRequest = {
    ...request,
    source: next.source,
    uninstaller: next.uninstaller,
    manifestHash: next.hash,
    resultFile: join(dirname(next.source), 'installed.ini'),
    defaultProfile: join(root, '不能使用的空设置')
  }
  const prepared = await prepareSetup(reinstall)
  expect(prepared.directories[1].path).toBe(request.defaultProfile)
  await installFromSetup(reinstall, undefined, runtime)
  expect((await readCurrentVersion(request.installRoot))?.pointer.profile).toBe(
    request.defaultProfile
  )
  expect(await readFile(join(request.defaultProfile, 'settings.json'), 'utf8')).toBe(
    '{"fontSize":25}'
  )
  expect(await readFile(book)).toEqual(beforeBook)
})

it('restores program bytes, pointer, native registration and shortcuts when removal fails after withdrawing the registry', async () => {
  const { request, book } = await fixture(),
    before = (await readCurrentVersion(request.installRoot))!,
    registration = await readRegistration(request.registryKey!)
  const directory = join(request.installRoot, '.zhumo/versions', before.pointer.releaseId)
  const executable = await readFile(join(directory, 'ZhuMo.exe'))
  await writeFile(
    join(directory, 'resources/extension.dll'),
    'user modification present before uninstall'
  )
  await expect(
    withdrawSetup(request, undefined, runtime, {
      progress: async (phase) => {
        if (phase === 'withdrawn') throw Error('fixture: interrupted final verification')
      }
    })
  ).rejects.toThrow('interrupted final verification')
  expect((await readCurrentVersion(request.installRoot))?.bytes).toBe(before.bytes)
  expect(await readFile(join(directory, 'ZhuMo.exe'))).toEqual(executable)
  expect(await readFile(join(directory, 'resources/extension.dll'), 'utf8')).toBe(
    'user modification present before uninstall'
  )
  expect(sameRegistration(await readRegistration(request.registryKey!), registration)).toBe(true)
  expect((await readdir(request.desktopDirectory!)).filter((v) => v.endsWith('.lnk'))).toHaveLength(
    1
  )
  expect(await readFile(book, 'utf8')).toContain('保留原稿')
  expect(
    inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
      .writers
  ).toEqual([])
})

it.each(['withdrawn', 'committed'] as const)(
  'recovers a real dead helper at %s without replacing newer user text',
  async (stop) => {
    const { root, request, book } = await fixture()
    const before = (await readCurrentVersion(request.installRoot))!,
      registration = await readRegistration(request.registryKey!)
    const wrapper = join(root, 'interrupt.cjs'),
      plan = join(root, 'request.json')
    await writeFile(plan, JSON.stringify(request))
    await writeFile(
      wrapper,
      `const fs=require('node:fs');const {withdrawSetup}=require(${JSON.stringify(resolve('out/main/setup-withdrawal.js'))});
const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const runtime={assertClosed:async()=>{},reconnectGuard:async()=>{throw Error('none')},startGuard:async(o)=>({pid:process.pid,directory:o.workParent,signal:new AbortController().signal,assertHeld:async()=>({ok:true,held:true,windows:0,scratchBound:true,blocked:0,parentChannelClosed:false}),release:async()=>{}})};
withdrawSetup(request,undefined,runtime,{progress:async(p,t)=>{if(p===process.argv[4]){fs.writeFileSync(process.argv[3],t);process.exit(69)}}}).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`
    )
    const transactionFile = join(root, 'transaction.txt')
    const exit = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, [wrapper, plan, transactionFile, stop], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('close', done)
    })
    expect(exit).toBe(69)
    const transaction = await readFile(transactionFile, 'utf8')
    expect(await readCurrentVersion(request.installRoot)).toBeNull()
    expect(
      inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
        .writers[0]
    ).toMatchObject({ phase: 'mutating', ownerAlive: false })
    await writeFile(book, '# 中断后用户继续修改的原稿\n必须保留这个最新版本。')
    const expected = {
      root: request.installRoot,
      profile: request.defaultProfile,
      coordinator: request.coordinator,
      appId: request.appId,
      registryKey: request.registryKey!
    }
    const state = join(transaction, 'withdrawal.json'),
      originalJournal = await readFile(state)
    const tampered = JSON.parse(originalJournal.toString())
    tampered.programs[0].directory = dirname(book)
    await writeFile(state, JSON.stringify(tampered))
    await expect(recoverSetupRemoval(transaction, expected, {}, runtime)).rejects.toThrow('越出')
    expect(await readFile(book, 'utf8')).toContain('最新版本')
    await writeFile(state, originalJournal)
    if (stop === 'committed') {
      const ini = join(dirname(request.source), 'setup.ini')
      await writeFile(
        ini,
        Buffer.from(
          '\ufeff[Setup]\r\n' +
            Object.entries(request)
              .map(([key, value]) => key + '=' + value)
              .join('\r\n') +
            '\r\n',
          'utf16le'
        )
      )
      const finished = await runSetupCommand(['--uninstall', ini], undefined, runtime)
      expect(finished.transaction).toBe(transaction)
      expect(
        (await readdir(request.workRoot)).filter((name) => name.startsWith('withdraw-'))
      ).toHaveLength(1)
    }
    const result = await recoverSetupRemoval(
      transaction,
      {
        root: request.installRoot,
        profile: request.defaultProfile,
        coordinator: request.coordinator,
        appId: request.appId,
        registryKey: request.registryKey!
      },
      {},
      runtime
    )
    expect(result.phase).toBe(stop === 'committed' ? 'committed' : 'rolled-back')
    if (stop === 'committed') {
      expect(await readCurrentVersion(request.installRoot)).toBeNull()
      expect(await readRegistration(request.registryKey!)).toEqual({
        exists: false,
        values: [],
        subkeys: []
      })
    } else {
      expect((await readCurrentVersion(request.installRoot))?.bytes).toBe(before.bytes)
      expect(sameRegistration(await readRegistration(request.registryKey!), registration)).toBe(
        true
      )
    }
    expect(await readFile(book, 'utf8')).toContain('最新版本')
    expect((await readdir(request.menuDirectory!)).filter((v) => v.endsWith('.lnk'))).toHaveLength(
      stop === 'committed' ? 0 : 1
    )
  }
)
it('refuses a cross-volume recovery location inside the existing user profile before creating anything there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-removal-storage-')),
    program = join(root, 'program'),
    transaction = join(root, 'work'),
    profile = join(root, '.zhumo-program-recovery')
  for (const path of [program, transaction, profile]) await mkdir(path)
  const info = await lstat(root)
  const spy = vi
    .spyOn(physicalFs, 'stat')
    .mockResolvedValueOnce({ ...info, dev: 100 } as never)
    .mockResolvedValueOnce({ ...info, dev: 200 } as never)
  try {
    await expect(chooseRetirementStorage(program, transaction, [profile])).rejects.toThrow(
      '资料目录之外'
    )
    expect(await readdir(profile)).toEqual([])
  } finally {
    spy.mockRestore()
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-removal-storage-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
