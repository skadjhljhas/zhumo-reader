import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  realpath,
  rm,
  link,
  rename
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, dirname } from 'node:path'
import { symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  deleteOwnedFile,
  assertOwnedDeletionSupported,
  inspectDeletionDirectory
} from '../../src/main/conditional-delete'
vi.setConfig({ testTimeout: 30000 })
const roots: string[] = []
it('checks long native directory chains and distinguishes missing parents from linked paths', async () => {
  const f = await fixture()
  expect(await inspectDeletionDirectory(dirname(f.path))).toBe(true)
  expect(await inspectDeletionDirectory(join(f.root, 'missing/parent'))).toBe(false)
  const link = join(f.root, 'linked')
  await symlink(dirname(f.path), link, 'junction')
  await expect(inspectDeletionDirectory(link)).rejects.toThrow(/链接|重解析/)
})
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function fixture(): Promise<{
  root: string
  path: string
  identity: { dev: string; ino: string }
  hash: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-delete-owned-'))
  roots.push(root)
  let folder = root
  for (let i = 0; i < 5; i++) folder = join(folder, '中文 & 路径-' + '长路径'.repeat(10))
  await mkdir(folder, { recursive: true })
  const path = join(folder, '入口.lnk'),
    bytes = Buffer.from('owned file')
  await writeFile(path, bytes)
  const stat = await lstat(path, { bigint: true })
  return {
    root,
    path,
    identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
    hash: digest(bytes)
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-delete-owned-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
it('removes only the opened matching entity and supports long Unicode paths', async () => {
  const f = await fixture()
  await assertOwnedDeletionSupported(f.root)
  expect(await deleteOwnedFile(f.path, f.identity, f.hash)).toBe('deleted')
  await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await deleteOwnedFile(f.path, f.identity, f.hash)).toBe('missing')
})
it('preserves replacement objects, in-place edits and external hard links', async () => {
  const f = await fixture()
  await rename(f.path, f.path + '.original')
  await writeFile(f.path, 'new user content')
  expect(await deleteOwnedFile(f.path, f.identity, f.hash)).toBe('changed')
  expect(await readFile(f.path, 'utf8')).toBe('new user content')
  const current = await lstat(f.path, { bigint: true }),
    identity = { dev: current.dev.toString(), ino: current.ino.toString() }
  expect(await deleteOwnedFile(f.path, identity, f.hash)).toBe('changed')
  await link(f.path, f.path + '.user-link')
  expect(await deleteOwnedFile(f.path, identity, digest(Buffer.from('new user content')))).toBe(
    'changed'
  )
  expect(await readFile(f.path, 'utf8')).toBe('new user content')
})
it('refuses a matching file reached through a replaced intermediate directory', async () => {
  const f = await fixture(),
    parent = dirname(f.path),
    external = join(f.root, 'external')
  expect(relative(f.root, await realpath(parent)).startsWith('..')).toBe(false)
  await rename(parent, external)
  await symlink(external, parent, 'junction')
  await expect(deleteOwnedFile(f.path, f.identity, f.hash)).rejects.toThrow('Directory')
  expect(await readFile(join(external, '入口.lnk'), 'utf8')).toBe('owned file')
})
it('refuses a new ordinary directory even when the original file identity is moved back', async () => {
  const f = await fixture(),
    parent = dirname(f.path),
    old = parent + '-original',
    info = await lstat(parent, { bigint: true })
  expect(relative(f.root, await realpath(parent)).startsWith('..')).toBe(false)
  await rename(parent, old)
  await mkdir(parent)
  await rename(join(old, '入口.lnk'), f.path)
  await expect(
    deleteOwnedFile(f.path, f.identity, f.hash, [
      { path: parent, dev: info.dev.toString(), ino: info.ino.toString() }
    ])
  ).rejects.toThrow('directory was replaced')
  expect(await readFile(f.path, 'utf8')).toBe('owned file')
})
