import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureManuscriptDirectory } from '../src/main/manuscript-directory'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-manuscripts-'))
  roots.push(root)
  return root
}
it('creates the program-side directory and preserves existing manuscripts when reopened', async () => {
  const root = await fixture()
  const folder = await ensureManuscriptDirectory(join(root, 'program'), join(root, 'documents'))
  expect(folder).toBe(join(root, 'program', '文稿'))
  expect((await stat(folder)).isDirectory()).toBe(true)
  await writeFile(join(folder, '已有.md'), '# 保留原稿')
  expect(await ensureManuscriptDirectory(join(root, 'program'), join(root, 'documents'))).toBe(
    folder
  )
  expect(await readFile(join(folder, '已有.md'), 'utf8')).toBe('# 保留原稿')
})
it('falls back to Documents/朱墨/文稿 if the program-side path cannot be created', async () => {
  const root = await fixture()
  await writeFile(join(root, 'blocked'), 'existing file')
  const folder = await ensureManuscriptDirectory(join(root, 'blocked'), join(root, 'documents'))
  expect(folder).toBe(join(root, 'documents', '朱墨', '文稿'))
  expect((await stat(folder)).isDirectory()).toBe(true)
})
