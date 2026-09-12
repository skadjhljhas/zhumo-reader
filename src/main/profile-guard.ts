import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isAbsolute, dirname, basename, join, relative, sep } from 'node:path'
import { physicalFsSync as fs } from './physical-fs'
import { assertProgramsClosed } from './update-process-guard'
import { inspectUpdateAdmission } from './update-admission'

interface GuardPlan {
  version: 1
  profile: string
  scratch: string
  coordinator: string
  updateToken: string
  controlToken: string
  appName: string
  programRoots: string[]
  /** Authenticated control traffic, rather than Windows GUI stdin availability, renews this. */
  controlContactTimeoutMs?: number
}
const contains = (a: string, b: string): boolean => {
  const p = relative(a.toLowerCase(), b.toLowerCase())
  return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep))
}
export async function runProfileGuard(): Promise<void> {
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  if (process.platform !== 'win32') throw Error('原生资料守护当前仅支持Windows。')
  const at = process.argv.indexOf('--zhumo-profile-guard'),
    planPath = process.argv[at + 1]
  if (at < 0 || !planPath || !isAbsolute(planPath) || process.argv.length !== at + 2)
    throw Error('资料守护需要明确的计划文件。')
  const raw = fs.readFileSync(planPath)
  if (raw.length > 65536) throw Error('资料守护计划过大。')
  let plan: GuardPlan
  try {
    plan = JSON.parse(raw.toString())
  } catch {
    throw Error('资料守护计划无效。')
  }
  if (
    plan.version !== 1 ||
    ![plan.profile, plan.scratch, plan.coordinator].every(
      (p) => typeof p === 'string' && isAbsolute(p)
    ) ||
    !/^[a-f0-9-]{36}$/.test(plan.updateToken) ||
    !/^[a-f0-9]{64}$/.test(plan.controlToken) ||
    typeof plan.appName !== 'string' ||
    !plan.appName ||
    plan.appName.length > 128 ||
    /[\\/\0]/.test(plan.appName) ||
    !Array.isArray(plan.programRoots) ||
    !plan.programRoots.length ||
    !plan.programRoots.every((p) => typeof p === 'string' && isAbsolute(p)) ||
    (plan.controlContactTimeoutMs !== undefined &&
      (!Number.isInteger(plan.controlContactTimeoutMs) ||
        plan.controlContactTimeoutMs < 1000 ||
        plan.controlContactTimeoutMs > 600000))
  )
    throw Error('资料守护计划无效。')
  const profile = fs.realpathSync.native(plan.profile),
    roots = plan.programRoots.map((p) => fs.realpathSync.native(p))
  const scratch = join(fs.realpathSync.native(dirname(plan.scratch)), basename(plan.scratch))
  if (
    !fs.statSync(profile).isDirectory() ||
    [profile, ...roots].some((p) => contains(p, scratch) || contains(scratch, p)) ||
    contains(profile, fs.realpathSync.native(planPath))
  )
    throw Error('守护临时资料和计划必须位于被保护目录之外。')
  const writer = inspectUpdateAdmission([profile], plan.coordinator).writers.find(
    (w) => w.token === plan.updateToken
  )
  if (!writer?.ownerAlive) throw Error('资料守护没有对应的有效更新协调者。')
  fs.mkdirSync(scratch, { mode: 0o700 })
  app.setName(plan.appName)
  app.setPath('userData', scratch)
  app.setPath('sessionData', scratch)
  app.disableHardwareAcceleration()
  // Starting Chromium in scratch first avoids binding its Local State to the real profile.
  await app.whenReady()
  await assertProgramsClosed(roots)
  let closing = false
  let held = false,
    blocked = 0,
    parentChannelClosed = false
  const controlContactTimeoutMs = plan.controlContactTimeoutMs ?? 10000
  let lastControlContact = performance.now(),
    inactiveSince = 0
  app.on('second-instance', () => {
    blocked++
  })
  app.on('browser-window-created', (_event, window) => window.destroy())
  try {
    app.setPath('userData', profile)
    held = app.requestSingleInstanceLock({ zhumoProfileGuard: true })
  } finally {
    app.setPath('userData', scratch)
  }
  if (!held) throw Error('目标资料仍由旧版使用，未取得守护。')
  const pipe = '\\\\.\\pipe\\zhumo-profile-guard-' + randomUUID()
  const server = createServer((socket) => {
    socket.on('error', () => {
      socket.destroy()
    })
    let buffer = ''
    socket.setTimeout(5000, () => socket.destroy())
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 4096) {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      let command: { token?: string; action?: string }
      try {
        command = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
      } catch {
        {
          socket.destroy()
          return
        }
      }
      buffer = ''
      if (
        !command ||
        typeof command !== 'object' ||
        typeof command.token !== 'string' ||
        command.token.length > 128
      ) {
        socket.end(JSON.stringify({ ok: false, error: 'unauthorized' }) + '\n')
        return
      }
      const supplied = Buffer.from(command.token ?? ''),
        expected = Buffer.from(plan.controlToken)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        socket.end(JSON.stringify({ ok: false, error: 'unauthorized' }) + '\n')
        return
      }
      if (command.action === 'status' || command.action === 'release') {
        lastControlContact = performance.now()
        inactiveSince = 0
      }
      if (command.action === 'status') {
        socket.end(
          JSON.stringify({
            ok: true,
            held: app.hasSingleInstanceLock(),
            windows: BrowserWindow.getAllWindows().length,
            blocked,
            parentChannelClosed,
            scratchBound: app.getPath('userData') === scratch
          }) + '\n'
        )
        return
      }
      if (command.action !== 'release') {
        socket.end(JSON.stringify({ ok: false, error: 'unknown action' }) + '\n')
        return
      }
      try {
        if (
          inspectUpdateAdmission([profile], plan.coordinator).writers.some(
            (writer) => writer.token === plan.updateToken || writer.phase === 'mutating'
          )
        ) {
          socket.end(JSON.stringify({ ok: false, error: 'update not completed' }) + '\n')
          return
        }
      } catch {
        socket.end(JSON.stringify({ ok: false, error: 'update state unverifiable' }) + '\n')
        return
      }
      app.releaseSingleInstanceLock()
      held = false
      closing = true
      socket.end(JSON.stringify({ ok: true, released: true }) + '\n', () => {
        server.close()
        app.quit()
      })
    })
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(pipe, done)
  })
  server.on('error', () => {
    console.error('[zhumo guard] 控制通道异常；资料锁未主动释放。')
  })
  const ready = {
    version: 1,
    pid: process.pid,
    pipe,
    held,
    updateToken: plan.updateToken,
    windows: BrowserWindow.getAllWindows().length,
    scratchBound: app.getPath('userData') === scratch,
    controlContactTimeoutMs
  }
  const file = fs.openSync(planPath + '.ready.json', 'wx', 0o600)
  try {
    fs.writeFileSync(file, JSON.stringify(ready, null, 2))
    fs.fsyncSync(file)
  } finally {
    fs.closeSync(file)
  }
  process.stdin.on('end', () => {
    parentChannelClosed = true
  })
  process.stdin.on('error', () => {
    parentChannelClosed = true
  })
  process.stdin.resume()
  const watch = setInterval(() => {
    if (!parentChannelClosed || closing) return
    // GUI Electron may report stdin unavailable even while its parent is alive. A successful
    // authenticated heartbeat is direct evidence that the coordinator is still supervising.
    if (performance.now() - lastControlContact < controlContactTimeoutMs) {
      inactiveSince = 0
      return
    }
    try {
      const active = inspectUpdateAdmission([profile], plan.coordinator).writers
      if (
        active.some((writer) => writer.token === plan.updateToken || writer.phase === 'mutating')
      ) {
        inactiveSince = 0
        return
      }
      inactiveSince ||= performance.now()
      if (performance.now() - inactiveSince < 2000) return
      // A lost parent may leave a harmless preparation guard behind. Only release after
      // the durable update state proves there is no unfinished mutation to protect.
      closing = true
      app.releaseSingleInstanceLock()
      held = false
      server.close()
      app.quit()
    } catch {
      inactiveSince = 0
    }
  }, 500)
  app.once('will-quit', () => clearInterval(watch))
  // Parent disconnection never releases a profile mid-update. A recovery coordinator can
  // reconnect to the authenticated local pipe using its retained transaction plan.
  process.stdout.write(JSON.stringify(ready) + '\n')
}
