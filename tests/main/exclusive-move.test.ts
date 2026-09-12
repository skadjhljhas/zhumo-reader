import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, realpath, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as publication from '../../src/main/exclusive-move'
import { physicalFs } from '../../src/main/physical-fs'
import { rememberManagedVersion } from '../../src/main/managed-programs'
import {
  createProgramManifest,
  programManifestHash,
  retireProgramFiles,
  restoreRetiredProgramFiles
} from '../../src/main/program-files'
import { restoreWithdrawnShortcuts } from '../../src/main/setup-shortcuts'

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 })
const roots: string[] = []
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-exclusive-move-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-exclusive-move-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
it('publishes independently on Windows, including long Unicode paths, without overwriting an existing target', async () => {
  let dir = await folder()
  for (let i = 0; i < 7; i++) dir = join(dir, '光与文字 & 阅读空间-' + '长路径'.repeat(9))
  await mkdir(dir, { recursive: true })
  const source = join(dir, '来源.tmp'),
    target = join(dir, '结果.json')
  await writeFile(source, '完整的原子发布')
  await publication.moveFileExclusive(source, target)
  expect(await readFile(target, 'utf8')).toBe('完整的原子发布')
  expect((await lstat(target)).nlink).toBe(1)
  await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(source, '新的内容')
  await expect(publication.moveFileExclusive(source, target)).rejects.toThrow('发布未完成')
  expect(await readFile(target, 'utf8')).toBe('完整的原子发布')
  expect(await readFile(source, 'utf8')).toBe('新的内容')
})
it('never publishes a partial final ownership record, and a later retry can finish', async () => {
  const root = await folder(),
    id = randomUUID()
  const pointer = {
    version: 1 as const,
    releaseId: id,
    transactionId: id,
    manifestSha256: 'a'.repeat(64),
    appId: 'fixture',
    appVersion: '1',
    executable: 'ZhuMo.exe',
    profile: join(root, 'profile')
  }
  const native = physicalFs.open.bind(physicalFs)
  const spy = vi.spyOn(physicalFs, 'open').mockImplementation(async (...args) => {
    const handle = await native(...args)
    if (String(args[0]).includes('version-records') && args[1] === 'wx') {
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (data) => {
        await write(String(data).slice(0, 2))
        throw Error('fixture interrupted write')
      }
    }
    return handle
  })
  await expect(rememberManagedVersion(root, pointer)).rejects.toThrow('interrupted write')
  spy.mockRestore()
  const final = join(root, '.zhumo/version-records', id + '.json')
  await expect(lstat(final)).rejects.toMatchObject({ code: 'ENOENT' })
  await rememberManagedVersion(root, pointer)
  expect(JSON.parse(await readFile(final, 'utf8'))).toEqual(pointer)
  expect((await lstat(final)).nlink).toBe(1)
  await expect(rememberManagedVersion(root, { ...pointer, appVersion: 'another' })).rejects.toThrow(
    '内容不同'
  )
})
it('can retry program restoration if the helper stops after native publication but before its journal checkpoint', async () => {
  const root = await folder(),
    program = join(root, 'program'),
    saved = join(root, 'saved')
  await mkdir(join(program, 'resources'), { recursive: true })
  await writeFile(join(program, 'ZhuMo.exe'), 'original executable')
  await writeFile(join(program, 'resources/app.asar'), 'original package')
  const manifest = JSON.stringify(
    await createProgramManifest(
      program,
      { appId: 'fixture', appVersion: '1', executable: 'ZhuMo.exe' },
      ['ZhuMo.exe', 'resources/app.asar']
    )
  )
  const hash = programManifestHash(manifest)
  await writeFile(join(program, 'program-files.v1.json'), manifest)
  await retireProgramFiles(program, manifest, hash, saved)
  const move = publication.moveFileExclusive
  vi.spyOn(publication, 'moveFileExclusive').mockImplementationOnce(async (from, to) => {
    await move(from, to)
    throw Error('fixture stopped after publication')
  })
  expect((await restoreRetiredProgramFiles(program, manifest, hash, saved)).conflicts).not.toEqual(
    []
  )
  vi.restoreAllMocks()
  expect((await restoreRetiredProgramFiles(program, manifest, hash, saved)).conflicts).toEqual([])
  expect(await readFile(join(program, 'ZhuMo.exe'), 'utf8')).toBe('original executable')
  expect((await lstat(join(program, 'ZhuMo.exe'))).nlink).toBe(1)
})
it('can retry shortcut restoration after publication without leaving a second hardlink', async () => {
  const root = await folder(),
    path = join(root, 'reader.lnk'),
    temporary = join(root, '.owned.tmp'),
    backup = join(root, 'backup.lnk')
  await writeFile(temporary, 'original shortcut')
  await writeFile(backup, 'original shortcut')
  const { createHash } = await import('node:crypto')
  const entry = {
    path,
    temporary,
    backup,
    sha256: createHash('sha256').update('original shortcut').digest('hex')
  }
  const move = publication.moveFileExclusive
  vi.spyOn(publication, 'moveFileExclusive').mockImplementationOnce(async (from, to) => {
    await move(from, to)
    throw Error('fixture stopped after publication')
  })
  await expect(restoreWithdrawnShortcuts([entry])).rejects.toThrow('stopped after publication')
  vi.restoreAllMocks()
  await restoreWithdrawnShortcuts([entry])
  expect(await readFile(path, 'utf8')).toBe('original shortcut')
  expect((await lstat(path)).nlink).toBe(1)
  expect((await readdir(dirname(path))).includes('.owned.tmp')).toBe(false)
})
