import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { physicalFs as fs } from './physical-fs'
import { inspectUpdateAdmission } from './update-admission'
import {
  ProfileGuardError,
  type ProfileGuardClient,
  type ProfileGuardStatus
} from './profile-guard-client'

export interface RetainedProfileGuardExpected {
  profile: string
  programRoots: readonly string[]
  coordinator: string
  originalToken: string
}
export type RetainedProfileGuard = Pick<
  ProfileGuardClient,
  'pid' | 'directory' | 'signal' | 'failure' | 'assertHeld' | 'release'
>
interface DirectoryIdentity {
  path: string
  info: BigIntStats
}
interface RecordIdentity {
  path: string
  info: BigIntStats
  hash: string
}
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const uuidPattern = new RegExp('^' + uuid + '$')
const pipePattern = new RegExp('^' + String.raw`\\\\\.\\pipe\\zhumo-profile-guard-` + uuid + '$')
const key = (path: string): string => path.toLowerCase()
const contains = (parent: string, child: string): boolean => {
  const path = relative(key(parent), key(child))
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function sameRecord(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  )
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('记录格式不正确。')
  return value as Record<string, unknown>
}
/** Resolve only after checking every component; no recovery path silently follows a junction. */
async function realDirectory(path: string): Promise<{ path: string; chain: DirectoryIdentity[] }> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('恢复位置必须是绝对目录。')
  const absolute = resolve(path),
    volume = parse(absolute).root
  if (key(absolute) === key(volume)) throw Error('不能用盘符作为守护恢复位置。')
  const chain: DirectoryIdentity[] = []
  let at = volume
  for (const part of ['', ...relative(volume, absolute).split(sep).filter(Boolean)]) {
    if (part) at = join(at, part)
    const info = await fs.lstat(at, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('恢复路径包含链接或非目录。')
    chain.push({ path: at, info })
  }
  const canonical = await fs.realpath(absolute)
  await unchangedDirectories(chain)
  return { path: canonical, chain }
}
async function unchangedDirectories(chain: DirectoryIdentity[]): Promise<void> {
  for (const expected of chain) {
    const current = await fs.lstat(expected.path, { bigint: true })
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(expected.info, current))
      throw Error('守护恢复目录已被替换。')
  }
}
async function readRecord(
  path: string,
  limit: number
): Promise<{ value: Record<string, unknown>; identity: RecordIdentity }> {
  const before = await fs.lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(limit)
  )
    throw Error('守护恢复记录必须是有界的独立常规文件。')
  const input = await fs.open(path, 'r')
  const buffer = Buffer.alloc(limit + 1)
  let count = 0
  try {
    if (!sameRecord(before, await input.stat({ bigint: true })))
      throw Error('守护恢复记录在打开前改变。')
    while (count < buffer.length) {
      const part = await input.read(buffer, count, buffer.length - count, count)
      if (!part.bytesRead) break
      count += part.bytesRead
    }
    if (
      count > limit ||
      BigInt(count) !== before.size ||
      !sameRecord(before, await fs.lstat(path, { bigint: true }))
    )
      throw Error('守护恢复记录在读取时改变。')
  } finally {
    await input.close()
  }
  const bytes = buffer.subarray(0, count)
  return {
    value: object(JSON.parse(bytes.toString('utf8'))),
    identity: { path, info: before, hash: createHash('sha256').update(bytes).digest('hex') }
  }
}
async function request(
  pipe: string,
  token: string,
  action: 'status' | 'release',
  timeout: number
): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const socket = connect(pipe)
    let data = Buffer.alloc(0),
      settled = false
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else done(response!)
    }
    // A wall-clock deadline, not an inactivity timeout that can be extended by trickled bytes.
    const timer = setTimeout(() => finish(Error('保留守护没有及时响应。')), timeout)
    socket.on('connect', () => socket.write(JSON.stringify({ token, action }) + '\n'))
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (data.length > 4096) return finish(Error('保留守护响应过大。'))
      const at = data.indexOf(10)
      if (at < 0) return
      try {
        if (
          data
            .subarray(at + 1)
            .toString()
            .trim()
        )
          throw Error()
        finish(undefined, object(JSON.parse(data.subarray(0, at).toString('utf8'))))
      } catch {
        finish(Error('保留守护响应格式无效。'))
      }
    })
    socket.on('error', () => finish(Error('保留守护控制通道不可用。')))
    socket.on('close', () => finish(Error('保留守护未完整响应就关闭了通道。')))
  })
}
function held(value: Record<string, unknown>): ProfileGuardStatus {
  if (
    value.ok !== true ||
    value.held !== true ||
    value.windows !== 0 ||
    value.scratchBound !== true ||
    typeof value.parentChannelClosed !== 'boolean' ||
    !Number.isSafeInteger(value.blocked) ||
    Number(value.blocked) < 0
  )
    throw Error('无法认证保留守护的有效持锁状态。')
  return value as unknown as ProfileGuardStatus
}

