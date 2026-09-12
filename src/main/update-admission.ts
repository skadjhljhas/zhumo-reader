import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, dirname, basename, resolve, relative, sep, parse } from 'node:path'
import { physicalFsSync as fs } from './physical-fs'

type Phase = 'reading' | 'preparing' | 'mutating' | 'complete'
interface Identity {
  pid: number
  birth: string | null
}
interface RecordData extends Identity {
  version: 1
  token: string
  resources: string[]
  phase: Phase
  transaction?: string
}
interface Found {
  file: string
  record: RecordData
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const key = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
const contains = (parent: string, child: string): boolean => {
  const rel = relative(key(parent), key(child))
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
export class UpdateAdmissionError extends Error {
  constructor(
    readonly reason: 'updating' | 'readers' | 'recovery' | 'invalid',
    message: string,
    readonly token?: string
  ) {
    super(message)
  }
}
/** Resolve the existing prefix without creating a not-yet-existing user profile. */
function canonical(path: string): string {
  if (!isAbsolute(path)) throw new UpdateAdmissionError('invalid', '更新协调必须使用绝对路径。')
  let at = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(fs.realpathSync.native(at), ...tail.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || at === dirname(at)) throw error
      tail.push(basename(at))
      at = dirname(at)
    }
  }
}
function processBirth(pid: number): string | null {
  if (process.platform !== 'win32') return null
  const exe = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  )
  const command = `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } catch { exit 1 }`
  const result = spawnSync(
    exe,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
    { windowsHide: true, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const value = result.stdout?.trim()
  return result.status === 0 && /^\d{15,25}$/.test(value) ? value : null
}
let self: Identity | undefined
function identity(): Identity {
  return (self ??= { pid: process.pid, birth: processBirth(process.pid) })
}
function alive(record: Identity): boolean {
  try {
    process.kill(record.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  if (!record.birth) return true // Unknown identity is conservatively alive, never guessed dead.
  const current = record.pid === process.pid ? identity().birth : processBirth(record.pid)
  return !current || current === record.birth
}
function directory(path: string): void {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new UpdateAdmissionError('invalid', '更新协调目录已被替换，未进入读写。')
}
function setup(resources: string[], coordinator: string): { resources: string[]; root: string } {
  if (!resources.length) throw new UpdateAdmissionError('invalid', '缺少更新保护范围。')
  const normalized = [
    ...new Map(
      resources.map((path) => {
        const p = canonical(path)
        return [key(p), p]
      })
    ).values()
  ].sort()
  if (normalized.some((p) => p === parse(p).root))
    throw new UpdateAdmissionError('invalid', '不能把整个盘符作为更新保护范围。')
  const root = canonical(coordinator)
  if (normalized.some((p) => contains(p, root) || contains(root, p)))
    throw new UpdateAdmissionError('invalid', '协调记录必须位于程序与资料目录之外。')
  directory(root)
  return { resources: normalized, root }
}
function folder(root: string, resource: string, kind: 'readers' | 'writers'): string {
  const scope = join(root, createHash('sha256').update(key(resource)).digest('hex'))
  directory(scope)
  const dir = join(scope, kind)
  directory(dir)
  return dir
}
function remove(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
function stateFile(root: string, token: string): string {
  if (!uuid.test(token)) throw new UpdateAdmissionError('invalid', '更新标识无效。')
  const dir = join(root, 'states')
  directory(dir)
  return join(dir, token + '.json')
}
function publish(file: string, record: RecordData, replace = false): void {
  const pending = file + '.' + randomUUID() + '.pending',
    handle = fs.openSync(pending, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, JSON.stringify(record))
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    if (replace) fs.renameSync(pending, file)
    else {
      fs.linkSync(pending, file)
      remove(pending)
    }
  } catch (error) {
    remove(pending)
    throw error
  }
}
function scan(root: string, resource: string, kind: 'readers' | 'writers'): Found[] {
  const dir = folder(root, resource, kind),
    found: Found[] = []
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.pending')) continue
    const file = join(dir, name)
    try {
      const info = fs.lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error()
      const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordData
      if (!claim || !uuid.test(claim.token) || name !== claim.token + '.json') throw Error()
      const statePath = stateFile(root, claim.token),
        stateInfo = fs.lstatSync(statePath)
      if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > 65536) throw Error()
      const r = JSON.parse(fs.readFileSync(statePath, 'utf8')) as RecordData
      if (
        !r ||
        r.token !== claim.token ||
        r.pid !== claim.pid ||
        r.birth !== claim.birth ||
        JSON.stringify(r.resources) !== JSON.stringify(claim.resources) ||
        r.version !== 1 ||
        !uuid.test(r.token) ||
        name !== r.token + '.json' ||
        !Number.isSafeInteger(r.pid) ||
        r.pid <= 0 ||
        (r.birth !== null && (typeof r.birth !== 'string' || !/^\d{15,25}$/.test(r.birth))) ||
        !Array.isArray(r.resources) ||
        !r.resources.every((p) => typeof p === 'string' && isAbsolute(p)) ||
        !r.resources.some((p) => key(p) === key(resource)) ||
        !['reading', 'preparing', 'mutating', 'complete'].includes(r.phase) ||
        (kind === 'readers') !== (r.phase === 'reading') ||
        (r.phase === 'mutating' && (!r.transaction || !isAbsolute(r.transaction)))
      )
        throw Error()
      found.push({ file, record: r })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(file)) continue
      throw new UpdateAdmissionError('invalid', '更新协调记录无法核对，请先恢复该次更新。')
    }
  }
  return found
}
function writerRecords(root: string, resources: string[]): Found[] {
  const result: Found[] = []
  for (const resource of resources)
    for (const item of scan(root, resource, 'writers')) {
      if (
        item.record.phase === 'complete' ||
        (item.record.phase === 'preparing' && !alive(item.record))
      ) {
        remove(item.file)
        continue
      }
      result.push(item)
    }
  return result
}
/** A journal keeps its original token even if completion closed that ancestor before
 * the recovering writer crashed. This state is evidence, never a new writer claim. */
