import { afterEach, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { lstatSync } from 'node:fs'
import { productIdentity } from '../../src/main/product-identity'
import {
  discoverProfiles,
  profileSelectionFile,
  ProfileSelectionCancelled,
  selectReaderProfile
} from '../../src/main/profile-selection'

const roots: string[] = []
const stable = productIdentity({ zhumoChannel: 'stable' })
it('can reopen the same profile after its publishing process exits before any cleanup step', () => {
  const root = fixture(),
    path = data(root, 'ZhuMo-AI-preview'),
    file = profileSelectionFile(root, stable.appId)
  mkdirSync(resolve(file, '..'), { recursive: true })
  const temp = file + '.owned.tmp',
    info = lstatSync(path, { bigint: true })
  writeFileSync(
    temp,
    JSON.stringify({
      version: 1,
      appId: stable.appId,
      path,
      dev: info.dev.toString(),
      ino: info.ino.toString()
    })
  )
  const worker = join(root, 'publisher.mjs')
  writeFileSync(
    worker,
    `import {moveFileExclusiveSync} from ${JSON.stringify(pathToFileURL(resolve('src/main/exclusive-move.ts')).href)};moveFileExclusiveSync(process.argv[2],process.argv[3]);process.exit(69);`
  )
  const result = spawnSync(process.execPath, ['--experimental-strip-types', worker, temp, file], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8'
  })
  expect(result.status, result.stderr).toBe(69)
  expect(lstatSync(file).nlink).toBe(1)
  expect(existsSync(temp)).toBe(false)
  expect(selectReaderProfile({ appData: root, product: stable })).toBe(path)
  expect(readFileSync(join(path, 'settings.json'), 'utf8')).toBe('{"fontSize":27}')
})
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhumo-profile-choice-'))
  roots.push(root)
  return root
}
function data(root: string, folder: string): string {
  const path = join(root, folder)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'settings.json'), '{"fontSize":27}')
  return realpathSync(path)
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const part = relative(realpathSync(tmpdir()), realpathSync(root))
    expect(part.startsWith('zhumo-profile-choice-') && !part.includes('..')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
it('uses explicit product metadata and keeps preview profiles isolated', () => {
  expect(() => productIdentity({})).toThrow('产品身份')
  expect(() => productIdentity({ zhumoChannel: 'constructor' })).toThrow('产品身份')
  const root = fixture()
  data(root, 'zhumo')
  const preview = productIdentity({ zhumoChannel: 'preview-ai' })
  expect(selectReaderProfile({ appData: root, product: preview })).toBe(
    join(root, 'ZhuMo-AI-preview')
  )
  expect(existsSync(join(root, 'ZhuMo-AI-preview'))).toBe(false)
})
it('adopts the only populated profile whole and retains credentials, Chromium state and drafts byte for byte', () => {
  const root = fixture(),
    path = data(root, 'ZhuMo-AI-preview')
  const files = [
    'Local State',
    'ai-models.v1.json',
    'fonts/imported.otf',
    'IndexedDB/draft.bin',
    'Local Storage/leveldb/state'
  ]
  const bytes = Buffer.from([0, 255, 21, 88])
  for (const file of files) {
    const target = join(path, file)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, bytes)
  }
  const select = (): string => selectReaderProfile({ appData: root, product: stable })
  expect(select()).toBe(path)
  data(root, 'zhumo')
  expect(select()).toBe(path)
  for (const file of files) expect(readFileSync(join(path, file))).toEqual(bytes)
})
it('lets a reader choose among populated profiles once and never merges their files', () => {
  const root = fixture(),
    original = data(root, 'zhumo'),
    ai = data(root, 'ZhuMo-AI-preview')
  const picked = selectReaderProfile({
    appData: root,
    product: stable,
    choose: (choices) => {
      expect(choices.map((p) => p.label)).toContain('从新的阅读资料开始')
      return choices.findIndex((p) => p.path === ai)
    }
  })
  expect(picked).toBe(ai)
  expect(
    selectReaderProfile({
      appData: root,
      product: stable,
      choose: () => {
        throw Error('Must not ask twice')
      }
    })
  ).toBe(ai)
  expect(readFileSync(join(original, 'settings.json'), 'utf8')).toBe('{"fontSize":27}')
})
it('cancels without creating a new profile or selection record', () => {
  const root = fixture()
  data(root, 'zhumo')
  data(root, 'ZhuMo-AI-preview')
  expect(() =>
    selectReaderProfile({ appData: root, product: stable, choose: () => undefined })
  ).toThrow(ProfileSelectionCancelled)
  expect(existsSync(join(root, stable.profileFolder))).toBe(false)
  expect(existsSync(profileSelectionFile(root, stable.appId))).toBe(false)
})
it('does not silently fall back when a selected directory disappears or is replaced', () => {
  const root = fixture(),
    path = data(root, 'zhumo')
  selectReaderProfile({ appData: root, product: stable })
  expect(relative(root, realpathSync(path)).startsWith('..')).toBe(false)
  renameSync(path, path + '-preserved')
  expect(() => selectReaderProfile({ appData: root, product: stable })).toThrow('暂时不可用')
  mkdirSync(path)
  expect(() => selectReaderProfile({ appData: root, product: stable })).toThrow('已被替换')
})
it('refuses a directory swap during the choice and leaves the original profile intact', () => {
  const root = fixture(),
    path = data(root, 'zhumo')
  data(root, 'ZhuMo-AI-preview')
  expect(() =>
    selectReaderProfile({
      appData: root,
      product: stable,
      choose: (options) => {
        expect(relative(root, realpathSync(path)).startsWith('..')).toBe(false)
        renameSync(path, path + '-preserved')
        mkdirSync(path)
        return options.findIndex((option) => option.path === path)
      }
    })
  ).toThrow('选择期间')
  expect(existsSync(profileSelectionFile(root, stable.appId))).toBe(false)
})
it('honors a managed or test profile before reading global identity records', () => {
  const root = fixture(),
    explicit = join(root, 'isolated')
  expect(
    selectReaderProfile({
      appData: join(root, 'nonexistent'),
      product: stable,
      explicitProfile: explicit
    })
  ).toBe(explicit)
  expect(existsSync(explicit)).toBe(false)
})
it('creates a fresh profile when there are no user data markers and rejects a corrupt saved choice', () => {
  const root = fixture()
  mkdirSync(join(root, 'ZhuMo-AI-preview/GPUCache'), { recursive: true })
  expect(discoverProfiles(root)).toEqual([])
  expect(selectReaderProfile({ appData: root, product: stable })).toBe(
    realpathSync(join(root, stable.profileFolder))
  )
  writeFileSync(profileSelectionFile(root, stable.appId), '{}')
  expect(() => selectReaderProfile({ appData: root, product: stable })).toThrow('记录无效')
})
