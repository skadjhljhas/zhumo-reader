import { it, expect, afterEach, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  lstat,
  rename,
  symlink,
  link,
  utimes,
  open
} from 'node:fs/promises'
import { join, relative, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import { stageRelease, verifyStagedRelease } from '../../src/main/release-stage'
const roots: string[] = []
async function fixture(withManifest = true): Promise<{
  root: string
  source: string
  destination: string
  manifest: Awaited<ReturnType<typeof createProgramManifest>>
  bytes: Buffer
  hash: string
  originals: Map<string, Buffer>
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-release-stage-'))
  roots.push(root)
  const source = join(root, 'source'),
    destination = join(root, 'version-fresh')
  await mkdir(join(source, 'resources'), { recursive: true })
  const originals = new Map<string, Buffer>([
    ['ZhuMo.exe', Buffer.from([77, 90, 0, 255, 17])],
    ['resources/app.asar', Buffer.from([1, 0, 28, 250])],
    ['resources/说明.md', Buffer.from('\uFEFF# 原格式\r\n\r\n正文[^a]\r\n\r\n[^a]: 旁注\r\n')]
  ])
  for (const [path, content] of originals) await writeFile(join(source, path), content)
  const manifest = await createProgramManifest(
    source,
    { appId: 'fixture.zhumo', appVersion: '2.0.0', executable: 'ZhuMo.exe' },
    [...originals.keys()]
  )
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2)),
    hash = programManifestHash(bytes)
  if (withManifest) await writeFile(join(source, 'program-files.v1.json'), bytes)
  return { root, source, destination, manifest, bytes, hash, originals }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const actual = await realpath(root),
      rel = relative(await realpath(tmpdir()), actual)
    expect(rel.startsWith('zhumo-release-stage-') && !rel.includes('..')).toBe(true)
    await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
async function missing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}
it.each([true, false])(
  'copies a complete independent release, preserves MD bytes and the exact trusted manifest (source manifest=%s)',
  async (withManifest) => {
    const f = await fixture(withManifest),
      progress: Array<[number, number]> = []
    const result = await stageRelease(f.source, f.destination, f.bytes, f.hash, {
      progress: (files, bytes) => {
        progress.push([files, bytes])
      }
    })
    expect(result).toEqual({
      directory: await realpath(f.destination),
      manifest: f.manifest,
      manifestSha256: f.hash
    })
    for (const [path, bytes] of f.originals) {
      expect(await readFile(join(f.source, path))).toEqual(bytes)
      expect(await readFile(join(f.destination, path))).toEqual(bytes)
      expect((await lstat(join(f.destination, path), { bigint: true })).ino).not.toBe(
        (await lstat(join(f.source, path), { bigint: true })).ino
      )
    }
    expect(await readFile(join(f.destination, 'program-files.v1.json'))).toEqual(f.bytes)
    expect(progress.at(-1)).toEqual([
      f.originals.size,
      [...f.originals.values()].reduce((n, b) => n + b.length, 0)
    ])
    expect(await verifyStagedRelease(f.destination, f.bytes, f.hash)).toEqual(result)
    expect(await verifyStagedRelease(f.destination, f.bytes.toString(), f.hash)).toEqual(result)
  }
)

it('rejects the untrusted digest before creating any destination or interpreting its paths', async () => {
  const f = await fixture()
  await expect(stageRelease(f.source, f.destination, f.bytes, '0'.repeat(64))).rejects.toThrow(
    '受信校验'
  )
  await missing(f.destination)
  expect(await readFile(join(f.source, 'resources/说明.md'))).toEqual(
    f.originals.get('resources/说明.md')
  )
})

it('refuses existing directories (even empty), source descendants, and filesystem roots', async () => {
  const f = await fixture()
  await mkdir(f.destination)
  await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow('已经存在')
  await writeFile(join(f.destination, '旧文稿.md'), 'existing user manuscript')
  await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow('已经存在')
  expect(await readFile(join(f.destination, '旧文稿.md'), 'utf8')).toBe('existing user manuscript')
  await expect(stageRelease(f.source, join(f.source, 'nested'), f.bytes, f.hash)).rejects.toThrow(
    '相互包含'
  )
  await expect(
    stageRelease(parse(f.source).root, join(f.root, 'other'), f.bytes, f.hash)
  ).rejects.toThrow('根目录')
  await expect(stageRelease(f.source, parse(f.destination).root, f.bytes, f.hash)).rejects.toThrow(
    '根目录'
  )
  await missing(join(f.source, 'nested'))
})

