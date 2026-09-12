import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import {
  installShortcuts,
  rollbackShortcuts,
  withdrawShortcuts,
  restoreWithdrawnShortcuts,
  rollbackShortcutAttempt
} from '../../src/main/setup-shortcuts'
import * as conditional from '../../src/main/conditional-delete'
import { rename } from 'node:fs/promises'
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 })
const roots: string[] = []
async function fixture(): Promise<Parameters<typeof installShortcuts>[0]> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-shortcut-test-'))
  roots.push(root)
  const install = join(root, '朱墨 & $原资料'),
    source = join(root, 'runtime'),
    work = join(root, 'work')
  for (const folder of [install, source, work]) await mkdir(folder)
  await writeFile(join(source, 'ZhuMo.exe'), 'program fixture, never executed')
  await mkdir(join(source, 'resources'))
  await writeFile(join(source, 'resources/app.asar'), 'application fixture')
  const manifest = await createProgramManifest(
    source,
    { appId: 'test.shortcuts', appVersion: '2.0', executable: 'ZhuMo.exe' },
    ['ZhuMo.exe', 'resources/app.asar']
  )
  const bytes = JSON.stringify(manifest)
  await writeFile(join(source, 'program-files.v1.json'), bytes)
  return {
    root: install,
    source,
    work,
    manifestHash: programManifestHash(bytes),
    appId: 'test.shortcuts',
    id: randomUUID(),
    options: {
      desktopDirectory: join(root, 'desktop'),
      menuDirectory: join(root, 'menu'),
      displayName: '朱墨测试'
    }
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-shortcut-test-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
it('preserves a new public shortcut atomically substituted just before withdrawal', async () => {
  const input = await fixture(),
    record = await installShortcuts(input)
  const desktop = record.entries.find((entry) => entry.kind === 'desktop')!
  const native = conditional.deleteOwnedFile
  let substituted = false
  vi.spyOn(conditional, 'deleteOwnedFile').mockImplementation(async (path, identity, hash) => {
    if (path === desktop.path && !substituted) {
      substituted = true
      await rename(path, path + '.old')
      await writeFile(path, 'user replaced this shortcut at the last moment')
    }
    return native(path, identity, hash)
  })
  await rollbackShortcutAttempt(input)
  expect(substituted).toBe(true)
  expect(await readFile(desktop.path, 'utf8')).toBe(
    'user replaced this shortcut at the last moment'
  )
})
it('rejects unsupported target media before creating directories, records or public shortcuts', async () => {
  const input = await fixture()
  const beforeRoot = await readdir(input.root),
    beforeWork = await readdir(input.work)
  vi.spyOn(conditional, 'assertOwnedDeletionSupported').mockRejectedValue(
    Error('fixture unsupported volume')
  )
  await expect(installShortcuts(input)).rejects.toThrow('unsupported volume')
  await expect(readdir(input.options.desktopDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(input.options.menuDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(input.root)).toEqual(beforeRoot)
  expect(await readdir(input.work)).toEqual(beforeWork)
})
it('creates Windows shortcuts once and reuses their exact bytes on the next install', async () => {
  const input = await fixture(),
    first = await installShortcuts(input)
  expect(first.entries).toHaveLength(2)
  for (const entry of first.entries) {
    const bytes = await readFile(entry.path)
    expect(bytes.readUInt32LE(0)).toBe(0x4c)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
  }
  const second = await installShortcuts({ ...input, id: randomUUID(), previousId: first.id })
  expect(second.entries.every((e) => !e.created)).toBe(true)
  expect(second.entries.map((e) => e.path)).toEqual(first.entries.map((e) => e.path))
  expect(await readdir(input.options.desktopDirectory)).toHaveLength(1)
  await rollbackShortcuts(second)
  expect(await readdir(input.options.desktopDirectory)).toHaveLength(1)
})
it('preserves a user-modified shortcut and creates only one new alternative for subsequent upgrades', async () => {
  const input = await fixture(),
    first = await installShortcuts(input)
  const personal = first.entries.find((e) => e.kind === 'desktop')!.path
  await writeFile(personal, 'user customized this shortcut')
  const second = await installShortcuts({ ...input, id: randomUUID(), previousId: first.id })
  expect(await readFile(personal, 'utf8')).toBe('user customized this shortcut')
  expect(second.entries.find((e) => e.kind === 'desktop')!.path).not.toBe(personal)
  const third = await installShortcuts({ ...input, id: randomUUID(), previousId: second.id })
  expect(third.entries.every((e) => !e.created)).toBe(true)
  expect(await readdir(input.options.desktopDirectory)).toHaveLength(2)
  await rollbackShortcuts(second)
  expect(await readFile(personal, 'utf8')).toBe('user customized this shortcut')
  expect(await readdir(input.options.desktopDirectory)).toHaveLength(1)
})
it('does not overwrite an unrelated existing default link or delete a changed new link on rollback', async () => {
  const input = await fixture()
  await mkdir(input.options.desktopDirectory)
  const existing = join(input.options.desktopDirectory, '朱墨测试.lnk')
  await writeFile(existing, 'unrelated shortcut')
  const record = await installShortcuts(input),
    newLink = record.entries.find((e) => e.kind === 'desktop')!.path
  await writeFile(newLink, 'changed after creation')
  await rollbackShortcuts(record)
  expect(await readFile(existing, 'utf8')).toBe('unrelated shortcut')
  expect(await readFile(newLink, 'utf8')).toBe('changed after creation')
})
it('rejects incomplete ownership metadata before writing new desktop entries', async () => {
  const input = await fixture(),
    first = await installShortcuts(input)
  await writeFile(
    join(input.root, '.zhumo/shortcut-records', first.id + '.json'),
    JSON.stringify({ ...first, appId: 'a different product' })
  )
  await expect(
    installShortcuts({ ...input, id: randomUUID(), previousId: first.id })
  ).rejects.toThrow('不一致')
  expect(await readdir(input.options.desktopDirectory)).toHaveLength(1)
})
it('withdraws reused owned entries, preserves modified links and can restore the removed entry', async () => {
  const input = await fixture(),
    first = await installShortcuts(input)
  const second = await installShortcuts({ ...input, id: randomUUID(), previousId: first.id })
  const desktop = second.entries.find((e) => e.kind === 'desktop')!.path
  const menu = second.entries.find((e) => e.kind === 'menu')!.path
  const originalMenu = await readFile(menu)
  await writeFile(desktop, 'user customized, must remain')
  const removed = await withdrawShortcuts(second, input.work)
  expect(removed.map((e) => e.path)).toEqual([menu])
  expect(await readdir(input.options.menuDirectory)).toEqual([])
  expect(await readFile(desktop, 'utf8')).toBe('user customized, must remain')
  await restoreWithdrawnShortcuts(removed)
  expect(await readFile(menu)).toEqual(originalMenu)
})
