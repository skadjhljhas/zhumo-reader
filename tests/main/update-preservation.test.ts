import { afterEach, it, expect } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  realpath,
  stat
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPreservationSnapshot,
  restorePreservationSnapshot,
  verifyPreservationSnapshot
} from '../../src/main/update-preservation'

const roots: string[] = []
async function fixture(): Promise<{
  root: string
  install: string
  profile: string
  snapshot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-update-'))
  roots.push(root)
  const install = join(root, '朱墨 旧版本'),
    profile = join(root, '旧配置')
  await mkdir(join(install, '文稿', '嵌套 空格'), { recursive: true })
  await mkdir(join(install, '空目录'))
  await mkdir(join(profile, 'Local Storage', 'leveldb'), { recursive: true })
  await writeFile(join(install, 'ZhuMo.exe'), Buffer.from([0, 1, 2, 3]))
  await writeFile(
    join(install, '文稿', '嵌套 空格', '原稿.md'),
    Buffer.from('\uFEFF# 原稿\r\n\r\n文字[^一]\r\n\r\n[^一]: 旁注\r\n')
  )
  await writeFile(join(install, '用户自放的图片.bin'), Buffer.from([255, 0, 9, 40, 128]))
  await writeFile(join(profile, 'settings.json'), '{"fontSize":23}')
  await writeFile(join(profile, 'Local State'), '{"os_crypt":{"encrypted_key":"fixture-cipher"}}')
  await writeFile(
    join(profile, 'ai-models.v1.json'),
    '{"version":1,"syntax":{"cipher":"fixture-key-cipher"}}'
  )
  await writeFile(
    join(profile, 'Local Storage', 'leveldb', '000001.ldb'),
    Buffer.from([12, 0, 8, 16])
  )
  return { root, install, profile, snapshot: join(root, '升级保存点') }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Never recurse into anything but this test's directly created temporary workspace.
    const actual = await realpath(root),
      rel = relative(await realpath(tmpdir()), actual)
    if (!rel.startsWith('zhumo-update-') || rel.includes('..')) throw Error('Unsafe test cleanup')
    await rm(actual, { recursive: true, force: true, maxRetries: 5 })
  }
})
it('preserves Windows named streams through snapshot and restored files', async () => {
  if (process.platform !== 'win32') return
  const f = await fixture(),
    path = join(f.install, '文稿/嵌套 空格/原稿.md')
  await writeFile(path + ':fixture-annotation', 'named stream to retain')
  await createPreservationSnapshot([f.install, f.profile], f.snapshot)
  const [install] = await restorePreservationSnapshot(f.snapshot, join(f.root, '恢复命名流'))
  expect(
    await readFile(join(install, '文稿/嵌套 空格/原稿.md') + ':fixture-annotation', 'utf8')
  ).toBe('named stream to retain')
})
it('recovers every original byte including BOM/CRLF, settings, encryption context, LevelDB and unknown assets after removal of an old installation', async () => {
  const f = await fixture()
  await createPreservationSnapshot([f.install, f.profile], f.snapshot)
  const manifest = await verifyPreservationSnapshot(f.snapshot)
  expect(manifest.roots).toHaveLength(2)
  const originalMtime = (await stat(join(f.install, '文稿/嵌套 空格/原稿.md'))).mtimeMs
  // A disposable legacy installation models a recursive old-uninstaller deletion.
  expect(resolve(f.install).startsWith(resolve(f.root) + '\\')).toBe(process.platform === 'win32')
  await rm(f.install, { recursive: true })
  await rm(f.profile, { recursive: true })
  const [install, profile] = await restorePreservationSnapshot(f.snapshot, join(f.root, '恢复'))
  expect(await readFile(join(install, '文稿/嵌套 空格/原稿.md'), 'utf8')).toBe(
    '\uFEFF# 原稿\r\n\r\n文字[^一]\r\n\r\n[^一]: 旁注\r\n'
  )
  expect(await readFile(join(install, '用户自放的图片.bin'))).toEqual(
    Buffer.from([255, 0, 9, 40, 128])
  )
  expect(await readdir(join(install, '空目录'))).toEqual([])
  expect(
    Math.abs((await stat(join(install, '文稿/嵌套 空格/原稿.md'))).mtimeMs - originalMtime)
  ).toBeLessThan(1)
  expect(await readFile(join(profile, 'Local State'), 'utf8')).toContain('fixture-cipher')
  expect(await readFile(join(profile, 'ai-models.v1.json'), 'utf8')).toContain('fixture-key-cipher')
  expect(await readFile(join(profile, 'settings.json'), 'utf8')).toContain('23')
  expect(await readFile(join(profile, 'Local Storage/leveldb/000001.ldb'))).toEqual(
    Buffer.from([12, 0, 8, 16])
  )
})
it('concurrent saves cannot overwrite each other, and a cancelled restore never publishes a recovery tree', async () => {
  const f = await fixture()
  const attempts = await Promise.allSettled([
    createPreservationSnapshot([f.install], f.snapshot),
    createPreservationSnapshot([f.install], f.snapshot)
  ])
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  await verifyPreservationSnapshot(f.snapshot)
  const abort = new AbortController()
  abort.abort()
  await expect(
    restorePreservationSnapshot(f.snapshot, join(f.root, '恢复'), { signal: abort.signal })
  ).rejects.toThrow()
  await expect(stat(join(f.root, '恢复'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.install, 'ZhuMo.exe'))).toEqual(Buffer.from([0, 1, 2, 3]))
})
it('captures junction targets as a finite graph and restores links away from live user data, even with a cycle', async () => {
  const f = await fixture(),
    external = join(f.root, '外部文稿')
  await mkdir(external)
  await writeFile(join(external, '散文.md'), '外部原稿')
  await symlink(external, join(f.install, '外部库'), 'junction')
  await symlink(f.install, join(external, '返回'), 'junction')
  await createPreservationSnapshot([f.install, f.profile], f.snapshot)
  expect((await verifyPreservationSnapshot(f.snapshot)).roots).toHaveLength(3)
  const [install, , restoredExternal] = await restorePreservationSnapshot(
    f.snapshot,
    join(f.root, '恢复')
  )
  expect(await realpath(join(install, '外部库'))).toBe(await realpath(restoredExternal))
  expect(await realpath(join(restoredExternal, '返回'))).toBe(await realpath(install))
  await writeFile(join(install, '外部库/散文.md'), '只改变恢复副本')
  expect(await readFile(join(external, '散文.md'), 'utf8')).toBe('外部原稿')
})
it('does not publish a save point when a source is changed or a file is added during capture', async () => {
  for (const add of [false, true]) {
    const f = await fixture()
    let mutation: Promise<void> | undefined
    await expect(
      createPreservationSnapshot([f.install, f.profile], f.snapshot, {
        progress: () => {
          mutation ??= writeFile(join(f.install, add ? '新增.md' : 'ZhuMo.exe'), 'changed')
        }
      })
    ).rejects.toThrow('改变')
    await mutation
    await expect(stat(join(f.snapshot, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profile, 'settings.json'), 'utf8')).toContain('23')
  }
})
it('cancellation leaves original files intact and incomplete work cannot be verified or restored', async () => {
  const f = await fixture(),
    abort = new AbortController()
  await expect(
    createPreservationSnapshot([f.install, f.profile], f.snapshot, {
      signal: abort.signal,
      progress: () => abort.abort()
    })
  ).rejects.toThrow()
  await expect(verifyPreservationSnapshot(f.snapshot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.install, 'ZhuMo.exe'))).toEqual(Buffer.from([0, 1, 2, 3]))
})
it('never overwrites an existing recovery destination or accepts a modified payload', async () => {
  const f = await fixture(),
    recovered = join(f.root, '恢复')
  await createPreservationSnapshot([f.install, f.profile], f.snapshot)
  await mkdir(recovered)
  await writeFile(join(recovered, '原有.md'), '原有内容')
  await expect(restorePreservationSnapshot(f.snapshot, recovered)).rejects.toThrow('已存在')
  expect(await readFile(join(recovered, '原有.md'), 'utf8')).toBe('原有内容')
  await writeFile(join(f.snapshot, 'payload/0/ZhuMo.exe'), '破损')
  await expect(restorePreservationSnapshot(f.snapshot, join(f.root, '另一个恢复'))).rejects.toThrow(
    '校验失败'
  )
  await expect(stat(join(f.root, '另一个恢复'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects a backup inside its source, including an alias, and a broken source link', async () => {
  const f = await fixture()
  await expect(createPreservationSnapshot([f.install], join(f.install, '保存点'))).rejects.toThrow(
    '自身'
  )
  const alias = join(f.root, '安装别名')
  await symlink(f.install, alias, 'junction')
  await expect(createPreservationSnapshot([f.install], join(alias, '保存点'))).rejects.toThrow(
    '自身'
  )
  await symlink(join(f.root, '不存在'), join(f.install, '失联文稿'), 'junction')
  await expect(createPreservationSnapshot([f.install], f.snapshot)).rejects.toMatchObject({
    code: 'ENOENT'
  })
  await expect(stat(join(f.snapshot, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refuses manifest traversal, missing link targets and reparse-point substitution in stored payload', async () => {
  const f = await fixture()
  await createPreservationSnapshot([f.install], f.snapshot)
  const manifestPath = join(f.snapshot, 'manifest.json'),
    original = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(original)
  manifest.roots[0].entries.push({
    kind: 'file',
    path: '../escape.md',
    size: 0,
    sha256: '0'.repeat(64)
  })
  await writeFile(manifestPath, JSON.stringify(manifest))
  await expect(verifyPreservationSnapshot(f.snapshot)).rejects.toThrow('相对路径')
  manifest.roots[0].entries.pop()
  manifest.roots[0].entries.push({
    kind: 'link',
    path: '逃逸',
    resolved: f.root,
    targetKind: 'directory'
  })
  await writeFile(manifestPath, JSON.stringify(manifest))
  await expect(verifyPreservationSnapshot(f.snapshot)).rejects.toThrow('缺少链接目标')
  await writeFile(manifestPath, original)
  const payload = join(f.snapshot, 'payload/0/文稿')
  expect(relative(f.root, payload).startsWith('升级保存点')).toBe(true)
  await rm(payload, { recursive: true })
  await symlink(join(f.install, '文稿'), payload, 'junction')
  await expect(verifyPreservationSnapshot(f.snapshot)).rejects.toThrow('目录类型')
})