it.each(['private.md', 'extra-empty-directory', 'corrupt-package', 'corrupt-manifest'])(
  'rejects an altered/unlisted source before creating a target: %s',
  async (kind) => {
    const f = await fixture()
    if (kind === 'private.md') await writeFile(join(f.source, 'private.md'), 'user manuscript')
    if (kind === 'extra-empty-directory') await mkdir(join(f.source, 'unlisted'))
    if (kind === 'corrupt-package') await writeFile(join(f.source, 'resources/app.asar'), 'broken')
    if (kind === 'corrupt-manifest') await writeFile(join(f.source, 'program-files.v1.json'), '{}')
    await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow()
    await missing(f.destination)
    if (kind === 'private.md')
      expect(await readFile(join(f.source, 'private.md'), 'utf8')).toBe('user manuscript')
  }
)

it('does not allow the manifest to claim its own reserved path', async () => {
  const f = await fixture()
  const bytes = JSON.stringify({
    ...f.manifest,
    files: [...f.manifest.files, { path: 'program-files.v1.json', size: 0, sha256: '0'.repeat(64) }]
  })
  await expect(
    stageRelease(f.source, f.destination, bytes, programManifestHash(bytes))
  ).rejects.toThrow('清单自身')
  await missing(f.destination)
})

it('copies the caller manifest buffer before awaiting progress and filesystem operations', async () => {
  const f = await fixture(),
    supplied = Buffer.from(f.bytes)
  await stageRelease(f.source, f.destination, supplied, f.hash, {
    progress: () => {
      supplied.fill(0)
    }
  })
  expect(await readFile(join(f.destination, 'program-files.v1.json'))).toEqual(f.bytes)
})

it('cancellation before work creates nothing; cancellation after a copy leaves an unpublished directory', async () => {
  const f = await fixture(),
    early = new AbortController()
  early.abort(Error('fixture cancellation'))
  await expect(
    stageRelease(f.source, f.destination, f.bytes, f.hash, { signal: early.signal })
  ).rejects.toThrow('fixture cancellation')
  await missing(f.destination)
  const abort = new AbortController()
  await expect(
    stageRelease(f.source, f.destination, f.bytes, f.hash, {
      signal: abort.signal,
      progress: () => {
        abort.abort(Error('mid-copy cancellation'))
      }
    })
  ).rejects.toThrow('mid-copy cancellation')
  expect((await lstat(f.destination)).isDirectory()).toBe(true)
  expect(await readFile(join(f.destination, f.manifest.files[0].path))).toEqual(
    f.originals.get(f.manifest.files[0].path)
  )
  await missing(join(f.destination, 'program-files.v1.json'))
  await expect(verifyStagedRelease(f.destination, f.bytes, f.hash)).rejects.toThrow()
})

it.each([
  'source-bytes',
  'source-same-bytes-metadata',
  'source-new-file',
  'destination-bytes',
  'destination-new-file',
  'destination-replaced-file'
])('detects %s after copying and leaves the unpublished directory for recovery', async (kind) => {
  const f = await fixture(),
    first = f.manifest.files[0].path
  let changed = false
  await expect(
    stageRelease(f.source, f.destination, f.bytes, f.hash, {
      progress: async () => {
        if (changed) return
        changed = true
        if (kind === 'source-bytes') await writeFile(join(f.source, first), 'changed source')
        if (kind === 'source-same-bytes-metadata')
          await utimes(join(f.source, first), new Date(), new Date(Date.now() + 5000))
        if (kind === 'source-new-file')
          await writeFile(join(f.source, 'new-user.md'), 'new source manuscript')
        if (kind === 'destination-bytes')
          await writeFile(join(f.destination, first), 'changed target')
        if (kind === 'destination-new-file')
          await writeFile(join(f.destination, 'new-user.md'), 'new destination manuscript')
        if (kind === 'destination-replaced-file') {
          await rename(join(f.destination, first), join(f.root, 'displaced.bin'))
          await writeFile(join(f.destination, first), f.originals.get(first)!)
        }
      }
    })
  ).rejects.toThrow()
  expect((await lstat(f.destination)).isDirectory()).toBe(true)
  if (kind === 'destination-new-file')
    expect(await readFile(join(f.destination, 'new-user.md'), 'utf8')).toBe(
      'new destination manuscript'
    )
  if (kind === 'source-new-file')
    expect(await readFile(join(f.source, 'new-user.md'), 'utf8')).toBe('new source manuscript')
})

