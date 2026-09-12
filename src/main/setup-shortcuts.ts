import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import {
  setupAbsolute,
  inspectSetupDirectory,
  createSetupDirectory,
  readSetupFile
} from './setup-paths'
import { verifyInstalledRelease } from './installed-release'
import { writeSetupState, publishSetupState } from './managed-programs'
import { moveFileExclusive } from './exclusive-move'
import {
  assertOwnedDeletionSupported,
  deleteOwnedFile,
  deleteOwnedTemporary
} from './conditional-delete'

export interface ShortcutOptions {
  desktopDirectory: string
  menuDirectory: string
  displayName: string
}
export interface ShortcutEntry {
  kind: 'desktop' | 'menu'
  path: string
  sha256: string
  source: string
  sourceManifestHash: string
  created: boolean
  identity?: { dev: string; ino: string }
}
export interface ShortcutRecord {
  version: 1
  id: string
  root: string
  appId: string
  entries: ShortcutEntry[]
}
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export async function inspectShortcuts(options: ShortcutOptions): Promise<void> {
  if (
    !options ||
    typeof options.displayName !== 'string' ||
    !options.displayName.trim() ||
    options.displayName.length > 80 ||
    // eslint-disable-next-line no-control-regex -- A shortcut name must be a Windows filename without control characters.
    /[\\/:*?"<>|\x00-\x1f]/.test(options.displayName)
  )
    throw Error('快捷方式名称无效。')
  for (const path of [options.desktopDirectory, options.menuDirectory]) {
    const directory = await inspectSetupDirectory(path)
    await assertOwnedDeletionSupported(directory.existing)
  }
}
function recordPath(root: string, id: string): string {
  if (!uuid.test(id)) throw Error('快捷方式记录编号无效。')
  return join(root, '.zhumo', 'shortcut-records', id + '.json')
}
export async function previousRecord(
  root: string,
  id: string | undefined,
  appId: string
): Promise<ShortcutRecord | null> {
  if (!id) return null
  let bytes: Buffer
  try {
    bytes = await readSetupFile(recordPath(root, id), 65536)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const record = JSON.parse(bytes.toString('utf8')) as ShortcutRecord
  if (
    record.version !== 1 ||
    record.id !== id ||
    !same(record.root, root) ||
    record.appId !== appId ||
    !Array.isArray(record.entries) ||
    record.entries.length !== 2 ||
    new Set(record.entries.map((e) => e.kind)).size !== 2
  )
    throw Error('旧快捷方式记录不一致，未改写系统入口。')
  for (const entry of record.entries) {
    if (
      !['desktop', 'menu'].includes(entry.kind) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !/^[a-f0-9]{64}$/.test(entry.sourceManifestHash) ||
      !entry.path.toLowerCase().endsWith('.lnk')
    )
      throw Error('旧快捷方式记录损坏。')
    setupAbsolute(entry.path)
    setupAbsolute(entry.source)
  }
  return record
}

export interface WithdrawnShortcut {
  path: string
  backup: string
  temporary: string
  sha256: string
}
/** The current record can include reused entries. A changed link is now the user's file. */
export async function withdrawShortcuts(
  record: ShortcutRecord,
  work: string
): Promise<WithdrawnShortcut[]> {
  const withdrawn: WithdrawnShortcut[] = []
  try {
    for (const entry of record.entries) {
      await inspectSetupDirectory(dirname(entry.path))
      let bytes: Buffer
      try {
        bytes = await readSetupFile(entry.path, 1024 * 1024)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (hash(bytes) !== entry.sha256) continue
      const id = randomUUID()
      const item: WithdrawnShortcut = {
        path: entry.path,
        sha256: entry.sha256,
        backup: join(work, 'removed-shortcut-' + id + '.lnk'),
        temporary: join(dirname(entry.path), '.zhumo-shortcut-' + id + '.tmp')
      }
      await fs.copyFile(entry.path, item.backup, fs.constants.COPYFILE_EXCL)
      if (hash(await readSetupFile(item.backup, 1024 * 1024)) !== entry.sha256)
        throw Error('快捷方式在保存恢复副本时改变。')
      await writeSetupState(join(work, 'removed-shortcut-' + id + '.json'), item)
      withdrawn.push(item)
      await fs.rename(entry.path, item.temporary)
      if (hash(await readSetupFile(item.temporary, 1024 * 1024)) !== entry.sha256)
        throw Error('快捷方式在移除时改变，已保留最新内容。')
      await fs.unlink(item.temporary)
    }
    return withdrawn
  } catch (error) {
    await restoreWithdrawnShortcuts(withdrawn)
    throw error
  }
}
export async function restoreWithdrawnShortcuts(entries: WithdrawnShortcut[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    await inspectSetupDirectory(dirname(entry.path))
    const temporary = await fs.lstat(entry.temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (temporary) {
      // Same-directory, non-replacing publication retains even a last-moment user edit.
      await readSetupFile(entry.temporary, 1024 * 1024)
      await moveFileExclusive(entry.temporary, entry.path)
      continue
    }
    let current: Buffer | undefined
    try {
      current = await readSetupFile(entry.path, 1024 * 1024)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (current) {
      if (hash(current) !== entry.sha256) throw Error('原快捷方式位置已出现新内容，恢复副本保留。')
      continue
    }
    if (hash(await readSetupFile(entry.backup, 1024 * 1024)) !== entry.sha256)
      throw Error('快捷方式恢复副本不一致。')
    const staged = join(dirname(entry.path), '.zhumo-shortcut-restore-' + randomUUID() + '.tmp')
    await fs.copyFile(entry.backup, staged, fs.constants.COPYFILE_EXCL)
    if (hash(await readSetupFile(staged, 1024 * 1024)) !== entry.sha256)
      throw Error('快捷方式恢复暂存不一致。')
    await moveFileExclusive(staged, entry.path)
  }
}
const makeLinkScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$plan=ConvertFrom-Json ([IO.File]::ReadAllText($env:ZHUMO_SHORTCUT_PLAN,[Text.Encoding]::UTF8))
if([IO.File]::Exists($plan.output)){throw 'Shortcut staging path already exists'}
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut($plan.output)
$link.TargetPath=$plan.target
$link.Arguments=$plan.arguments
$link.WorkingDirectory=[IO.Path]::GetDirectoryName($plan.target)
$link.IconLocation=$plan.target+',0'
$link.Description=$plan.description
$link.Save()
if(-not [IO.File]::Exists($plan.output)){throw 'Shortcut creation failed'}
`
async function linkBytes(
  work: string,
  target: string,
  args: string,
  description: string
): Promise<Buffer> {
  const folder = join(work, 'shortcut-' + randomUUID())
  await fs.mkdir(folder)
  const plan = join(folder, 'plan.json'),
    output = join(folder, 'link.lnk')
  await fs.writeFile(plan, JSON.stringify({ target, arguments: args, description, output }), {
    flag: 'wx'
  })
  await new Promise<void>((done, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(makeLinkScript, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ZHUMO_SHORTCUT_PLAN: plan },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let error = ''
    child.stderr.on('data', (data) => {
      error += String(data)
    })
    child.stdout.resume()
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done() : reject(Error('快捷方式创建失败：' + error.slice(-2000)))
    )
  })
  return readSetupFile(output, 1024 * 1024)
}
interface ShortcutIntent {
  version: 1
  id: string
  root: string
  appId: string
  staging: string
  entry: ShortcutEntry
}
export interface ShortcutAttempt {
  root: string
  source: string
  manifestHash: string
  appId: string
  id: string
  previousId?: string
  work: string
  options: ShortcutOptions
  onPublished?: (kind: 'desktop' | 'menu') => void | Promise<void>
}
async function matchesIdentity(
  path: string,
  identity: ShortcutEntry['identity']
): Promise<boolean> {
  if (!identity) return false
  const info = await fs.lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return Boolean(
    info?.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1n &&
    info.dev.toString() === identity.dev &&
    info.ino.toString() === identity.ino
  )
}
async function readIntents(input: ShortcutAttempt): Promise<ShortcutIntent[]> {
  const folder = join(input.work, 'shortcut-intents', input.id)
  if ((await inspectSetupDirectory(folder)).missing.length) return []
  const intents: ShortcutIntent[] = []
  for (const file of await fs.readdir(folder, { withFileTypes: true })) {
    if (!/^(desktop|menu)-[a-f0-9-]{36}\.json$/i.test(file.name)) continue
    const item = JSON.parse(
      (await readSetupFile(join(folder, file.name))).toString('utf8')
    ) as ShortcutIntent
    const directory =
      item.entry?.kind === 'desktop' ? input.options.desktopDirectory : input.options.menuDirectory
    if (
      item.version !== 1 ||
      item.id !== input.id ||
      !same(item.root, input.root) ||
      item.appId !== input.appId ||
      !item.entry ||
      !['desktop', 'menu'].includes(item.entry.kind) ||
      !item.entry.created ||
      !same(dirname(item.entry.path), directory) ||
      !basename(item.entry.path).endsWith('.lnk') ||
      !same(item.entry.source, input.source) ||
      item.entry.sourceManifestHash !== input.manifestHash ||
      !/^[a-f0-9]{64}$/.test(item.entry.sha256) ||
      !/^\d+$/.test(item.entry.identity?.dev ?? '') ||
      !/^\d+$/.test(item.entry.identity?.ino ?? '') ||
      !same(dirname(item.staging), directory) ||
      !/^\.zhumo-link-[a-f0-9-]{36}\.tmp$/i.test(basename(item.staging))
    )
      throw Error('快捷方式发布记录越出本次安装范围。')
    setupAbsolute(item.entry.path)
    setupAbsolute(item.staging)
    intents.push(item)
  }
  return intents
}
async function publishLink(
  input: ShortcutAttempt,
  kind: 'desktop' | 'menu',
  folder: string,
  bytes: Buffer
): Promise<ShortcutEntry> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(
      folder,
      input.options.displayName + (attempt ? ' ' + randomUUID().slice(0, 8) : '') + '.lnk'
    )
    await inspectSetupDirectory(folder)
    if (
      await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
    )
      continue
    const staging = join(folder, '.zhumo-link-' + randomUUID() + '.tmp')
    const output = await fs.open(staging, 'wx', 0o600)
    const identity = await output.stat({ bigint: true })
    const entry: ShortcutEntry = {
      kind,
      path,
      sha256: hash(bytes),
      source: input.source,
      sourceManifestHash: input.manifestHash,
      created: true,
      identity: { dev: identity.dev.toString(), ino: identity.ino.toString() }
    }
    try {
      const intents = join(input.work, 'shortcut-intents', input.id)
      await createSetupDirectory(await inspectSetupDirectory(intents))
      await publishSetupState(join(intents, kind + '-' + randomUUID() + '.json'), {
        version: 1,
        id: input.id,
        root: input.root,
        appId: input.appId,
        staging,
        entry
      } satisfies ShortcutIntent)
      await output.writeFile(bytes)
      await output.sync()
    } finally {
      await output.close()
    }
    if (!bytes.equals(await readSetupFile(staging, 1024 * 1024)))
      throw Error('快捷方式未能完整保存。')
    await moveFileExclusive(staging, path)
    await input.onPublished?.(kind)
    return entry
  }
  throw Error('快捷方式位置持续被占用。')
}
/** Reuse only recorded, byte-identical links with a still-verified bootstrap. A user's
 * modified or unrelated shortcut stays intact; a fresh link gets a distinct name. */
export async function installShortcuts(input: ShortcutAttempt): Promise<ShortcutRecord> {
  const root = setupAbsolute(input.root),
    source = setupAbsolute(input.source),
    work = setupAbsolute(input.work)
  await inspectShortcuts(input.options)
  const release = await verifyInstalledRelease(
    source,
    await readSetupFile(join(source, 'program-files.v1.json'), 64 * 1024 * 1024),
    input.manifestHash
  )
  if (release.manifest.appId !== input.appId) throw Error('快捷方式启动器不属于此产品。')
  const completed = await previousRecord(root, input.id, input.appId)
  if (completed) {
    for (const entry of completed.entries) {
      const folder =
        entry.kind === 'desktop' ? input.options.desktopDirectory : input.options.menuDirectory
      if (
        !same(dirname(entry.path), folder) ||
        hash(await readSetupFile(entry.path, 1024 * 1024)) !== entry.sha256
      )
        throw Error('本次安装已经生成的快捷方式发生改变。')
      const bootstrap = await verifyInstalledRelease(
        entry.source,
        await readSetupFile(join(entry.source, 'program-files.v1.json'), 64 * 1024 * 1024),
        entry.sourceManifestHash
      )
      if (bootstrap.manifest.appId !== input.appId)
        throw Error('已生成快捷方式的启动程序身份不同。')
    }
    return completed
  }
  const intents = await readIntents(input)
  const old = await previousRecord(root, input.previousId, input.appId)
  const record: ShortcutRecord = { version: 1, id: input.id, root, appId: input.appId, entries: [] }
  const verified = new Map<string, boolean>()
  let generated: Buffer | undefined
  try {
    for (const [kind, directory] of [
      ['desktop', input.options.desktopDirectory],
      ['menu', input.options.menuDirectory]
    ] as const) {
      const folder = await createSetupDirectory(await inspectSetupDirectory(directory))
      const pending = intents.filter((item) => item.entry.kind === kind)
      const owned: ShortcutEntry[] = []
      for (const item of pending) {
        if (await matchesIdentity(item.entry.path, item.entry.identity)) {
          if (hash(await readSetupFile(item.entry.path, 1024 * 1024)) !== item.entry.sha256)
            throw Error('本次安装生成的快捷方式已被修改。')
          owned.push(item.entry)
        }
      }
      if (owned.length > 1) throw Error('本次安装存在多个未完成的同类快捷方式。')
      if (owned.length) {
        record.entries.push(owned[0])
        continue
      }
      const prior = old?.entries.find(
        (entry) => entry.kind === kind && same(dirname(entry.path), folder)
      )
      let reusable = false
      if (prior) {
        try {
          if (!verified.has(prior.source)) {
            const previous = await verifyInstalledRelease(
              prior.source,
              await readSetupFile(join(prior.source, 'program-files.v1.json'), 64 * 1024 * 1024),
              prior.sourceManifestHash
            )
            verified.set(prior.source, previous.manifest.appId === input.appId)
          }
          reusable =
            Boolean(verified.get(prior.source)) &&
            hash(await readSetupFile(prior.path, 1024 * 1024)) === prior.sha256
        } catch {
          reusable = false
        }
      }
      if (reusable) {
        record.entries.push({ ...prior!, created: false })
        continue
      }
      generated ??= await linkBytes(
        work,
        join(source, release.manifest.executable),
        '--zhumo-launch-current "' + root + '"',
        input.options.displayName
      )
      record.entries.push(await publishLink(input, kind, folder, generated))
    }
    await createSetupDirectory(await inspectSetupDirectory(dirname(recordPath(root, input.id))))
    await publishSetupState(recordPath(root, input.id), record)
    if ((await previousRecord(root, input.id, input.appId))?.entries.length !== 2)
      throw Error('快捷方式记录未能读回。')
    return record
  } catch (error) {
    await rollbackShortcutAttempt(input)
    throw error
  }
}
/** Only this attempt's new, unchanged .lnk files qualify. Never remove a previous entry. */
export async function rollbackShortcuts(record: ShortcutRecord): Promise<void> {
  for (const entry of record.entries.filter((entry) => entry.created)) {
    if (entry.identity && basename(entry.path).toLowerCase().endsWith('.lnk'))
      await deleteOwnedFile(entry.path, entry.identity, entry.sha256)
  }
}

/** Durable intents prove ownership even if the process exited before the final record. */
export async function rollbackShortcutAttempt(input: ShortcutAttempt): Promise<void> {
  for (const item of await readIntents(input)) {
    await deleteOwnedFile(item.entry.path, item.entry.identity!, item.entry.sha256)
    await deleteOwnedTemporary(item.staging, item.entry.identity!)
  }
}
