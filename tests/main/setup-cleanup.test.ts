import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  cp,
  lstat,
  rename,
  symlink
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { installFromSetup, type SetupRequest } from '../../src/main/setup-action'
import { withdrawSetup } from '../../src/main/setup-withdrawal'
import type { RemovalExpected } from '../../src/main/setup-removal'
import { cleanupCompletedRemoval, prepareCleanup } from '../../src/main/setup-cleanup'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
import * as admissionModule from '../../src/main/update-admission'
import { writeFileSync } from 'node:fs'
import { readRegistration, changeRegistration } from '../../src/main/setup-registry'
import { readCurrentVersion } from '../../src/main/current-version'
import type { VersionUpdateRuntime } from '../../src/main/version-update'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })
const fixtures: { root: string; request: SetupRequest }[] = []
const runtime: VersionUpdateRuntime = {
  assertClosed: async () => {},
  reconnectGuard: async () => {
    throw Error('fixture')
  },
  startGuard: async (options) => ({
    pid: process.pid,
    directory: options.workParent,
    signal: new AbortController().signal,
    assertHeld: async () => ({
      ok: true,
      held: true,
      windows: 0,
      scratchBound: true,
      blocked: 0,
      parentChannelClosed: false
    }),
    release: async () => {}
  })
}
async function fixture(
  owned = true
): Promise<{ root: string; request: SetupRequest; execution: string; book: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-cleanup-test-')),
    id = '{' + randomUUID() + '}',
    source = join(root, 'runtimes', id, 'payload')
  await mkdir(join(source, 'resources'), { recursive: true })
  await writeFile(join(source, 'ZhuMo.exe'), 'original executable fixture')
  await writeFile(join(source, 'resources/app.asar'), 'original archive fixture')
  const manifest = JSON.stringify(
    await createProgramManifest(
      source,
      { appId: 'fixture.cleanup', appVersion: '2.0', executable: 'ZhuMo.exe' },
      ['ZhuMo.exe', 'resources/app.asar']
    )
  )
  await writeFile(join(source, 'program-files.v1.json'), manifest)
  const uninstaller = join(dirname(source), 'remove.exe')
  await writeFile(uninstaller, 'owned uninstaller')
  const request: SetupRequest = {
    source,
    uninstaller,
    manifestHash: programManifestHash(manifest),
    appId: 'fixture.cleanup',
    appName: 'fixture-reader',
    installRoot: join(root, '朱墨'),
    defaultProfile: join(root, 'profile'),
    workRoot: join(root, 'work'),
    coordinator: join(root, 'coord'),
    resultFile: join(dirname(source), 'installed.ini'),
    desktopDirectory: join(root, 'desktop'),
    menuDirectory: join(root, 'menu'),
    displayName: '朱墨清理测试',
    registryKey: 'Software\\ZhuMoInstallerTests\\' + randomUUID(),
    ...(owned ? { runtimeId: id } : {})
  }
  fixtures.push({ root, request })
  await mkdir(join(request.installRoot, '文稿'), { recursive: true })
  await mkdir(request.defaultProfile)
  const book = join(request.installRoot, '文稿/原稿.md')
  await writeFile(book, '\ufeff# 用户原稿\r\n必须保留。')
  await writeFile(join(request.defaultProfile, 'settings.json'), '{"fontSize":24}')
  await writeFile(
    join(request.defaultProfile, 'manuscript-library.v1.json'),
    JSON.stringify({ version: 1, path: dirname(book) })
  )
  const execution = join(root, 'independent')
  await cp(source, execution, { recursive: true, errorOnExist: true })
  await installFromSetup(request, undefined, runtime)
  return { root, request, execution, book }
}
const expected = (request: SetupRequest): RemovalExpected => ({
  root: request.installRoot,
  profile: request.defaultProfile,
  coordinator: request.coordinator,
  appId: request.appId,
  registryKey: request.registryKey!
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { root, request } of fixtures.splice(0)) {
    if (
      inspectUpdateAdmission(
        [request.installRoot, request.defaultProfile],
        request.coordinator
      ).writers.some((w) => w.phase === 'mutating')
    )
      throw Error('unfinished fixture retained: ' + root)
    expect(request.registryKey).toMatch(/^Software\\ZhuMoInstallerTests\\[a-f0-9-]{36}$/)
    await changeRegistration(
      {
        key: request.registryKey!,
        before: await readRegistration(request.registryKey!),
        after: { exists: false, values: [], subkeys: [] }
      },
      root
    )
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-cleanup-test-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
it.each([false, true])(
  'refuses a nested backup junction before ownership or cached execution (cached=%s)',
  async (cached) => {
    const { root, request, execution } = await fixture()
    let earlier = ''
    await expect(
      withdrawSetup(request, undefined, runtime, {
        progress: async (phase, tx) => {
          earlier = tx
          if (phase === 'withdrawn') throw Error('fixture rollback')
        }
      })
    ).rejects.toThrow('fixture rollback')
    const prior = JSON.parse(await readFile(join(earlier, 'withdrawal.json'), 'utf8'))
    const result = await withdrawSetup(request, undefined, runtime)
    if (cached) {
      const plan = await prepareCleanup(result.transaction, expected(request), execution)
      await writeFile(join(result.transaction, 'cleanup-plan.json'), JSON.stringify(plan))
    }
    const nested = join(prior.programs[0].storage, 'files/resources'),
      saved = nested + '-original'
    expect(relative(root, await realpath(nested)).startsWith('..')).toBe(false)
    await rename(nested, saved)
    await symlink(join(execution, 'resources'), nested, 'junction')
    const external = join(execution, 'resources/app.asar'),
      before = await readFile(external)
    const run = cached
      ? cleanupCompletedRemoval(result.transaction, expected(request), execution)
      : prepareCleanup(result.transaction, expected(request), execution)
    await expect(run).rejects.toThrow(/链接|重解析|别名/)
    expect(await readFile(external)).toEqual(before)
    expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain(
      'original executable'
    )
  }
)
it('rechecks manuscript binding after obtaining admission and preserves the newly selected library', async () => {
  const { request, execution } = await fixture()
  const result = await withdrawSetup(request, undefined, runtime)
  const native = admissionModule.admitUpdate
  const spy = vi.spyOn(admissionModule, 'admitUpdate').mockImplementation((...args) => {
    writeFileSync(
      join(request.defaultProfile, 'manuscript-library.v1.json'),
      JSON.stringify({ version: 1, path: request.source })
    )
    return native(...args)
  })
  await expect(
    cleanupCompletedRemoval(result.transaction, expected(request), execution)
  ).rejects.toThrow('绑定发生改变')
  spy.mockRestore()
  expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain('original executable')
  expect(
    inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
      .writers
  ).toEqual([])
  await cleanupCompletedRemoval(result.transaction, expected(request), execution)
  expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain('original executable')
})
it('uses the original source directory identity for cached cleanup even when file identities survive replacement', async () => {
  const { root, request, execution } = await fixture()
  const result = await withdrawSetup(request, undefined, runtime)
  const plan = await prepareCleanup(result.transaction, expected(request), execution)
  await writeFile(join(result.transaction, 'cleanup-plan.json'), JSON.stringify(plan))
  const before = await lstat(join(request.source, 'ZhuMo.exe'), { bigint: true }),
    old = request.source + '-old'
  expect(relative(root, await realpath(request.source)).startsWith('..')).toBe(false)
  await rename(request.source, old)
  await mkdir(request.source)
  for (const name of await readdir(old)) await rename(join(old, name), join(request.source, name))
  expect((await lstat(join(request.source, 'ZhuMo.exe'), { bigint: true })).ino).toBe(before.ino)
  await expect(
    cleanupCompletedRemoval(result.transaction, expected(request), execution)
  ).rejects.toThrow('目录已被替代')
  expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain('original executable')
})
it('purges only owned unchanged runtime/program copies and preserves changed files, manuscripts, settings and snapshots', async () => {
  const { request, execution, book } = await fixture()
  await writeFile(join(request.source, 'private.md'), '用户新增的启动目录文稿')
  const result = await withdrawSetup(request, undefined, runtime)
  await writeFile(join(request.source, 'resources/app.asar'), 'user changed this program file')
  const state = JSON.parse(await readFile(join(result.transaction, 'withdrawal.json'), 'utf8'))
  const cleanup = await cleanupCompletedRemoval(result.transaction, expected(request), execution)
  expect(cleanup.deleted).toBe(4)
  expect(cleanup.retained.some((f) => f.path.endsWith('app.asar'))).toBe(true)
  await expect(lstat(join(request.source, 'ZhuMo.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(request.source, 'resources/app.asar'), 'utf8')).toBe(
    'user changed this program file'
  )
  expect(await readFile(join(request.source, 'private.md'), 'utf8')).toContain('用户新增')
  expect(await readFile(book, 'utf8')).toContain('必须保留')
  expect(await readFile(join(request.defaultProfile, 'settings.json'), 'utf8')).toBe(
    '{"fontSize":24}'
  )
  for (const p of state.programs)
    await expect(lstat(join(p.storage, 'files/ZhuMo.exe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  const update = (await readdir(request.workRoot)).find((n) => n.startsWith('update-'))!
  expect((await lstat(join(request.workRoot, update, 'snapshot'))).isDirectory()).toBe(true)
})
it('does not reclaim a generic caller-supplied source without NSIS runtime ownership', async () => {
  const { request, execution } = await fixture(false)
  const result = await withdrawSetup(request, undefined, runtime)
  const cleanup = await cleanupCompletedRemoval(result.transaction, expected(request), execution)
  expect(cleanup.deleted).toBe(2)
  expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain('original executable')
  expect(await readFile(request.uninstaller!, 'utf8')).toBe('owned uninstaller')
})
it('also reclaims program-only copies left by an earlier successfully rolled-back removal', async () => {
  const { request, execution, book } = await fixture()
  let failedTransaction = ''
  await expect(
    withdrawSetup(request, undefined, runtime, {
      progress: async (phase, tx) => {
        failedTransaction = tx
        if (phase === 'withdrawn') throw Error('fixture rollback')
      }
    })
  ).rejects.toThrow('fixture rollback')
  const before = JSON.parse(await readFile(join(failedTransaction, 'withdrawal.json'), 'utf8'))
  expect(before.phase).toBe('rolled-back')
  const result = await withdrawSetup(request, undefined, runtime)
  const cleanup = await cleanupCompletedRemoval(result.transaction, expected(request), execution)
  expect(cleanup.deleted).toBe(7)
  for (const program of before.programs)
    await expect(lstat(join(program.storage, 'files/ZhuMo.exe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  expect(await readFile(book, 'utf8')).toContain('必须保留')
})
it('rejects a forged cleanup target before deleting any remaining program or user file', async () => {
  const { request, execution, book } = await fixture()
  const result = await withdrawSetup(request, undefined, runtime)
  const plan = await prepareCleanup(result.transaction, expected(request), execution)
  const file = plan.files[0]
  file.path = book
  await writeFile(join(result.transaction, 'cleanup-plan.json'), JSON.stringify(plan))
  await expect(
    cleanupCompletedRemoval(result.transaction, expected(request), execution)
  ).rejects.toThrow('原记录之外')
  expect(await readFile(join(request.source, 'ZhuMo.exe'), 'utf8')).toContain('original executable')
  expect(await readFile(book, 'utf8')).toContain('必须保留')
})
it('can repeat forward-only cleanup after a real worker exits following its first deletion', async () => {
  const { root, request, execution, book } = await fixture()
  const result = await withdrawSetup(request, undefined, runtime)
  const worker = join(root, 'interrupt.cjs'),
    input = join(root, 'cleanup.json')
  await writeFile(
    input,
    JSON.stringify({ transaction: result.transaction, expected: expected(request), execution })
  )
  await writeFile(
    worker,
    `const fs=require('node:fs');const {cleanupCompletedRemoval}=require(${JSON.stringify(resolve('out/main/setup-cleanup.js'))});const p=JSON.parse(fs.readFileSync(process.argv[2]));cleanupCompletedRemoval(p.transaction,p.expected,p.execution,async()=>process.exit(69)).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`
  )
  const code = await new Promise<number | null>((done, reject) => {
    const p = spawn(process.execPath, [worker, input], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    })
    p.on('error', reject)
    p.on('close', done)
  })
  expect(code).toBe(69)
  await writeFile(book, '# 清理中断之后的新原稿')
  const cleanup = await cleanupCompletedRemoval(result.transaction, expected(request), execution)
  expect(cleanup.missing).toBe(1)
  expect(cleanup.deleted).toBe(4)
  expect(await readFile(book, 'utf8')).toContain('新原稿')
  expect(await readCurrentVersion(request.installRoot)).toBeNull()
})