it('does not publish when a file fsync fails', async () => {
  const f = await fixture(),
    probe = await open(join(f.root, 'probe'), 'wx')
  const spy = vi
    .spyOn(Object.getPrototypeOf(probe), 'sync')
    .mockRejectedValueOnce(Error('fixture fsync failure'))
  try {
    await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow(
      'fixture fsync failure'
    )
    expect(spy).toHaveBeenCalled()
    expect((await lstat(f.destination)).isDirectory()).toBe(true)
    await missing(join(f.destination, 'program-files.v1.json'))
  } finally {
    spy.mockRestore()
    await probe.close()
  }
})

it('also rejects manifest fsync failure after all copied files, despite the visible manifest bytes', async () => {
  const f = await fixture(),
    probe = await open(join(f.root, 'probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe),
    originalSync = prototype.sync
  let syncs = 0
  const spy = vi.spyOn(prototype, 'sync').mockImplementation(function (this: object) {
    if (++syncs === f.manifest.files.length + 1)
      return Promise.reject(Error('manifest fsync failed'))
    return Reflect.apply(originalSync, this, [])
  })
  try {
    await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow(
      'manifest fsync failed'
    )
    expect(syncs).toBe(f.manifest.files.length + 1)
    expect(await readFile(join(f.destination, 'program-files.v1.json'))).toEqual(f.bytes)
    expect((await lstat(f.destination)).isDirectory()).toBe(true)
  } finally {
    spy.mockRestore()
    await probe.close()
  }
})

it.each(['source-root', 'source-member', 'destination-parent'])(
  'rejects a directory junction/symlink at %s without following it',
  async (kind) => {
    const f = await fixture(),
      alias = join(f.root, 'alias'),
      external = join(f.root, 'external')
    let source = f.source,
      destination = f.destination
    if (kind === 'source-root') {
      await symlink(f.source, alias, 'junction')
      source = alias
    }
    if (kind === 'source-member') {
      await rename(join(f.source, 'resources'), external)
      await symlink(external, join(f.source, 'resources'), 'junction')
    }
    if (kind === 'destination-parent') {
      await mkdir(external)
      await symlink(external, alias, 'junction')
      destination = join(alias, 'new-version')
    }
    await expect(stageRelease(source, destination, f.bytes, f.hash)).rejects.toThrow('链接')
    await missing(f.destination)
    if (kind === 'destination-parent') await missing(join(external, 'new-version'))
  }
)

it('rejects hardlinked source files rather than inheriting ambiguous ownership', async () => {
  const f = await fixture()
  await link(join(f.source, 'ZhuMo.exe'), join(f.root, 'outside-link.exe'))
  await expect(stageRelease(f.source, f.destination, f.bytes, f.hash)).rejects.toThrow('硬链接')
  await missing(f.destination)
})

it('rejects a replacement destination junction before a later file can be copied through it', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside'),
    moved = join(f.root, 'moved-resources')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel.md'), 'untouched outside')
  let changed = false
  await expect(
    stageRelease(f.source, f.destination, f.bytes, f.hash, {
      progress: async () => {
        if (changed) return
        changed = true
        await rename(join(f.destination, 'resources'), moved)
        await symlink(outside, join(f.destination, 'resources'), 'junction')
      }
    })
  ).rejects.toThrow()
  expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe('untouched outside')
  await missing(join(outside, '说明.md'))
})

it.each(['missing-manifest', 'changed-file', 'new-file', 'new-directory', 'hardlink'])(
  're-verifies the whole staged tree before reuse: %s',
  async (kind) => {
    const f = await fixture()
    await stageRelease(f.source, f.destination, f.bytes, f.hash)
    if (kind === 'missing-manifest')
      await rename(
        join(f.destination, 'program-files.v1.json'),
        join(f.root, 'removed-manifest.json')
      )
    if (kind === 'changed-file') await writeFile(join(f.destination, 'ZhuMo.exe'), 'changed')
    if (kind === 'new-file') await writeFile(join(f.destination, 'unlisted.md'), 'private')
    if (kind === 'new-directory') await mkdir(join(f.destination, 'unlisted'))
    if (kind === 'hardlink')
      await link(join(f.destination, 'ZhuMo.exe'), join(f.root, 'outside.exe'))
    await expect(verifyStagedRelease(f.destination, f.bytes, f.hash)).rejects.toThrow()
    expect((await lstat(f.destination)).isDirectory()).toBe(true)
  }
)
