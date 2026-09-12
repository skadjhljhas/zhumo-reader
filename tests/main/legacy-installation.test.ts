import { expect, it } from 'vitest'
import { resolve, join } from 'node:path'
import { assertOutsideLegacyInstall } from '../../src/main/legacy-installation'
import type { Registration } from '../../src/main/setup-registry'
it('checks an all-users installation even when the current-user hive has no original install', async () => {
  const root = resolve('work/legacy-all-users-fixture')
  const read = async (): Promise<Registration[]> => [
    { exists: false, values: [], subkeys: [] },
    {
      exists: true,
      subkeys: [],
      values: [
        {
          name: 'UninstallString',
          kind: 'String',
          value: '"' + join(root, 'Uninstall ZhuMo.exe') + '" /allusers'
        }
      ]
    }
  ]
  for (const target of [root, join(root, 'new'), resolve(root, '..')])
    await expect(assertOutsideLegacyInstall(target, read)).rejects.toThrow('独立目录')
  await expect(assertOutsideLegacyInstall(root + '-v2', read)).resolves.toBeUndefined()
})

it('refuses overlap with a registered original installer without calling that uninstaller', async () => {
  const root = resolve('work/legacy-placement-fixture')
  const record: Registration = {
    exists: true,
    subkeys: [],
    values: [
      { name: 'InstallLocation', kind: 'String', value: root },
      { name: 'UninstallString', kind: 'String', value: 'must never execute' }
    ]
  }
  for (const target of [root, join(root, 'new'), resolve(root, '..')])
    await expect(assertOutsideLegacyInstall(target, async () => record)).rejects.toThrow('独立目录')
  await expect(
    assertOutsideLegacyInstall(root + '-v2', async () => record)
  ).resolves.toBeUndefined()
})
it('requires an identifiable legacy location and permits a new product when no legacy registration exists', async () => {
  const target = resolve('work/new-product-fixture')
  await expect(
    assertOutsideLegacyInstall(target, async () => ({ exists: true, values: [], subkeys: [] }))
  ).rejects.toThrow('位置记录不完整')
  await expect(
    assertOutsideLegacyInstall(target, async () => ({ exists: false, values: [], subkeys: [] }))
  ).resolves.toBeUndefined()
})
it('recognizes an original NSIS 1.1.x registration that only contains a quoted uninstall path', async () => {
  const root = resolve('work/legacy-original-fixture')
  const read = async (): Promise<Registration> => ({
    exists: true,
    subkeys: [],
    values: [
      {
        name: 'UninstallString',
        kind: 'String',
        value: '"' + join(root, 'Uninstall ZhuMo.exe') + '" /currentuser'
      }
    ]
  })
  await expect(assertOutsideLegacyInstall(join(root, 'new'), read)).rejects.toThrow('独立目录')
  await expect(assertOutsideLegacyInstall(root + '-v2', read)).resolves.toBeUndefined()
})
