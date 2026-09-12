import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  changeRegistration,
  readRegistration,
  sameRegistration,
  withRegistrationValues,
  validateRegistrationKey,
  recoverRegistration,
  type Registration
} from '../../src/main/setup-registry'

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 })
const cases: { key: string; work: string }[] = []
const empty: Registration = { exists: false, values: [], subkeys: [] }
async function fixture(): Promise<{ key: string; work: string }> {
  const item = {
    key: 'Software\\ZhuMoInstallerTests\\' + randomUUID(),
    work: await mkdtemp(join(tmpdir(), 'zhumo-registry-test-'))
  }
  cases.push(item)
  return item
}
afterEach(async () => {
  for (const { key, work } of cases.splice(0)) {
    expect(key).toMatch(/^Software\\ZhuMoInstallerTests\\[a-f0-9-]{36}$/)
    await changeRegistration({ key, before: await readRegistration(key), after: empty }, work)
    const path = relative(await realpath(tmpdir()), await realpath(work))
    expect(path.startsWith('zhumo-registry-test-') && !path.includes('..')).toBe(true)
    await rm(work, { recursive: true, force: true })
  }
})
it('writes real HKCU registration, retains native types and reverses the change', async () => {
  const { key, work } = await fixture()
  expect(await readRegistration(key)).toEqual(empty)
  const saved = withRegistrationValues(empty, [
    { name: 'DisplayName', kind: 'String', value: '朱墨 & 阅读' },
    { name: 'NoModify', kind: 'DWord', value: '1' },
    { name: 'PersonalBytes', kind: 'Binary', value: 'AP8Q' },
    { name: 'PersonalPaths', kind: 'MultiString', value: ['中文路径', '$HOME literal'] },
    { name: 'PersonalEnvironment', kind: 'ExpandString', value: '%APPDATA%\\User' },
    { name: 'PersonalInteger', kind: 'QWord', value: '9007199254740993' }
  ])
  await changeRegistration({ key, before: empty, after: saved }, work)
  expect(sameRegistration(await readRegistration(key), saved)).toBe(true)
  const next = withRegistrationValues(saved, [
    { name: 'DisplayName', kind: 'String', value: '新阅读器' }
  ])
  await changeRegistration({ key, before: saved, after: next }, work)
  expect(sameRegistration(await readRegistration(key), next)).toBe(true)
  await changeRegistration({ key, before: next, after: saved }, work)
  expect(sameRegistration(await readRegistration(key), saved)).toBe(true)
})
it('refuses stale registration and restores a real partially failed native write', async () => {
  const { key, work } = await fixture()
  const first = withRegistrationValues(empty, [
    { name: 'DisplayName', kind: 'String', value: '之前的登记' }
  ])
  await changeRegistration({ key, before: empty, after: first }, work)
  await expect(changeRegistration({ key, before: empty, after: first }, work)).rejects.toThrow(
    'changed'
  )
  const invalid = withRegistrationValues(first, [
    { name: 'DisplayName', kind: 'String', value: '这个先写入' },
    { name: 'NoModify', kind: 'DWord', value: 'invalid number forces a native write failure' }
  ])
  await expect(changeRegistration({ key, before: first, after: invalid }, work)).rejects.toThrow(
    '系统登记未完成'
  )
  expect(sameRegistration(await readRegistration(key), first)).toBe(true)
})
it('does not allow parent, foreign hive or arbitrary registry targets', () => {
  for (const key of [
    'Software',
    'HKLM\\Software\\ZhuMo',
    'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'Software\\ZhuMoInstallerTests\\..\\other'
  ])
    expect(() => validateRegistrationKey(key)).toThrow()
})
it('recovers a partially removed native registration while rejecting unrelated edits', async () => {
  const { key, work } = await fixture()
  const before = withRegistrationValues(empty, [
    { name: 'DisplayName', kind: 'String', value: '原登记' },
    { name: 'DisplayVersion', kind: 'String', value: '2.0' }
  ])
  const partial = withRegistrationValues(empty, [before.values[0]])
  await changeRegistration({ key, before: empty, after: partial }, work)
  await recoverRegistration({ key, before, after: empty }, work, 'before')
  expect(sameRegistration(await readRegistration(key), before)).toBe(true)
  const changed = withRegistrationValues(before, [
    { name: 'DisplayName', kind: 'String', value: '外部修改' }
  ])
  await changeRegistration({ key, before, after: changed }, work)
  await expect(recoverRegistration({ key, before, after: empty }, work, 'before')).rejects.toThrow(
    '以外的修改'
  )
  expect(sameRegistration(await readRegistration(key), changed)).toBe(true)
})