/** Reconnect only to the exact retained plan and authenticated local pipe. This module never
 * spawns a guard, terminates a process, removes records, or guesses an alternate pipe.
 *
 * The caller must already hold recovery admission. Its new mutating token may have replaced
 * originalToken; the old guard still protects any related mutating writer. PID is validated
 * retained metadata, not an independently queried OS pipe-owner identity. */
export async function reconnectProfileGuard(
  directory: string,
  expected: RetainedProfileGuardExpected
): Promise<RetainedProfileGuard> {
  if (process.platform !== 'win32')
    throw new ProfileGuardError('invalid', '原生守护恢复当前仅支持Windows。')
  if (
    !expected ||
    !Array.isArray(expected.programRoots) ||
    !expected.programRoots.length ||
    expected.programRoots.length > 128 ||
    typeof expected.originalToken !== 'string' ||
    !uuidPattern.test(expected.originalToken)
  )
    throw new ProfileGuardError('invalid', '守护恢复的预期身份无效。')
  const bindings = {
    profile: expected.profile,
    coordinator: expected.coordinator,
    originalToken: expected.originalToken,
    programRoots: [...expected.programRoots]
  }
  let location: Awaited<ReturnType<typeof realDirectory>>
  let recordChecks!: () => Promise<void>
  let profile = '',
    coordinator = '',
    programRoots: string[] = [],
    pipe = '',
    controlToken = '',
    pid = 0,
    contactTimeout = 0
  try {
    location = await realDirectory(directory)
    const profileLocation = await realDirectory(bindings.profile),
      coordinatorLocation = await realDirectory(bindings.coordinator),
      roots = await Promise.all(bindings.programRoots.map(realDirectory))
    profile = profileLocation.path
    coordinator = coordinatorLocation.path
    programRoots = roots.map((r) => r.path)
    if (
      new Set(programRoots.map(key)).size !== programRoots.length ||
      [profile, ...programRoots].some(
        (root) => contains(root, location.path) || contains(location.path, root)
      )
    )
      throw Error('守护恢复记录必须独立于受保护位置。')
    const plan = await readRecord(join(location.path, 'plan.json'), 65536)
    const ready = await readRecord(join(location.path, 'plan.json.ready.json'), 4096)
    const p = plan.value,
      r = ready.value
    if (
      p.version !== 1 ||
      p.updateToken !== bindings.originalToken ||
      typeof p.controlToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.controlToken) ||
      typeof p.profile !== 'string' ||
      typeof p.coordinator !== 'string' ||
      typeof p.scratch !== 'string' ||
      typeof p.appName !== 'string' ||
      !p.appName ||
      p.appName.length > 128 ||
      /[\\/\0]/.test(p.appName) ||
      !Array.isArray(p.programRoots) ||
      p.programRoots.length !== programRoots.length ||
      !p.programRoots.every((path) => typeof path === 'string')
    )
      throw Error('保留计划与预期更新身份不符。')
    const planProfile = await realDirectory(p.profile),
      planCoordinator = await realDirectory(p.coordinator),
      planRoots = await Promise.all((p.programRoots as string[]).map(realDirectory)),
      scratch = await realDirectory(p.scratch)
    if (
      key(planProfile.path) !== key(profile) ||
      key(planCoordinator.path) !== key(coordinator) ||
      JSON.stringify(planRoots.map((root) => key(root.path)).sort()) !==
        JSON.stringify(programRoots.map(key).sort()) ||
      key(scratch.path) !== key(join(location.path, 'scratch'))
    )
      throw Error('保留计划的资料、程序或协调位置不符。')
    contactTimeout =
      p.controlContactTimeoutMs === undefined ? 10000 : Number(p.controlContactTimeoutMs)
    if (
      (p.controlContactTimeoutMs !== undefined && typeof p.controlContactTimeoutMs !== 'number') ||
      !Number.isInteger(contactTimeout) ||
      contactTimeout < 1000 ||
      contactTimeout > 600000 ||
      r.version !== 1 ||
      r.updateToken !== bindings.originalToken ||
      !Number.isSafeInteger(r.pid) ||
      Number(r.pid) <= 0 ||
      Number(r.pid) > 0xffffffff ||
      r.held !== true ||
      r.windows !== 0 ||
      r.scratchBound !== true ||
      r.controlContactTimeoutMs !== contactTimeout ||
      typeof r.pipe !== 'string' ||
      !pipePattern.test(r.pipe)
    )
      throw Error('保留守护就绪记录的身份或控制协议无效。')
    pipe = r.pipe
    controlToken = p.controlToken
    pid = Number(r.pid)
    const directories = [...location.chain, ...scratch.chain]
    const records = [
      { previous: plan.identity, limit: 65536 },
      { previous: ready.identity, limit: 4096 }
    ]
    recordChecks = async (): Promise<void> => {
      await unchangedDirectories(directories)
      for (const { previous, limit } of records) {
        const now = (await readRecord(previous.path, limit)).identity
        if (!sameRecord(previous.info, now.info) || previous.hash !== now.hash)
          throw Error('保留守护身份记录已改变。')
      }
      await unchangedDirectories(directories)
    }
    await recordChecks()
    held(
      await request(pipe, controlToken, 'status', Math.min(5000, Math.floor(contactTimeout / 3)))
    )
    await recordChecks()
  } catch {
    // No secret, raw peer error or record contents escape through the error object.
    throw new ProfileGuardError(
      'startup',
      '未能验证并认证原守护；保留记录，未启动替代进程。',
      directory
    )
  }
  const commandTimeout = Math.min(5000, Math.floor(contactTimeout / 3)),
    heartbeatMs = Math.min(1000, Math.floor(contactTimeout / 4))
  const controller = new AbortController()
  let resolveFailure!: (error: ProfileGuardError) => void
  const failure = new Promise<ProfileGuardError>((resolve) => {
    resolveFailure = resolve
  })
  let fault: ProfileGuardError | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let checking: Promise<ProfileGuardStatus> | undefined, releaseInFlight: Promise<void> | undefined
  let releasing = false,
    released = false
  const fail = (): ProfileGuardError => {
    if (!fault) {
      fault = new ProfileGuardError(
        'lost',
        '保留守护的身份或持锁状态已不可确认，停止后续写入并保留记录。',
        location.path
      )
      clearTimeout(timer)
      controller.abort(fault)
      resolveFailure(fault)
    }
    return fault
  }
  const assertHeld = async (): Promise<ProfileGuardStatus> => {
    if (fault) throw fault
    if (released || releasing)
      throw new ProfileGuardError('release', '保留守护已进入释放阶段。', location.path)
    checking ??= (async () => {
      try {
        await recordChecks()
        const state = held(await request(pipe, controlToken, 'status', commandTimeout))
        await recordChecks()
        if (fault) throw fault
        return state
      } catch {
        throw fail()
      }
    })().finally(() => {
      checking = undefined
    })
    return checking
  }
  const schedule = (): void => {
    if (fault || released || releasing) return
    timer = setTimeout(() => {
      void assertHeld()
        .then(schedule)
        .catch(() => {})
    }, heartbeatMs)
    timer.unref()
  }
  schedule()
  return {
    pid,
    directory: location.path,
    signal: controller.signal,
    failure,
    assertHeld,
    release() {
      if (released) return Promise.resolve()
      if (releaseInFlight) return releaseInFlight
      releaseInFlight = (async () => {
        if (
          inspectUpdateAdmission([profile, ...programRoots], coordinator).writers.some(
            (writer) => writer.token === bindings.originalToken || writer.phase === 'mutating'
          )
        )
          throw new ProfileGuardError(
            'release',
            '仍有原事务或相关写入，保留守护继续持锁。',
            location.path
          )
        releasing = true
        clearTimeout(timer)
        try {
          await checking?.catch(() => {})
          await recordChecks()
          const reply = await request(pipe, controlToken, 'release', commandTimeout)
          if (
            reply.ok === false &&
            (reply.error === 'update not completed' || reply.error === 'update state unverifiable')
          )
            throw new ProfileGuardError(
              'release',
              '原守护尚不允许释放，恢复记录继续保留。',
              location.path
            )
          if (reply.ok !== true || reply.released !== true) throw Error('未获得认证释放应答。')
          await recordChecks()
          released = true
        } catch (error) {
          if (error instanceof ProfileGuardError && error.reason === 'release') throw error
          throw fail()
        } finally {
          releasing = false
          schedule()
        }
      })().finally(() => {
        releaseInFlight = undefined
      })
      return releaseInFlight
    }
  }
}