function historicalRecoveryAnchor(root: string, token: string): RecordData | undefined {
  const file = stateFile(root, token)
  try {
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error()
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordData
    if (
      !record ||
      record.version !== 1 ||
      record.token !== token ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      (record.birth !== null &&
        (typeof record.birth !== 'string' || !/^\d{15,25}$/.test(record.birth))) ||
      !Array.isArray(record.resources) ||
      !record.resources.length ||
      !record.resources.every((path) => typeof path === 'string' && isAbsolute(path)) ||
      record.phase !== 'complete' ||
      typeof record.transaction !== 'string' ||
      !isAbsolute(record.transaction)
    )
      throw Error()
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new UpdateAdmissionError('invalid', '原更新历史状态无法核对，未接管恢复。')
  }
}
function assertNoWriter(root: string, resources: string[]): void {
  const writer = writerRecords(root, resources)[0]
  if (!writer) return
  const recovery = writer.record.phase === 'mutating' && !alive(writer.record)
  throw new UpdateAdmissionError(
    recovery ? 'recovery' : 'updating',
    recovery
      ? '检测到尚未完成的更新，请先完成恢复，再打开朱墨。'
      : '朱墨正在更新，请在更新完成后再打开。',
    writer.record.token
  )
}
/** Synchronous and before Electron ready: publish a reader, then recheck every writer.
 * Keep its token until the OS process is dead; quit hooks run before all profile flushing. */
export function admitReader(resources: string[], coordinator: string): { token: string } {
  const state = setup(resources, coordinator)
  assertNoWriter(state.root, state.resources)
  const record: RecordData = {
    version: 1,
    ...identity(),
    token: randomUUID(),
    resources: state.resources,
    phase: 'reading'
  }
  const files: string[] = []
  try {
    publish(stateFile(state.root, record.token), record)
    for (const resource of state.resources) {
      const file = join(folder(state.root, resource, 'readers'), record.token + '.json')
      publish(file, record)
      files.push(file)
    }
    assertNoWriter(state.root, state.resources)
    return { token: record.token }
  } catch (error) {
    for (const file of files) remove(file)
    throw error
  }
}
export interface UpdateAdmission {
  token: string
  markMutating(transaction: string): void
  cancel(): void
  complete(verify: () => Promise<void>): Promise<void>
}
export function inspectUpdateAdmission(
  resources: string[],
  coordinator: string
): {
  writers: Array<{
    token: string
    phase: Phase
    ownerAlive: boolean
    transaction?: string
    resources: string[]
  }>
} {
  const state = setup(resources, coordinator)
  const writers = new Map(
    writerRecords(state.root, state.resources).map((item) => [item.record.token, item.record])
  )
  return {
    writers: [...writers.values()].map((r) => ({
      token: r.token,
      phase: r.phase,
      ownerAlive: alive(r),
      transaction: r.transaction,
      resources: r.resources
    }))
  }
}
/** Optimistic multi-resource admission: a writer publishes first, then checks writers and
 * readers. Racing contenders may both back off; they cannot both enter a shared resource. */
