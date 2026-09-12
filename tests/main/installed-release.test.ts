import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join, parse, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProgramManifest,
  programManifestHash,
  type ProgramManifest
} from '../../src/main/program-files'
import { verifyInstalledRelease } from '../../src/main/installed-release'
import { verifyStagedRelease } from '../../src/main/release-stage'
import { launchCurrentVersion } from '../../src/main/version-launcher'
import { physicalFs } from '../../src/main/physical-fs'
import * as preservation from '../../src/main/update-preservation'

const roots: string[] = []
const releaseId = '147dcac3-6962-47a5-a7a4-aaaaaaaaaaaa'
interface Fixture {
  root: string
  directory: string
  manifest: ProgramManifest
  bytes: Buffer
  hash: string
}
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-installed-release-'))
  roots.push(root)
  const directory = join(root, '.zhumo', 'versions', releaseId)
  await mkdir(join(directory, 'resources'), { recursive: true })
  await writeFile(join(directory, 'ZhuMo.exe'), Buffer.from('MZ fixture exe'))
  await writeFile(join(directory, 'resources/app.asar'), Buffer.from('physical archive fixture'))
  const manifest = await createProgramManifest(
    directory,
    { appId: 'fixture.zhumo', appVersion: '2.0.0', executable: 'ZhuMo.exe' },
    ['ZhuMo.exe', 'resources/app.asar']
  )
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2)),
    hash = programManifestHash(bytes)
  await writeFile(join(directory, 'program-files.v1.json'), bytes)
  return { root, directory, manifest, bytes, hash }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) {
    const actual = await realpath(path),
      part = relative(await realpath(tmpdir()), actual)
    expect(part.startsWith('zhumo-installed-release-') && !part.includes('..')).toBe(true)
    await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

it('accepts personal MD, images and empty directories while preserving their exact bytes', async () => {
  const f = await fixture()
  const extras = new Map([
    ['我的文稿.md', Buffer.from('\uFEFF# 朱墨\r\n\r\n文字[^a]\r\n\r\n[^a]: 用户注释\r\n')],
    ['resources/用户图片.png', Buffer.from([137, 80, 78, 71, 0, 255])]
  ])
  for (const [path, bytes] of extras) await writeFile(join(f.directory, path), bytes)
  await mkdir(join(f.directory, '空的用户文件夹'))
  const originalHashes = new Map(
    [...extras].map(([path, bytes]) => [path, programManifestHash(bytes)])
  )
  await expect(verifyInstalledRelease(f.directory, f.bytes, f.hash)).resolves.toEqual({
    directory: await realpath(f.directory),
    manifest: f.manifest,
    manifestSha256: f.hash
  })
  for (const [path, digest] of originalHashes)
    expect(programManifestHash(await readFile(join(f.directory, path)))).toBe(digest)
  expect((await lstat(join(f.directory, '空的用户文件夹'))).isDirectory()).toBe(true)
  // The source/staging contract remains strict; only installed-version verification changes.
  await expect(verifyStagedRelease(f.directory, f.bytes, f.hash)).rejects.toThrow('未声明')
})

it('never inventories unlisted directories or follows their junctions or hard links', async () => {
  const f = await fixture(),
    outside = join(f.root, '私人目录'),
    extraLink = join(f.directory, '用户目录链接')
  await mkdir(outside)
  const secret = Buffer.from('private manuscript outside the version')
  await writeFile(join(outside, '私人.md'), secret)
  await symlink(outside, extraLink, process.platform === 'win32' ? 'junction' : 'dir')
  await link(join(outside, '私人.md'), join(f.directory, '用户硬链接.md'))
  const inventory = vi.spyOn(physicalFs, 'readdir').mockRejectedValue(Error('must not inventory'))
  const originalDigest = preservation.fileDigest
  const digests = vi.spyOn(preservation, 'fileDigest').mockImplementation(originalDigest)
  await verifyInstalledRelease(f.directory, f.bytes, f.hash)
  expect(inventory).not.toHaveBeenCalled()
  expect(digests.mock.calls.map(([path]) => path).sort()).toEqual(
    [
      ...f.manifest.files.map((file) => join(f.directory, file.path)),
      join(f.directory, 'program-files.v1.json')
    ].sort()
  )
  expect(await readFile(join(outside, '私人.md'))).toEqual(secret)
  expect((await lstat(extraLink)).isSymbolicLink()).toBe(true)
})

it.each(['ZhuMo.exe', 'resources/app.asar', 'program-files.v1.json'])(
  'rejects missing, altered or linked known file %s while leaving user text intact',
  async (path) => {
    const f = await fixture(),
      personal = join(f.directory, '我的阅读笔记.md'),
      text = Buffer.from('# 独立保存的用户内容\r\n')
    await writeFile(personal, text)
    await writeFile(join(f.directory, path), 'damaged')
    await expect(verifyInstalledRelease(f.directory, f.bytes, f.hash)).rejects.toThrow('哈希')
    expect(await readFile(personal)).toEqual(text)
    await rm(join(f.directory, path))
    await expect(verifyInstalledRelease(f.directory, f.bytes, f.hash)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(personal)).toEqual(text)
  }
)

it.each(['ZhuMo.exe', 'program-files.v1.json'])(
  'rejects a known hard-linked file: %s',
  async (path) => {
    const f = await fixture()
    await link(join(f.directory, path), join(f.root, 'outside-hard-link'))
    await expect(verifyInstalledRelease(f.directory, f.bytes, f.hash)).rejects.toThrow(
      '独立普通文件'
    )
  }
)

it('rejects a known ancestor junction before hashing through it', async () => {
  const f = await fixture(),
    original = join(f.directory, 'resources'),
    moved = join(f.root, 'moved-resources')
  await rename(original, moved)
  await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
  const digests = vi.spyOn(preservation, 'fileDigest')
  await expect(verifyInstalledRelease(f.directory, f.bytes, f.hash)).rejects.toThrow('链接')
  expect(digests).not.toHaveBeenCalled()
})

it('rejects a root entered through a junction, an invalid digest and filesystem roots', async () => {
  const f = await fixture(),
    alias = join(f.root, 'alias')
  await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(verifyInstalledRelease(alias, f.bytes, f.hash)).rejects.toThrow('链接')
  await expect(verifyInstalledRelease(f.directory, f.bytes, '0'.repeat(64))).rejects.toThrow(
    '受信校验'
  )
  await expect(verifyInstalledRelease(parse(f.root).root, f.bytes, f.hash)).rejects.toThrow('盘根')
})

it('copies trusted manifest bytes before the first filesystem await', async () => {
  const f = await fixture(),
    supplied = Buffer.from(f.bytes)
  const verified = verifyInstalledRelease(f.directory, supplied, f.hash)
  supplied.fill(0)
  await expect(verified).resolves.toMatchObject({ manifestSha256: f.hash })
})

it('allows user-book creation during verification but catches a previously verified program file changing', async () => {
  for (const changeProgram of [false, true]) {
    const f = await fixture()
    const originalDigest = preservation.fileDigest
    let calls = 0
    const spy = vi
      .spyOn(preservation, 'fileDigest')
      .mockImplementation(async (path, destination, options) => {
        const result = await originalDigest(path, destination, options)
        if (++calls === f.manifest.files.length + 1) {
          if (changeProgram)
            await writeFile(join(f.directory, f.manifest.files[0].path), 'changed after hashing')
          else await writeFile(join(f.directory, '正在保存的文稿.md'), '用户正文')
        }
        return result
      })
    const verified = verifyInstalledRelease(f.directory, f.bytes, f.hash)
    if (changeProgram) await expect(verified).rejects.toThrow('再次改变')
    else {
      await expect(verified).resolves.toMatchObject({ manifestSha256: f.hash })
      expect(await readFile(join(f.directory, '正在保存的文稿.md'), 'utf8')).toBe('用户正文')
    }
    spy.mockRestore()
  }
})

it('launches a verified installed reader with user MD beside it and refuses the same tree after app.asar corruption', async () => {
  const f = await fixture(),
    personal = join(f.directory, '我的书.md'),
    text = Buffer.from('# 读取与保存\r\n')
  await writeFile(personal, text)
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void }
  child.pid = 1234
  child.unref = vi.fn()
  const spawn = vi.fn((): ChildProcess => {
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  })
  const dependencies = {
    realpath,
    resolveCurrentVersion: async () => ({
      directory: f.directory,
      manifestBytes: f.bytes,
      pointer: {
        version: 1 as const,
        releaseId,
        transactionId: '0a9fce4b-5259-4e94-a904-222222222222',
        manifestSha256: f.hash,
        appId: f.manifest.appId,
        appVersion: f.manifest.appVersion,
        executable: f.manifest.executable
      }
    }),
    verifyStagedRelease: verifyInstalledRelease,
    spawn
  }
  await expect(
    launchCurrentVersion({ installRoot: f.root, environment: {} }, dependencies)
  ).resolves.toMatchObject({ pid: 1234 })
  expect(spawn).toHaveBeenCalledOnce()
  expect(programManifestHash(await readFile(personal))).toBe(programManifestHash(text))
  await writeFile(join(f.directory, 'resources/app.asar'), 'damaged asar')
  await expect(
    launchCurrentVersion({ installRoot: f.root, environment: {} }, dependencies)
  ).rejects.toThrow('哈希')
  expect(spawn).toHaveBeenCalledOnce()
  expect(await readFile(personal)).toEqual(text)
})
