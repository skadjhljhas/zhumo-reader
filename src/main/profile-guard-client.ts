import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { isAbsolute, join, relative, sep } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { inspectUpdateAdmission, type UpdateAdmission } from './update-admission'

export interface ProfileGuardOptions {
  /** A trusted, staged Electron executable outside every program root being protected. */
  executable: string
  /** Development only: the absolute built main entry point. Packaged executables need no args. */
  args?: readonly string[]
  profile: string
  programRoots: readonly string[]
  coordinator: string
  /** Existing directory outside the protected profile/programs. No user data is stored here. */
  workParent: string
  appName: string
  admission: UpdateAdmission
  /** Cancels startup only. After successful startup use verified admission completion + release. */
  signal?: AbortSignal
  startupTimeoutMs?: number
  commandTimeoutMs?: number
  heartbeatMs?: number
  exitTimeoutMs?: number
}
export interface ProfileGuardStatus {
  ok: true
  held: true
  windows: 0
  scratchBound: true
  blocked: number
  /** Diagnostic only: Windows GUI Electron may have no readable stdin from startup. */
  parentChannelClosed: boolean
}
export interface ProfileGuardExit {
  code: number | null
  signal: NodeJS.Signals | null
}
export interface ProfileGuardClient {
  readonly pid: number
  /** Contains the durable plan needed for recovery. Never log its contents (control secret). */
  readonly directory: string
  /** Latched on lost/unverifiable protection, never reset by a later successful heartbeat. */
  readonly signal: AbortSignal
  /** Resolves only on failure; does not reject or cause an unhandled promise rejection. */
  readonly failure: Promise<ProfileGuardError>
  readonly exited: Promise<ProfileGuardExit>
  assertHeld(): Promise<ProfileGuardStatus>
  /** Requires admission.complete/cancel first; never cancels the transaction or kills a process. */
  release(): Promise<void>
}
export class ProfileGuardError extends Error {
  constructor(
    readonly reason: 'invalid' | 'startup' | 'cancelled' | 'lost' | 'release' | 'cleanup',
    message: string,
    readonly directory?: string,
    readonly diagnostic?: {
      stage: string
      exitCode: number | null | undefined
      helperFailure?: string
    }
  ) {
    super(message)
    this.name = 'ProfileGuardError'
  }
}
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const pipePattern = new RegExp('^' + String.raw`\\\\\.\\pipe\\zhumo-profile-guard-` + uuid + '$')
const key = (path: string): string => path.toLowerCase()
const contains = (parent: string, child: string): boolean => {
  const r = relative(key(parent), key(child))
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))
}
function duration(value: number | undefined, fallback: number): number {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < 20 || n > 120000)
    throw new ProfileGuardError('invalid', '资料守护的超时参数无效。')
  return n
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProfileGuardError('cancelled', '已取消资料守护启动。')
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new ProfileGuardError('cancelled', '已取消资料守护启动。'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
/** One authenticated, bounded JSON-line exchange. Never includes peer text or the token in errors. */
async function command(
  pipe: string,
  token: string,
  action: 'status' | 'release',
  timeout: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const socket = connect(pipe)
    let buffer = Buffer.alloc(0),
      settled = false
    const finish = (error?: Error, result?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => finish(new ProfileGuardError('cancelled', '已取消资料守护启动。'))
    // Wall-clock deadline, not an inactivity timeout: trickling bytes cannot keep it pending.
    const timer = setTimeout(() => finish(Error('资料守护没有及时响应。')), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    socket.on('connect', () => {
      socket.write(JSON.stringify({ token, action }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 4096) return finish(Error('资料守护响应过大。'))
      const at = buffer.indexOf(10)
      if (at < 0) return
      try {
        if (
          buffer
            .subarray(at + 1)
            .toString()
            .trim()
        )
          throw Error()
        const result = JSON.parse(buffer.subarray(0, at).toString('utf8'))
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error()
        finish(undefined, result)
      } catch {
        finish(Error('资料守护响应格式无效。'))
      }
    })
    socket.on('error', () => finish(Error('资料守护控制通道不可用。')))
    socket.on('close', () => finish(Error('资料守护未完整响应就关闭了通道。')))
    if (signal?.aborted) abort()
  })
}
function heldStatus(value: Record<string, unknown>): ProfileGuardStatus {
  if (
    value.ok !== true ||
    value.held !== true ||
    value.windows !== 0 ||
    value.scratchBound !== true ||
    typeof value.parentChannelClosed !== 'boolean' ||
    !Number.isSafeInteger(value.blocked) ||
    (value.blocked as number) < 0
  )
    throw Error('无法确认资料守护仍完整持有锁。')
  return value as unknown as ProfileGuardStatus
}

/** Starts a supervised helper; does not authorize mutation or implement an installer. */
export async function startProfileGuard(options: ProfileGuardOptions): Promise<ProfileGuardClient> {
  if (process.platform !== 'win32')
    throw new ProfileGuardError('invalid', '原生资料守护当前仅支持Windows。')
  checkAbort(options.signal)
  const startupTimeout = duration(options.startupTimeoutMs, 30000),
    commandTimeout = duration(options.commandTimeoutMs, 5000),
    heartbeatMs = duration(options.heartbeatMs, 1000),
    exitTimeout = duration(options.exitTimeoutMs, 10000)
  // The next heartbeat is scheduled after the previous exchange. Include its entire deadline
  // plus scheduling margin; a customized slow cadence must not accidentally expire the guard.
  const controlContactTimeoutMs = Math.max(10000, heartbeatMs + commandTimeout + 2000)
  if (
    ![options.executable, options.profile, options.coordinator, options.workParent].every(
      (p) => typeof p === 'string' && isAbsolute(p)
    ) ||
    !options.programRoots.length ||
    !options.programRoots.every((p) => typeof p === 'string' && isAbsolute(p)) ||
    !new RegExp('^' + uuid + '$').test(options.admission.token) ||
    !options.appName ||
    options.appName.length > 128 ||
    /[\\/\0]/.test(options.appName) ||
    (options.args?.length && (options.args.length !== 1 || !isAbsolute(options.args[0])))
  )
    throw new ProfileGuardError('invalid', '资料守护启动参数无效。')
  const [executable, profile, coordinator, workParent, ...programRoots] = await Promise.all(
    [
      options.executable,
      options.profile,
      options.coordinator,
      options.workParent,
      ...options.programRoots
    ].map((p) => fs.realpath(p))
  )
  if (
    !(await fs.stat(executable)).isFile() ||
    !(
      await Promise.all([profile, coordinator, workParent, ...programRoots].map((p) => fs.stat(p)))
    ).every((s) => s.isDirectory()) ||
    [profile, ...programRoots].some((p) => contains(p, workParent) || contains(workParent, p)) ||
    [profile, ...programRoots].some((p) => contains(p, executable))
  )
    throw new ProfileGuardError('invalid', '守护程序与临时目录必须独立于被保护的程序和资料目录。')
  const writers = (): ReturnType<typeof inspectUpdateAdmission>['writers'] =>
    inspectUpdateAdmission([profile], coordinator).writers
  if (!writers().some((w) => w.token === options.admission.token && w.ownerAlive))
    throw new ProfileGuardError('invalid', '资料守护没有对应的有效更新协调者。')

  checkAbort(options.signal)
  const directory = await fs.mkdtemp(join(workParent, 'zhumo-profile-guard-')),
    directoryIdentity = await fs.lstat(directory),
    planPath = join(directory, 'plan.json'),
    readyPath = planPath + '.ready.json',
    controlToken = randomBytes(32).toString('hex')
  let child: ChildProcessWithoutNullStreams | undefined
  let startupStage = 'plan',
    helperFailure: string | undefined,
    helperErrorBuffer = ''
  let didExit = false,
    exit: ProfileGuardExit | undefined,
    spawnError = false
  let resolveExit!: (value: ProfileGuardExit) => void
  const exited = new Promise<ProfileGuardExit>((resolve) => {
    resolveExit = resolve
  })
  let releaseInFlight: Promise<void> | undefined,
    released = false,
    releasing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let fault: ProfileGuardError | undefined
  const controller = new AbortController()
  let resolveFailure!: (error: ProfileGuardError) => void
  const failure = new Promise<ProfileGuardError>((resolve) => {
    resolveFailure = resolve
  })
  const fail = (message: string): ProfileGuardError => {
    if (!fault) {
      fault = new ProfileGuardError('lost', message, directory)
      clearTimeout(timer)
      controller.abort(fault)
      resolveFailure(fault)
    }
    return fault
  }
  const cleanup = async (): Promise<void> => {
    if (child && !didExit)
      throw new ProfileGuardError('cleanup', '守护尚未退出，保留恢复记录。', directory)
    const current = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!current) return
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== directoryIdentity.dev ||
      current.ino !== directoryIdentity.ino ||
      key(await fs.realpath(directory)) !== key(directory) ||
      !contains(workParent, directory) ||
      key(directory) === key(workParent)
    )
      throw new ProfileGuardError('cleanup', '守护临时目录已改变，保留现场。', directory)
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  let pipe = ''
  try {
    const handle = await fs.open(planPath, 'wx', 0o600)
    try {
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          profile,
          scratch: join(directory, 'scratch'),
          coordinator,
          updateToken: options.admission.token,
          controlToken,
          appName: options.appName,
          programRoots,
          controlContactTimeoutMs
        })
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    checkAbort(options.signal)
    const env = { ...process.env }
    // Even an empty value activates Electron's Node mode. It must be absent, not empty.
    for (const name of Object.keys(env))
      if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[name]
    startupStage = 'spawn'
    child = spawn(executable, [...(options.args ?? []), '--zhumo-profile-guard', planPath], {
      windowsHide: true,
      shell: false,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: directory
    })
    child.stdout.resume()
    child.stderr.on('data', (chunk) => {
      helperErrorBuffer = (helperErrorBuffer + chunk.toString('utf8')).slice(-8192)
      // Expose only known failure categories, never raw child output or plan contents.
      const messages = [
        ['计划文件', 'plan-arguments'],
        ['计划无效', 'plan-validation'],
        ['被保护目录之外', 'scratch-location'],
        ['有效更新协调者', 'admission'],
        ['仍在运行', 'old-program-running'],
        ['相关进程的位置', 'process-identity'],
        ['无法确认旧朱墨', 'process-inventory'],
        ['未取得守护', 'native-lock-busy']
      ]
      for (const [text, category] of messages)
        if (helperErrorBuffer.includes(text)) helperFailure = category
    })
    // Windows GUI stdin is not the supervision channel. Child exit and authenticated control
    // failures remain authoritative; swallowing this stream error avoids an unrelated crash.
    child.stdin.on('error', () => {})
    child.on('error', () => {
      spawnError = true
      fail('资料守护进程启动或运行异常，停止更新写入。')
    })
    child.once('exit', (code, signal) => {
      didExit = true
      exit = { code, signal }
      resolveExit(exit)
      if (!released && (!releasing || code !== 0 || signal !== null))
        fail('资料守护提前退出，停止更新写入并保留恢复记录。')
    })
    child.once('close', (code, signal) => {
      // Failed spawn has no exit event. Do not wait indefinitely for an impossible exit.
      if (!didExit) {
        didExit = true
        exit = { code, signal }
        resolveExit(exit)
      }
    })
    const deadline = performance.now() + startupTimeout
    startupStage = 'ready-file'
    for (;;) {
      checkAbort(options.signal)
      if (spawnError || didExit || fault) throw Error('资料守护未能启动。')
      if (performance.now() >= deadline) throw Error('等待资料守护启动超时。')
      const info = await fs.lstat(readyPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!info) {
        await wait(Math.min(100, Math.max(1, deadline - performance.now())), options.signal)
        continue
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        throw Error('资料守护就绪记录无效。')
      const input = await fs.open(readyPath, 'r')
      let raw: string
      try {
        const actual = await input.stat(),
          buffer = Buffer.alloc(4097)
        if (
          !actual.isFile() ||
          actual.dev !== info.dev ||
          actual.ino !== info.ino ||
          actual.size > 4096
        )
          throw Error('资料守护就绪记录已改变。')
        const { bytesRead } = await input.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 4096) throw Error('资料守护就绪记录过大。')
        raw = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await input.close()
      }
      let ready: Record<string, unknown>
      try {
        ready = JSON.parse(raw)
      } catch {
        // The helper creates then writes this file. Seeing its incomplete first write is normal.
        await wait(Math.min(100, Math.max(1, deadline - performance.now())), options.signal)
        continue
      }
      startupStage = 'ready-identity'
      if (ready?.controlContactTimeoutMs !== controlContactTimeoutMs)
        helperFailure = 'control-heartbeat-protocol'
      if (
        !ready ||
        ready.version !== 1 ||
        ready.pid !== child.pid ||
        !child.pid ||
        ready.updateToken !== options.admission.token ||
        ready.held !== true ||
        ready.windows !== 0 ||
        ready.scratchBound !== true ||
        ready.controlContactTimeoutMs !== controlContactTimeoutMs ||
        typeof ready.pipe !== 'string' ||
        !pipePattern.test(ready.pipe)
      )
        throw Error('资料守护就绪身份不匹配。')
      pipe = ready.pipe
      startupStage = 'handshake'
      const initialStatus = await command(
        pipe,
        controlToken,
        'status',
        Math.max(1, Math.min(commandTimeout, deadline - performance.now())),
        options.signal
      )
      startupStage = 'held-status'
      if (initialStatus.held !== true) helperFailure = 'lock-not-held'
      else if (initialStatus.scratchBound !== true) helperFailure = 'scratch-not-bound'
      else if (initialStatus.windows !== 0) helperFailure = 'unexpected-window'
      heldStatus(initialStatus)
      checkAbort(options.signal)
      if (fault || didExit) throw Error('资料守护已失效。')
      break
    }
  } catch (error) {
    clearTimeout(timer)
    // cancel() itself rejects mutating/finishing transactions. Never bypass that protection.
    try {
      options.admission.cancel()
    } catch {
      /* Preserve an unfinished mutation and its guard. */
    }
    const removable = (): boolean =>
      !writers().some((w) => w.token === options.admission.token || w.phase === 'mutating')
    if (child && !didExit) {
      child.stdin.end()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      // The helper's durable-state watchdog decides whether exiting is safe. Never kill it.
      void exited
        .then(async () => {
          if (removable()) await cleanup()
        })
        .catch(() => {})
    } else {
      try {
        if (removable()) await cleanup()
      } catch {
        /* Keep evidence when cleanup is unverifiable. */
      }
    }
    throw new ProfileGuardError(
      error instanceof ProfileGuardError && error.reason === 'cancelled' ? 'cancelled' : 'startup',
      error instanceof ProfileGuardError && error.reason === 'cancelled'
        ? '已取消资料守护启动；未强制终止任何守护或阅读器。'
        : '资料守护启动未通过验证；停止更新并保留仍在使用的恢复记录。',
      directory,
      { stage: startupStage, exitCode: exit?.code, helperFailure }
    )
  }
  let checking: Promise<ProfileGuardStatus> | undefined
  const assertHeld = async (): Promise<ProfileGuardStatus> => {
    if (fault) throw fault
    if (released || releasing)
      throw new ProfileGuardError('release', '资料守护已进入释放阶段。', directory)
    checking ??= (async () => {
      try {
        const result = heldStatus(await command(pipe, controlToken, 'status', commandTimeout))
        if (fault || didExit) throw fault ?? Error()
        return result
      } catch {
        throw fail('无法确认资料守护仍完整持有锁，停止更新写入。')
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
    pid: child!.pid!,
    directory,
    signal: controller.signal,
    failure,
    exited,
    assertHeld,
    release() {
      if (released)
        return cleanup().catch(() => {
          throw new ProfileGuardError('cleanup', '守护已正常释放，临时记录清理失败。', directory)
        })
      if (releaseInFlight) return releaseInFlight
      releaseInFlight = (async () => {
        if (writers().some((w) => w.token === options.admission.token || w.phase === 'mutating'))
          throw new ProfileGuardError('release', '更新尚未验证完成，资料守护继续持锁。', directory)
        if (didExit) throw fail('守护已经退出，不能确认正常释放。')
        releasing = true
        clearTimeout(timer)
        try {
          // Finish any in-flight status exchange before release, so a normal unlock is not
          // mistaken for a heartbeat failure. A latched failure still permits verified cleanup.
          await checking?.catch(() => {})
          const result = await command(pipe, controlToken, 'release', commandTimeout)
          if (result.ok === false && result.error === 'update not completed')
            throw new ProfileGuardError(
              'release',
              '更新仍在进行，资料守护拒绝提前释放。',
              directory
            )
          if (result.ok !== true || result.released !== true) throw Error('资料守护未确认释放。')
          let exitTimer: ReturnType<typeof setTimeout> | undefined
          try {
            exit = await Promise.race([
              exited,
              new Promise<never>((_resolve, reject) => {
                exitTimer = setTimeout(() => reject(Error('资料守护未正常退出。')), exitTimeout)
              })
            ])
          } finally {
            clearTimeout(exitTimer)
          }
          if (exit.code !== 0 || exit.signal !== null) throw Error('资料守护退出异常。')
          released = true
          await cleanup()
        } catch (error) {
          if (error instanceof ProfileGuardError && error.reason === 'release') throw error
          if (released)
            throw new ProfileGuardError('cleanup', '守护已正常释放，临时记录清理失败。', directory)
          throw fail('资料守护未完成经确认的正常释放，保留恢复记录。')
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