export function admitUpdate(
  resources: string[],
  coordinator: string,
  recoverToken?: string
): UpdateAdmission {
  const state = setup(resources, coordinator)
  if (recoverToken && !uuid.test(recoverToken))
    throw new UpdateAdmissionError('invalid', '恢复标识无效。')
  const record: RecordData = {
    version: 1,
    ...identity(),
    token: randomUUID(),
    resources: state.resources,
    phase: 'preparing'
  }
  const files: string[] = [],
    previous: Found[] = []
  let closed = false,
    finishing = false,
    recoveryTransaction: string | undefined
  try {
    publish(stateFile(state.root, record.token), record)
    for (const resource of state.resources) {
      const file = join(folder(state.root, resource, 'writers'), record.token + '.json')
      publish(file, record)
      files.push(file)
    }
    const others = writerRecords(state.root, state.resources).filter(
      (item) => item.record.token !== record.token
    )
    const sameResources = (other: RecordData): boolean =>
      JSON.stringify(other.resources.map(key).sort()) ===
      JSON.stringify(state.resources.map(key).sort())
    if (recoverToken) {
      const anchor =
        others.find((item) => item.record.token === recoverToken)?.record ??
        historicalRecoveryAnchor(state.root, recoverToken)
      if (!anchor) throw new UpdateAdmissionError('invalid', '没有可接管的未完成更新。')
      if (
        !['mutating', 'complete'].includes(anchor.phase) ||
        alive(anchor) ||
        !sameResources(anchor)
      )
        throw new UpdateAdmissionError(
          'updating',
          '另一更新仍在进行，未进入文件替换。',
          anchor.token
        )
      recoveryTransaction = canonical(anchor.transaction!)
    }
    for (const item of others) {
      if (
        recoveryTransaction &&
        item.record.phase === 'mutating' &&
        !alive(item.record) &&
        sameResources(item.record) &&
        key(canonical(item.record.transaction!)) === key(recoveryTransaction)
      )
        previous.push(item)
      else
        throw new UpdateAdmissionError(
          'updating',
          '另一更新仍在进行，未进入文件替换。',
          item.record.token
        )
    }
    if (recoverToken && !previous.length)
      throw new UpdateAdmissionError('invalid', '没有可接管的未完成更新。')
    for (const resource of state.resources)
      for (const item of scan(state.root, resource, 'readers')) {
        if (alive(item.record))
          throw new UpdateAdmissionError(
            'readers',
            '请正常保存并退出正在使用这些资料的朱墨窗口，再更新。'
          )
        remove(item.file)
      }
    if (previous.length) {
      record.phase = 'mutating'
      record.transaction = recoveryTransaction
      publish(stateFile(state.root, record.token), record, true)
    }
  } catch (error) {
    for (const file of files) remove(file)
    throw error
  }
  return {
    token: record.token,
    markMutating(transaction) {
      if (closed || finishing || record.phase !== 'preparing' || !isAbsolute(transaction))
        throw new UpdateAdmissionError('invalid', '更新状态不能进入写入阶段。')
      const next: RecordData = { ...record, phase: 'mutating', transaction: canonical(transaction) }
      publish(stateFile(state.root, record.token), next, true)
      Object.assign(record, next)
    },
    cancel() {
      if (closed) return
      if (finishing) throw new UpdateAdmissionError('invalid', '正在验证更新，不能同时取消。')
      if (record.phase !== 'preparing')
        throw new UpdateAdmissionError(
          'recovery',
          '已开始改动文件，必须验证提交或恢复后才能解除门禁。',
          record.token
        )
      publish(stateFile(state.root, record.token), { ...record, phase: 'complete' }, true)
      closed = true
      for (const file of files) {
        try {
          remove(file)
        } catch {
          /* Completed state already admits readers. */
        }
      }
    },
    async complete(verify) {
      if (closed || finishing) throw new UpdateAdmissionError('invalid', '该更新已关闭或正在验证。')
      finishing = true
      try {
        await verify()
        // One atomic state file is authoritative for every resource. Completing only some
        // resource markers must never expose a half-finished multi-profile transaction.
        for (const old of new Map(
          previous.map((item) => [item.record.token, item.record])
        ).values())
          publish(stateFile(state.root, old.token), { ...old, phase: 'complete' }, true)
        publish(stateFile(state.root, record.token), { ...record, phase: 'complete' }, true)
        closed = true
        for (const file of [...previous.map((item) => item.file), ...files]) {
          try {
            remove(file)
          } catch {
            /* Only metadata cleanup remains. */
          }
        }
      } finally {
        finishing = false
      }
    }
  }
}
