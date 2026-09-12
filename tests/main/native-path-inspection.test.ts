import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { nativeFileHelper, inspectNativePathAttributes } from '../../src/main/native-file-helper'
const roots: string[] = []
async function isolatedCode(root: string): Promise<string> {
  const code = join(root, 'isolated/src/main')
  await mkdir(code, { recursive: true })
  for (const name of ['native-file-helper', 'current-version'])
    await build({
      entryPoints: [resolve(`src/main/${name}.ts`)],
      outfile: join(code, name + '.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  return code
}
async function fixture(): Promise<{ root: string; folder: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-native-inspection-'))
  roots.push(root)
  let folder = root
  for (let i = 0; i < 4; i++) folder = join(folder, '目录 & ' + '长路径'.repeat(15))
  await mkdir(folder, { recursive: true })
  const file = join(folder, '元数据.json')
  await writeFile(file, '{"kept":true}')
  return { root, folder, file }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-native-inspection-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
it('uses the helper beside code, not a changed working directory, and inspects long paths read-only', async () => {
  const { root, folder, file } = await fixture(),
    helper = nativeFileHelper()
  expect(helper).toMatch(/out[\\/]main[\\/]native[\\/]ConditionalDelete.exe$/)
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
  expect(nativeFileHelper()).toBe(helper)
  expect(await inspectNativePathAttributes([folder, file])).toBe(true)
  cwd.mockRestore()
  expect(await readFile(file, 'utf8')).toBe('{"kept":true}')
})
it('rejects a reparse leaf and a normal file reached through an aliased ancestor', async () => {
  const { root, folder, file } = await fixture(),
    alias = join(root, 'alias')
  await symlink(folder, alias, 'junction')
  await expect(inspectNativePathAttributes([alias])).rejects.toThrow('重解析')
  await expect(inspectNativePathAttributes([join(alias, '元数据.json')])).rejects.toThrow('重解析')
  expect(await readFile(file, 'utf8')).toBe('{"kept":true}')
})
it('retains the existing verified fallback when a standalone code copy has no native helper', async () => {
  const { root, folder } = await fixture(),
    code = await isolatedCode(root)
  const require = createRequire(import.meta.url)
  const helper = require(
    join(code, 'native-file-helper.cjs')
  ) as typeof import('../../src/main/native-file-helper')
  const current = require(
    join(code, 'current-version.cjs')
  ) as typeof import('../../src/main/current-version')
  expect(helper.nativeFileHelper()).toBeUndefined()
  expect(await helper.inspectNativePathAttributes([folder])).toBe(false)
  await expect(current.assertPlainDirectory(root)).resolves.toBeUndefined()
})
it('uses the verified fallback with the real legacy helper and still rejects junctions', async () => {
  const { root, folder, file } = await fixture(),
    code = await isolatedCode(root),
    native = join(code, 'native'),
    executable = join(native, 'ConditionalDelete.exe')
  await mkdir(native)
  await promisify(execFile)(
    join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      '/reference:System.Web.Extensions.dll',
      '/out:' + executable,
      resolve('tests/fixtures/native-legacy/ConditionalDelete-30aaa6f.cs')
    ],
    { windowsHide: true, shell: false, timeout: 15000 }
  )
  const require = createRequire(import.meta.url)
  const helper = require(
    join(code, 'native-file-helper.cjs')
  ) as typeof import('../../src/main/native-file-helper')
  const current = require(
    join(code, 'current-version.cjs')
  ) as typeof import('../../src/main/current-version')
  expect(helper.nativeFileHelper()).toBe(executable)
  expect(await helper.inspectNativePathAttributes([root])).toBe(false)
  await expect(current.assertPlainDirectory(root)).resolves.toBeUndefined()
  const alias = join(root, 'legacy-alias')
  await symlink(folder, alias, 'junction')
  await expect(current.assertPlainDirectory(alias)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('{"kept":true}')
})
