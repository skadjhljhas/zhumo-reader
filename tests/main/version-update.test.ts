import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import { readCurrentVersion } from '../../src/main/current-version'
import {
  installVersion,
  recoverVersionUpdate,
  type VersionUpdatePlan,
  type VersionUpdateRuntime
} from '../../src/main/version-update'
import { admitReader, inspectUpdateAdmission } from '../../src/main/update-admission'
const roots: string[] = []
async function fixture(): Promise<{
  plan: VersionUpdatePlan
  root: string
  diary: string
  original: Buffer
  runtime: VersionUpdateRuntime
  guard: { lost: boolean; released: number }
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-version-update-'))
  roots.push(root)
  const installRoot = join(root, '朱墨'),
    profile = join(root, '设置'),
    source = join(root, 'source'),
    workRoot = join(root, 'work'),
    coordinator = join(root, 'coord'),
    library = join(root, '外部文稿')
  for (const path of [installRoot, profile, source, workRoot, coordinator, library])
    await mkdir(path)
  await mkdir(join(source, 'resources'))
  await writeFile(join(source, 'ZhuMo-AI.exe'), 'new executable fixture')
  await writeFile(join(source, 'resources/app.asar'), 'new app fixture')
  await writeFile(join(source, 'resources/guide.md'), 'new bundled guide')
  const manifest = await createProgramManifest(
    source,
    { appId: 'fixture.zhumo', appVersion: '2.0.28', executable: 'ZhuMo-AI.exe' },
    ['ZhuMo-AI.exe', 'resources/app.asar', 'resources/guide.md']
  )
  const manifestBytes = JSON.stringify(manifest, null, 2)
  await writeFile(join(source, 'program-files.v1.json'), manifestBytes)
  const diary = join(installRoot, '日记.md'),
    original = Buffer.from('\ufeff# 日记\r\n正文[^a]\r\n\r\n[^a]: 用户注释\r\n')
  await writeFile(diary, original)
  await writeFile(join(installRoot, 'ZhuMo-AI.exe'), 'legacy executable untouched')
  await writeFile(join(profile, 'Local State'), '{"opaque":"fixture-encryption-context"}')
  await writeFile(join(profile, 'settings.json'), '{"fontSize":23}')
  await writeFile(join(library, '另一篇.md'), '独立文稿')
  await writeFile(
    join(profile, 'manuscript-library.v1.json'),
    JSON.stringify({ version: 1, path: library })
  )
  const guard = { lost: false, released: 0 }
  const lease = (
    directory: string
  ): Awaited<ReturnType<VersionUpdateRuntime['reconnectGuard']>> => ({
    pid: process.pid,
    directory,
    signal: new AbortController().signal,
    failure: new Promise<never>(() => {}),
    async assertHeld() {
      if (guard.lost) throw Error('lost guard')
      return {
        ok: true as const,
        held: true as const,
        windows: 0 as const,
        scratchBound: true as const,
        blocked: 0,
        parentChannelClosed: false
      }
    },
    async release() {
      if (
        inspectUpdateAdmission([profile, installRoot], coordinator).writers.some(
          (w) => w.phase === 'mutating'
        )
      )
        throw Error('active mutation')
      guard.released++
    }
  })
  const runtime: VersionUpdateRuntime = {
    assertClosed: async () => {},
    startGuard: async (options) => {
      const directory = join(options.workParent, 'fake-guard-' + randomUUID())
      await mkdir(directory)
      return lease(directory)
    },
    reconnectGuard: async (directory) => lease(directory)
  }
  return {
    root,
    diary,
    original,
    guard,
    runtime,
    plan: {
      installRoot,
      profile,
      source,
      workRoot,
      coordinator,
      libraryRoots: [],
      manifestBytes,
      manifestSha256: programManifestHash(manifestBytes),
      expectedAppId: 'fixture.zhumo',
      expectedCurrentBytes: null,
      appName: 'fixture-reader'
    }
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-version-update-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
async function expired(coordinator: string, token: string): Promise<void> {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    windowsHide: true,
    encoding: 'utf8'
  })
  expect(child.status).toBe(0)
  const pid = Number(child.stdout)
  expect(() => process.kill(pid, 0)).toThrow()
  const state = join(coordinator, 'states', token + '.json'),
    record = JSON.parse(await readFile(state, 'utf8'))
  record.pid = pid
  record.birth = null
  await writeFile(state, JSON.stringify(record))
  for (const folder of await readdir(coordinator))
    if (folder !== 'states') {
      const claim = join(coordinator, folder, 'writers', token + '.json')
      try {
        await readFile(claim)
        await writeFile(claim, JSON.stringify(record))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
}
it('installs a verified side-by-side release while preserving legacy program, bound library and complete profile', async () => {
  const f = await fixture(),
    phases: string[] = []
  const result = await installVersion(
    f.plan,
    {
      progress: (phase) => {
        phases.push(phase)
      }
    },
    f.runtime
  )
  expect((await readCurrentVersion(f.plan.installRoot))?.pointer).toEqual(result.pointer)
  expect(result.pointer.profile).toBe(f.plan.profile)
  expect(await readFile(f.diary)).toEqual(f.original)
  expect(await readFile(join(f.plan.installRoot, 'ZhuMo-AI.exe'), 'utf8')).toBe(
    'legacy executable untouched'
  )
  expect(await readFile(join(result.directory, 'resources/guide.md'), 'utf8')).toBe(
    'new bundled guide'
  )
  const snapshot = JSON.parse(await readFile(join(result.snapshot, 'manifest.json'), 'utf8'))
  expect(snapshot.roots.map((r: { source: string }) => r.source)).toContain(
    join(f.root, '外部文稿')
  )
  expect(phases).toEqual(['preparing', 'saved', 'staged', 'publishing', 'published', 'committed'])
  expect(
    inspectUpdateAdmission([f.plan.installRoot, f.plan.profile], f.plan.coordinator).writers
  ).toEqual([])
  expect(f.guard.released).toBe(1)
}, 30000)
it('rolls a failed first publication back to no pointer without restoring over a newly edited manuscript', async () => {
  const f = await fixture()
  let transaction = ''
  try {
    await installVersion(
      f.plan,
      {
        progress: async (phase) => {
          if (phase === 'published') {
            await writeFile(f.diary, '用户此刻新写的内容')
            throw Error('injected post-publication failure')
          }
        }
      },
      f.runtime
    )
  } catch (error) {
    transaction = (error as { transaction: string }).transaction
  }
  expect(transaction).toBeTruthy()
  expect(await readCurrentVersion(f.plan.installRoot)).toBeNull()
  expect(await readFile(f.diary, 'utf8')).toBe('用户此刻新写的内容')
  expect(JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8')).phase).toBe(
    'rolled-back'
  )
  expect(
    inspectUpdateAdmission([f.plan.installRoot, f.plan.profile], f.plan.coordinator).writers
  ).toEqual([])
}, 30000)
it('restores exact prior pointer bytes after a later release fails, retaining both version directories', async () => {
  const f = await fixture(),
    first = await installVersion(f.plan, {}, f.runtime)
  const before = (await readCurrentVersion(f.plan.installRoot))!.bytes
  await expect(
    installVersion(
      { ...f.plan, expectedCurrentBytes: before },
      {
        progress: (phase) => {
          if (phase === 'published') throw Error('injected')
        }
      },
      f.runtime
    )
  ).rejects.toThrow('injected')
  expect((await readCurrentVersion(f.plan.installRoot))!.bytes).toBe(before)
  expect(await readdir(join(f.plan.installRoot, '.zhumo/versions'))).toHaveLength(2)
  expect(await readFile(join(first.directory, 'resources/app.asar'), 'utf8')).toBe(
    'new app fixture'
  )
  expect(await readFile(f.diary)).toEqual(f.original)
}, 60000)
it.each(['commit', 'rollback'] as const)(
  'recovers an interrupted published update by explicit %s, preserving data and releasing the durable gate',
  async (action) => {
    const f = await fixture()
    let transaction = ''
    try {
      await installVersion(
        f.plan,
        {
          progress: (phase) => {
            if (phase === 'published') {
              f.guard.lost = true
              throw Error('process/guard disconnected')
            }
          }
        },
        f.runtime
      )
    } catch (error) {
      transaction = (error as { transaction: string }).transaction
    }
    const journal = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8'))
    expect(journal.phase).toBe('recovery-needed')
    expect(() => admitReader([f.plan.profile], f.plan.coordinator)).toThrow()
    await expired(f.plan.coordinator, journal.admissionToken)
    f.guard.lost = false
    const result = await recoverVersionUpdate(
      transaction,
      {
        installRoot: f.plan.installRoot,
        profile: f.plan.profile,
        coordinator: f.plan.coordinator,
        appId: f.plan.expectedAppId
      },
      action,
      {},
      f.runtime
    )
    expect(result.phase).toBe(action === 'commit' ? 'committed' : 'rolled-back')
    expect(Boolean(await readCurrentVersion(f.plan.installRoot))).toBe(action === 'commit')
    expect(await readFile(f.diary)).toEqual(f.original)
    expect(
      inspectUpdateAdmission([f.plan.installRoot, f.plan.profile], f.plan.coordinator).writers
    ).toEqual([])
  },
  30000
)
it('refuses a stale current pointer or unavailable bound library before entering an update', async () => {
  const f = await fixture()
  await expect(
    installVersion({ ...f.plan, expectedCurrentBytes: 'stale' }, {}, f.runtime)
  ).rejects.toThrow('当前版本已改变')
  await writeFile(
    join(f.plan.profile, 'manuscript-library.v1.json'),
    JSON.stringify({ version: 1, path: join(f.root, 'missing-library') })
  )
  await expect(installVersion(f.plan, {}, f.runtime)).rejects.toThrow()
  expect(await readCurrentVersion(f.plan.installRoot)).toBeNull()
  expect(await readdir(f.plan.workRoot)).toHaveLength(0)
}, 30000)
