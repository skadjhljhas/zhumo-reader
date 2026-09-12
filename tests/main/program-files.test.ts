import { afterEach, it, expect } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  rm,
  symlink,
  rename,
  chmod
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProgramManifest,
  programManifestHash,
  readProgramManifest,
  auditProgramFiles,
  retireProgramFiles,
  restoreRetiredProgramFiles
} from '../../src/main/program-files'
import type { ProgramManifest } from '../../src/main/program-files'
const roots: string[] = []
async function fixture(): Promise<{
  root: string
  program: string
  saved: string
  originals: Map<string, Buffer>
  manifest: ProgramManifest
  bytes: string
  hash: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-owned-'))
  roots.push(root)
  const program = join(root, '朱墨'),
    saved = join(root, '可恢复程序')
  await mkdir(join(program, 'resources'), { recursive: true })
  await mkdir(join(program, 'locales'))
  const originals = new Map([
    ['ZhuMo.exe', Buffer.from([0, 1, 255, 9])],
    ['resources/app.asar', Buffer.from([8, 16, 0, 40])],
    ['resources/help.md', Buffer.from('# 随软件附带的帮助\r\n')],
    ['locales/en-US.pak', Buffer.from([4, 5, 6])]
  ])
  for (const [path, bytes] of originals) await writeFile(join(program, path), bytes)
  const manifest = await createProgramManifest(
    program,
    { appId: 'fixture.zhumo', appVersion: '2.0.0', executable: 'ZhuMo.exe' },
    [...originals.keys()]
  )
  const bytes = JSON.stringify(manifest),
    hash = programManifestHash(bytes)
  await writeFile(join(program, 'program-files.v1.json'), bytes)
  return { root, program, saved, originals, manifest, bytes, hash }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const actual = await realpath(root),
      rel = relative(await realpath(tmpdir()), actual)
    expect(rel.startsWith('zhumo-owned-') && !rel.includes('..')).toBe(true)
    await rm(actual, { recursive: true, force: true, maxRetries: 10 })
  }
})
it('retires only unchanged release files and restores them while keeping modified help, user MD, resources and links intact', async () => {
  const f = await fixture(),
    user = Buffer.from('\uFEFF# 用户原稿\r\n\r\n内容[^一]\r\n\r\n[^一]: 注释\r\n')
  await mkdir(join(f.program, '文稿'))
  await writeFile(join(f.program, '文稿/原稿.md'), user)
  await writeFile(join(f.program, 'notes.md'), user)
  await writeFile(join(f.program, 'resources/help.md'), '用户改写的帮助')
  await writeFile(join(f.program, 'resources/custom.bin'), user)
  const linked = join(f.root, '外部原稿')
  await mkdir(linked)
  await writeFile(join(linked, '原稿.md'), user)
  await symlink(linked, join(f.program, '文稿链接'), 'junction')
  const audit = await auditProgramFiles(f.program, f.bytes, f.hash)
  expect(audit.changed).toEqual(['resources/help.md'])
  expect(audit.unlisted).toEqual(
    expect.arrayContaining(['文稿', '文稿链接', 'notes.md', 'resources/custom.bin'])
  )
  const retired = await retireProgramFiles(f.program, f.bytes, f.hash, f.saved)
  expect(retired.retired).toHaveLength(3)
  await expect(stat(join(f.program, 'ZhuMo.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.program, 'resources/help.md'), 'utf8')).toBe('用户改写的帮助')
  expect(await readFile(join(f.program, '文稿/原稿.md'))).toEqual(user)
  expect(await readFile(join(linked, '原稿.md'))).toEqual(user)
  const recovered = await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)
  expect(recovered.conflicts).toEqual([])
  expect(recovered.restored).toHaveLength(3)
  expect(await readFile(join(f.program, 'ZhuMo.exe'))).toEqual(f.originals.get('ZhuMo.exe'))
  expect(await readFile(join(f.program, 'resources/help.md'), 'utf8')).toBe('用户改写的帮助')
  expect((await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts).toEqual(
    []
  )
})
it('rejects an untrusted manifest and ambiguous paths without touching the program', async () => {
  const f = await fixture()
  await expect(retireProgramFiles(f.program, f.bytes, '0'.repeat(64), f.saved)).rejects.toThrow(
    '受信校验'
  )
  for (const path of [
    '../原稿.md',
    'resources/x:stream',
    'NUL.md',
    'resources/trailing.',
    'resources\\escape.md'
  ]) {
    const data = JSON.stringify({
      ...f.manifest,
      files: [...f.manifest.files, { ...f.manifest.files[0], path }]
    })
    expect(() => readProgramManifest(data, programManifestHash(data))).toThrow('路径')
  }
  const repeated = JSON.stringify({
    ...f.manifest,
    files: [
      ...f.manifest.files,
      { ...f.manifest.files[0], path: f.manifest.files[0].path.toUpperCase() }
    ]
  })
  expect(() => readProgramManifest(repeated, programManifestHash(repeated))).toThrow('重复')
  expect(await readFile(join(f.program, 'ZhuMo.exe'))).toEqual(f.originals.get('ZhuMo.exe'))
})
it('refuses a build stage that contains undeclared private files instead of calling them program files', async () => {
  const f = await fixture()
  await writeFile(join(f.program, '个人日记.md'), 'private')
  await expect(
    createProgramManifest(f.program, f.manifest, [...f.originals.keys()])
  ).rejects.toThrow('未声明')
  expect(await readFile(join(f.program, '个人日记.md'), 'utf8')).toBe('private')
})
it('does not retire a matching-looking installation without its pinned identity or merge rollback into a new version', async () => {
  const f = await fixture()
  await rename(join(f.program, 'program-files.v1.json'), join(f.root, 'identity-kept.json'))
  await expect(retireProgramFiles(f.program, f.bytes, f.hash, f.saved)).rejects.toThrow('发行身份')
  expect(await readFile(join(f.program, 'ZhuMo.exe'))).toEqual(f.originals.get('ZhuMo.exe'))
  await rename(join(f.root, 'identity-kept.json'), join(f.program, 'program-files.v1.json'))
  await retireProgramFiles(f.program, f.bytes, f.hash, f.saved)
  await writeFile(
    join(f.program, 'program-files.v1.json'),
    JSON.stringify({ ...f.manifest, appVersion: 'new-version' })
  )
  await expect(restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).rejects.toThrow(
    '切换版本'
  )
  expect(await readFile(join(f.saved, 'files/ZhuMo.exe'))).toEqual(f.originals.get('ZhuMo.exe'))
})
it('does not follow a replacement junction through an owned path', async () => {
  const f = await fixture(),
    external = join(f.root, '外部资源')
  await rename(join(f.program, 'resources'), external)
  await symlink(external, join(f.program, 'resources'), 'junction')
  const audit = await auditProgramFiles(f.program, f.bytes, f.hash)
  expect(audit.linked).toEqual(expect.arrayContaining(['resources/app.asar', 'resources/help.md']))
  await retireProgramFiles(f.program, f.bytes, f.hash, f.saved)
  expect(await readFile(join(external, 'app.asar'))).toEqual(f.originals.get('resources/app.asar'))
  expect(await realpath(join(f.program, 'resources'))).toBe(await realpath(external))
})
it('rechecks the fingerprint just before each move and leaves a newly modified file in place', async () => {
  const f = await fixture(),
    changed = f.manifest.files[1].path
  let mutated = false
  const result = await retireProgramFiles(f.program, f.bytes, f.hash, f.saved, async () => {
    if (!mutated) {
      mutated = true
      await writeFile(join(f.program, changed), 'Changed during retirement')
    }
  })
  expect(result.changed).toContain(changed)
  expect(result.retired).not.toContain(changed)
  expect(result.unchanged.map((f) => f.path)).not.toContain(changed)
  expect(await readFile(join(f.program, changed), 'utf8')).toBe('Changed during retirement')
})
it('automatically rolls back moved files on failure, preserving the recovery copies', async () => {
  const f = await fixture()
  await expect(
    retireProgramFiles(f.program, f.bytes, f.hash, f.saved, () => {
      throw Error('simulated failure')
    })
  ).rejects.toThrow('simulated failure')
  for (const [path, bytes] of f.originals)
    expect(await readFile(join(f.program, path))).toEqual(bytes)
  expect(JSON.parse(await readFile(join(f.saved, 'retirement.json'), 'utf8')).state).toBe(
    'rolled-back'
  )
  expect((await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts).toEqual(
    []
  )
})
it('never replaces a concurrent new file during rollback and supports recovery after the conflict is retained elsewhere', async () => {
  const f = await fixture(),
    path = f.manifest.files[0].path
  await expect(
    retireProgramFiles(f.program, f.bytes, f.hash, f.saved, async (moved) => {
      await writeFile(join(f.program, moved), 'New concurrent contents')
      throw Error('stop')
    })
  ).rejects.toThrow('stop')
  expect(await readFile(join(f.program, path), 'utf8')).toBe('New concurrent contents')
  expect(await readFile(join(f.saved, 'files', path))).toEqual(f.originals.get(path))
  expect((await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts).toEqual(
    [path]
  )
  await rename(join(f.program, path), join(f.program, '并发改动保留.md'))
  expect((await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts).toEqual(
    []
  )
  expect(await readFile(join(f.program, '并发改动保留.md'), 'utf8')).toBe('New concurrent contents')
})
it('recovers a move that finished just before a crash left its journal entry pending', async () => {
  const f = await fixture()
  await retireProgramFiles(f.program, f.bytes, f.hash, f.saved)
  const path = join(f.saved, 'retirement.json'),
    record = JSON.parse(await readFile(path, 'utf8'))
  record.state = 'moving'
  record.files.forEach((f) => {
    f.state = 'pending'
  })
  await writeFile(path, JSON.stringify(record))
  const result = await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)
  expect(result.conflicts).toEqual([])
  expect(result.restored).toHaveLength(3)
  for (const [path, bytes] of f.originals)
    expect(await readFile(join(f.program, path))).toEqual(bytes)
})
it('keeps even unchanged bundled Markdown in place and preserves Windows named streams when a program file is restored', async () => {
  const f = await fixture()
  if (process.platform === 'win32')
    await writeFile(join(f.program, 'ZhuMo.exe') + ':fixture-metadata', 'retained named stream')
  const result = await retireProgramFiles(f.program, f.bytes, f.hash, f.saved)
  expect(result.protectedDocuments).toContain('resources/help.md')
  expect(result.retired).not.toContain('resources/help.md')
  expect(await readFile(join(f.program, 'resources/help.md'))).toEqual(
    f.originals.get('resources/help.md')
  )
  await chmod(join(f.saved, 'files/ZhuMo.exe'), 0o444)
  expect((await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts).toEqual(
    []
  )
  if (process.platform === 'win32')
    expect(await readFile(join(f.program, 'ZhuMo.exe') + ':fixture-metadata', 'utf8')).toBe(
      'retained named stream'
    )
})
it('can repeatedly recover an intent written before any file was moved', async () => {
  const f = await fixture(),
    first = f.manifest.files[0],
    info = await stat(join(f.program, first.path))
  await mkdir(join(f.saved, 'files'), { recursive: true })
  await writeFile(
    join(f.saved, 'retirement.json'),
    JSON.stringify({
      version: 1,
      root: await realpath(f.program),
      manifestHash: f.hash,
      state: 'moving',
      files: [{ ...first, mode: info.mode & 0o777, mtimeMs: info.mtimeMs, state: 'pending' }],
      audit: await auditProgramFiles(f.program, f.bytes, f.hash)
    })
  )
  for (let i = 0; i < 2; i++)
    expect(
      (await restoreRetiredProgramFiles(f.program, f.bytes, f.hash, f.saved)).conflicts
    ).toEqual([])
  expect(await readFile(join(f.program, first.path))).toEqual(f.originals.get(first.path))
})
