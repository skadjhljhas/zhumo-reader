import { afterEach, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  unlink,
  rename,
  readdir,
  rm
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManuscriptLibrary } from '../src/main/manuscript-library'
const roots: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-library-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('keeps the canonical manuscript location across binary-directory changes and removal of a disposable junction', async () => {
  const root = await fixture(),
    profile = join(root, 'profile'),
    shared = join(root, '我的文稿'),
    old = join(root, '候选 19'),
    next = join(root, '候选 20')
  await mkdir(shared)
  await mkdir(old)
  await mkdir(profile)
  const original = Buffer.from(
    '\uFEFF# 原稿\r\n\r\n保留 **格式**[^甲]。\r\n\r\n[^甲]: 原注释。\r\n'
  )
  await writeFile(join(shared, '在世界与思想之间.md'), original)
  const protectedFiles = {
    'settings.json': '{"fontSize":23}',
    'Local State': '{"os_crypt":{"encrypted_key":"opaque-original"}}',
    'ai-models.v1.json': '{"version":1,"cipher":"opaque-cipher"}'
  }
  for (const [name, bytes] of Object.entries(protectedFiles))
    await writeFile(join(profile, name), bytes)
  const link = join(old, '文稿')
  await symlink(shared, link, 'junction')
  expect(await new ManuscriptLibrary(profile, old, root).resolve()).toBe(await realpath(shared))
  await unlink(link)
  expect(await new ManuscriptLibrary(profile, next, root).resolve()).toBe(await realpath(shared))
  expect(await readFile(join(shared, '在世界与思想之间.md'))).toEqual(original)
  for (const [name, bytes] of Object.entries(protectedFiles))
    expect(await readFile(join(profile, name), 'utf8')).toBe(bytes)
  await expect(readdir(next)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(shared)).toEqual(['在世界与思想之间.md'])
})
it('does not create an empty replacement when the old drive/path is unavailable, and supports explicit relocation', async () => {
  const root = await fixture(),
    profile = join(root, 'profile'),
    binary = join(root, 'old-program'),
    moved = join(root, '移动后的文稿')
  const first = new ManuscriptLibrary(profile, binary, root)
  const directory = await first.resolve()
  await writeFile(join(directory, 'draft.md'), '# 保留')
  await rename(directory, moved)
  const after = new ManuscriptLibrary(profile, join(root, 'new-program'), root)
  await expect(after.resolve()).rejects.toThrow('未创建替代目录')
  expect(await after.status()).toMatchObject({ path: directory, available: false })
  await expect(readdir(join(root, 'new-program'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await after.select(moved)).toMatchObject({ available: true, path: await realpath(moved) })
  expect(await after.resolve()).toBe(await realpath(moved))
  expect(await readFile(join(moved, 'draft.md'), 'utf8')).toBe('# 保留')
})
it('never overwrites a damaged binding without an explicit folder choice', async () => {
  const root = await fixture(),
    profile = join(root, 'profile'),
    selected = join(root, 'selected')
  await mkdir(profile)
  await mkdir(selected)
  const record = join(profile, 'manuscript-library.v1.json')
  await writeFile(record, 'damaged original')
  const library = new ManuscriptLibrary(profile, join(root, 'binary'), root)
  expect((await library.status()).available).toBe(false)
  expect(await readFile(record, 'utf8')).toBe('damaged original')
  await expect(library.resolve()).rejects.toThrow('位置记录损坏')
  await library.select(selected)
  expect(await new ManuscriptLibrary(profile, root, root).resolve()).toBe(await realpath(selected))
})
it('serializes initial resolution and explicit changes, leaving both directories intact', async () => {
  const root = await fixture(),
    selected = join(root, 'selected'),
    profile = join(root, 'profile')
  await mkdir(selected)
  await writeFile(join(selected, 'another.md'), '# 另一份')
  const library = new ManuscriptLibrary(profile, join(root, 'binary'), root)
  const first = library.resolve(),
    choose = library.select(selected),
    last = library.resolve()
  const original = await first
  await choose
  expect(await last).toBe(await realpath(selected))
  expect(await readdir(original)).toEqual([])
  expect(await readFile(join(selected, 'another.md'), 'utf8')).toBe('# 另一份')
})
