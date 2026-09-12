import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { ProductIdentity } from './product-identity'
import { moveFileExclusiveSync } from './exclusive-move'

export interface ProfileOption {
  path: string
  label: string
  fresh?: boolean
  dev?: string
  ino?: string
}
interface ProfileReference {
  version: 1
  appId: string
  path: string
  dev: string
  ino: string
}
export class ProfileSelectionCancelled extends Error {}
const knownProfiles = [
  ['zhumo', '原版朱墨'],
  ['ZhuMo-AI-preview', 'AI 细读预览'],
  ['ZhuMo-2.0-preview', '2.0 预览'],
  ['ZhuMo-Chaosheng-preview', '潮光预览'],
  ['ZhuMo-2.0', '朱墨 2.0']
] as const
// Detect user data without reading credentials or ranking profiles by cache timestamps.
const markers = [
  'settings.json',
  'recent.json',
  'manuscript-library.v1.json',
  'ai-models.v1.json',
  'Local Storage',
  'IndexedDB',
  'fonts'
]
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function identity(path: string): Omit<ProfileReference, 'version' | 'appId'> {
  const canonical = realpathSync(path),
    info = lstatSync(canonical, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('阅读资料位置不是普通文件夹。')
  return { path: canonical, dev: info.dev.toString(), ino: info.ino.toString() }
}
export function discoverProfiles(appData: string): ProfileOption[] {
  const profiles = new Map<string, ProfileOption>()
  for (const [folder, label] of knownProfiles) {
    const path = join(appData, folder)
    if (!present(path)) continue
    const actual = identity(path)
    if (!markers.some((name) => present(join(actual.path, name)))) continue
    profiles.set(actual.dev + ':' + actual.ino, { ...actual, label })
  }
  return [...profiles.values()]
}
export const profileSelectionFile = (appData: string, appId: string): string =>
  join(appData, 'ZhuMo-profile-bindings', appId + '.json')
function readSelection(file: string, appId: string): ProfileReference | undefined {
  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384)
    throw Error('已保存的阅读资料位置记录不可用，未改用空资料。')
  const record = JSON.parse(readFileSync(file, 'utf8')) as ProfileReference
  if (
    record.version !== 1 ||
    record.appId !== appId ||
    typeof record.path !== 'string' ||
    !isAbsolute(record.path) ||
    typeof record.dev !== 'string' ||
    typeof record.ino !== 'string'
  )
    throw Error('已保存的阅读资料位置记录无效，未改用空资料。')
  let actual
  try {
    actual = identity(record.path)
  } catch {
    throw Error('原阅读资料文件夹暂时不可用，请恢复该位置后再打开朱墨。')
  }
  if (actual.dev !== record.dev || actual.ino !== record.ino)
    throw Error('原阅读资料文件夹已被替换，未打开同名的空资料。')
  return { ...record, path: actual.path }
}
export function boundReaderProfile(appData: string, product: ProductIdentity): string | undefined {
  return product.channel === 'stable'
    ? readSelection(profileSelectionFile(appData, product.appId), product.appId)?.path
    : undefined
}
function remember(file: string, record: ProfileReference): ProfileReference {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    // Publish complete bytes without replacing another simultaneous first-launch choice.
    try {
      moveFileExclusiveSync(temp, file)
    } catch (error) {
      if (!readSelection(file, record.appId)) throw error
    }
  } finally {
    try {
      unlinkSync(temp)
    } catch (error) {
      // eslint-disable-next-line no-unsafe-finally -- An unresolved publication must stop first launch, including cleanup failures.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const chosen = readSelection(file, record.appId)!
  if (chosen.dev !== record.dev || chosen.ino !== record.ino)
    throw Error('另一个朱墨窗口刚刚选择了不同的阅读资料，请重新打开。')
  return chosen
}
export interface SelectProfileOptions {
  appData: string
  product: ProductIdentity
  explicitProfile?: string
  choose?: (options: readonly ProfileOption[]) => number | undefined
}
/** Runs synchronously before Electron ready. Reuses the whole chosen profile in place;
 * Local State, encrypted keys, fonts, Chromium preferences and drafts remain together. */
export function selectReaderProfile(options: SelectProfileOptions): string {
  if (options.explicitProfile) {
    if (!isAbsolute(options.explicitProfile)) throw Error('阅读资料需要明确的绝对路径。')
    return resolve(options.explicitProfile)
  }
  const { appData, product } = options
  const fallback = join(appData, product.profileFolder)
  // Preview builds remain isolated and never silently adopt a stable user's settings.
  if (product.channel !== 'stable') return fallback
  const file = profileSelectionFile(appData, product.appId)
  const saved = readSelection(file, product.appId)
  if (saved) return saved.path
  const profiles = discoverProfiles(appData)
  let selected: ProfileOption
  if (profiles.length === 0) selected = { path: fallback, label: product.title, fresh: true }
  else if (profiles.length === 1) selected = profiles[0]
  else {
    const choices: ProfileOption[] = [...profiles]
    if (!profiles.some((p) => p.path.toLowerCase() === resolve(fallback).toLowerCase()))
      choices.push({ path: fallback, label: '从新的阅读资料开始', fresh: true })
    const index = options.choose?.(choices)
    if (index === undefined) throw new ProfileSelectionCancelled('已取消选择阅读资料。')
    if (!Number.isInteger(index) || index < 0 || index >= choices.length)
      throw Error('没有选定有效的阅读资料。')
    selected = choices[index]
  }
  if (selected.fresh) mkdirSync(selected.path, { recursive: true })
  const actual = identity(selected.path)
  if (selected.dev && (actual.dev !== selected.dev || actual.ino !== selected.ino))
    throw Error('选择期间阅读资料文件夹发生改变，请重新打开。')
  const reference: ProfileReference = { version: 1, appId: product.appId, ...actual }
  return remember(file, reference).path
}

/** This small native dialog has no Chromium profile and never opens either candidate. */
export function chooseNativeProfile(
  helper: string,
  options: readonly ProfileOption[]
): number | undefined {
  if (process.platform !== 'win32') throw Error('多套阅读资料的首次选择目前支持 Windows。')
  // 注意:不能设 windowsHide——ProfileChooser 是 WinForms 图形对话框,
  // 隐藏其窗口会使 ShowDialog 对着隐形窗无限等待,导致安装器假死(2.0.0 事故)。
  const result = spawnSync(helper, [], {
    shell: false,
    encoding: 'utf8',
    maxBuffer: 65536,
    env: {
      ...process.env,
      ZHUMO_PROFILE_CHOICES: Buffer.from(JSON.stringify(options)).toString('base64')
    }
  })
  if (result.error) throw result.error
  if (result.status === 2) return undefined
  if (result.status !== 0) throw Error('阅读资料选择窗口未完成，请重试。')
  const index = Number(result.stdout.trim())
  if (!result.stdout.trim() || !Number.isInteger(index)) throw Error('阅读资料选择结果无效。')
  return index
}
