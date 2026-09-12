import { it as platformTest, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  rename,
  link,
  symlink
} from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  reconnectProfileGuard,
  type RetainedProfileGuard,
  type RetainedProfileGuardExpected
} from '../../src/main/retained-profile-guard'
import {
  admitUpdate,
  inspectUpdateAdmission,
  type UpdateAdmission
} from '../../src/main/update-admission'
const it = process.platform === 'win32' ? platformTest : platformTest.skip
let root: string,
  directory: string,
  expected: RetainedProfileGuardExpected,
  controlToken: string,
  pipe: string
let plan: Record<string, unknown>, ready: Record<string, unknown>, server: Server
let guard: RetainedProfileGuard | undefined
let configuration: {
  status?: Record<string, unknown>
  broken?: 'close' | 'malformed' | 'oversize' | 'trickle'
  refuse?: boolean
  delay?: number
  beforeStatus?: () => Promise<void>
}
let contacts = 0,
  releases = 0
const sockets = new Set<Socket>(),
  gates: UpdateAdmission[] = []
async function savePlan(): Promise<void> {
  await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
}
async function saveReady(): Promise<void> {
  await writeFile(join(directory, 'plan.json.ready.json'), JSON.stringify(ready))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-retained-guard-'))
  directory = join(root, 'guard')
  expected = {
    profile: join(root, 'profile'),
    programRoots: [join(root, 'program')],
    coordinator: join(root, 'coord'),
    originalToken: randomUUID()
  }
  await Promise.all(
    [directory, expected.profile, expected.programRoots[0], expected.coordinator].map((p) =>
      mkdir(p)
    )
  )
  await mkdir(join(directory, 'scratch'))
  await writeFile(join(expected.profile, 'settings.json'), '{"fixture":"unchanged"}')
  controlToken = randomBytes(32).toString('hex')
  pipe = '\\\\.\\pipe\\zhumo-profile-guard-' + randomUUID()
  plan = {
    version: 1,
    profile: expected.profile,
    programRoots: [...expected.programRoots],
    coordinator: expected.coordinator,
    updateToken: expected.originalToken,
    scratch: join(directory, 'scratch'),
    appName: 'ZhuMo-fixture',
    controlToken,
    controlContactTimeoutMs: 1000
  }
  ready = {
    version: 1,
    pid: process.pid,
    pipe,
    held: true,
    updateToken: expected.originalToken,
    windows: 0,
    scratchBound: true,
    controlContactTimeoutMs: 1000
  }
  await savePlan()
  await saveReady()
  contacts = 0
  releases = 0
  configuration = {}
  server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (!buffer.includes('\n')) return
      const command = JSON.parse(buffer.trim())
      buffer = ''
      if (command.token !== controlToken) {
        socket.end(JSON.stringify({ ok: false, error: 'unauthorized:' + controlToken }) + '\n')
        return
      }
      if (command.action === 'release') {
        releases++
        socket.end(
          JSON.stringify(
            configuration.refuse
              ? { ok: false, error: 'update not completed' }
              : { ok: true, released: true }
          ) + '\n'
        )
        return
      }
      contacts++
      if (configuration.broken === 'close') {
        socket.destroy()
        return
      }
      if (configuration.broken === 'malformed') {
        socket.end('{bad}\n')
        return
      }
      if (configuration.broken === 'oversize') {
        socket.end('x'.repeat(5000))
        return
      }
      if (configuration.broken === 'trickle') {
        const timer = setInterval(() => socket.write(' '), 10)
        socket.once('close', () => clearInterval(timer))
        return
      }
      void (async () => {
        await configuration.beforeStatus?.()
        setTimeout(
          () =>
            socket.end(
              JSON.stringify({
                ok: true,
                held: true,
                windows: 0,
                scratchBound: true,
                parentChannelClosed: true,
                blocked: 3,
                ...configuration.status
              }) + '\n'
            ),
          configuration.delay ?? 0
        )
      })().catch(() => socket.destroy())
    })
  })
  await new Promise<void>((done) => server.listen(pipe, done))
})
afterEach(async () => {
  for (const gate of gates.splice(0).reverse()) {
    try {
      gate.cancel()
    } catch {
      await gate.complete(async () => {}).catch(() => {})
    }
  }
  if (guard) await guard.release().catch(() => {})
  guard = undefined
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((done) => server.close(() => done()))
  const rel = relative(await realpath(tmpdir()), await realpath(root))
  expect(rel.startsWith('zhumo-retained-guard-') && !rel.includes('..')).toBe(true)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it('authenticates the retained pipe, renews its heartbeat and releases without deleting records or profile data', async () => {
  const originalPlan = await readFile(join(directory, 'plan.json'))
  guard = await reconnectProfileGuard(directory, expected)
  expect(guard.pid).toBe(process.pid)
  expect(await guard.assertHeld()).toMatchObject({ held: true, parentChannelClosed: true })
  const initial = contacts
  await vi.waitFor(() => expect(contacts).toBeGreaterThan(initial))
  expect(guard.signal.aborted).toBe(false)
  await guard.release()
  expect(releases).toBe(1)
  expect(await readFile(join(directory, 'plan.json'))).toEqual(originalPlan)
  expect(await readdir(directory)).toEqual(
    expect.arrayContaining(['plan.json', 'plan.json.ready.json', 'scratch'])
  )
  expect(await readFile(join(expected.profile, 'settings.json'), 'utf8')).toBe(
    '{"fixture":"unchanged"}'
  )
  await guard.release()
  expect(releases).toBe(1)
})

it.each(['profile', 'programRoots', 'coordinator', 'updateToken', 'scratch'])(
  'rejects mismatching %s bindings without contacting a different pipe',
  async (field) => {
    const other = join(root, 'other')
    await mkdir(other)
    plan[field] =
      field === 'programRoots' ? [other] : field === 'updateToken' ? randomUUID() : other
    await savePlan()
    await expect(reconnectProfileGuard(directory, expected)).rejects.toMatchObject({
      reason: 'startup'
    })
    expect(contacts).toBe(0)
  }
)

it.each([
  { pid: 0 },
  { pid: '123' },
  { pipe: '\\\\remote\\pipe\\untrusted' },
  { scratchBound: false },
  { held: false },
  { windows: 1 },
  { controlContactTimeoutMs: 20 },
  { updateToken: randomUUID() }
])('rejects malformed ready metadata %j before authenticating', async (change) => {
  Object.assign(ready, change)
  await saveReady()
  await expect(reconnectProfileGuard(directory, expected)).rejects.toMatchObject({
    reason: 'startup'
  })
  expect(contacts).toBe(0)
})

it('never exposes the authentication secret when authentication fails', async () => {
  plan.controlToken = '0'.repeat(64)
  await savePlan()
  const error = await reconnectProfileGuard(directory, expected).catch((value) => value as Error)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).not.toContain(controlToken)
  expect((error as Error).message).not.toContain('0'.repeat(64))
  expect(JSON.stringify(error)).not.toContain(controlToken)
  expect(JSON.stringify(error)).not.toContain('0'.repeat(64))
  expect(await readdir(directory)).toHaveLength(3)
})

it('refuses release while the original admission exists and only sends it after cancellation', async () => {
  const gate = admitUpdate([expected.profile, ...expected.programRoots], expected.coordinator)
  gates.push(gate)
  expected.originalToken = gate.token
  plan.updateToken = gate.token
  ready.updateToken = gate.token
  await savePlan()
  await saveReady()
  guard = await reconnectProfileGuard(directory, expected)
  await expect(guard.release()).rejects.toMatchObject({ reason: 'release' })
  expect(releases).toBe(0)
  expect(guard.signal.aborted).toBe(false)
  gate.cancel()
  await guard.release()
  expect(releases).toBe(1)
})

it('reconnects after a crashed original writer is replaced by a new mutating recovery token', async () => {
  const resources = [expected.profile, ...expected.programRoots]
  const original = admitUpdate(resources, expected.coordinator)
  original.markMutating(join(root, 'transaction.json'))
  expected.originalToken = original.token
  plan.updateToken = original.token
  ready.updateToken = original.token
  await savePlan()
  await saveReady()
  // Model a crashed coordinator using this isolated fixture's metadata, never by killing a process.
  const statePath = join(expected.coordinator, 'states', original.token + '.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  state.pid = 2147483646
  state.birth = null
  for (const path of [
    statePath,
    ...state.resources.map((resource: string) =>
      join(
        expected.coordinator,
        createHash('sha256').update(resource.toLowerCase()).digest('hex'),
        'writers',
        original.token + '.json'
      )
    )
  ])
    await writeFile(path, JSON.stringify(state))
  const recovery = admitUpdate(resources, expected.coordinator, original.token)
  gates.push(recovery)
  expect(
    inspectUpdateAdmission(resources, expected.coordinator).writers.some(
      (w) => w.token === recovery.token && w.phase === 'mutating'
    )
  ).toBe(true)
  guard = await reconnectProfileGuard(directory, expected)
  expect(await guard.assertHeld()).toMatchObject({ held: true })
  await expect(guard.release()).rejects.toMatchObject({ reason: 'release' })
  expect(releases).toBe(0)
  await recovery.complete(async () => {})
  await guard.release()
  expect(releases).toBe(1)
})

it('also refuses a related program-only mutation, then permits a verified release retry', async () => {
  const gate = admitUpdate([...expected.programRoots], expected.coordinator)
  gate.markMutating(join(root, 'program-transaction.json'))
  gates.push(gate)
  guard = await reconnectProfileGuard(directory, expected)
  await expect(guard.release()).rejects.toMatchObject({ reason: 'release' })
  await gate.complete(async () => {})
  configuration.refuse = true
  await expect(guard.release()).rejects.toMatchObject({ reason: 'release' })
  expect(guard.signal.aborted).toBe(false)
  configuration.refuse = false
  await guard.release()
})

it.each(['close', 'malformed', 'oversize', 'trickle'] as const)(
  'permanently latches %s channel failure and leaves records',
  async (broken) => {
    guard = await reconnectProfileGuard(directory, expected)
    configuration.broken = broken
    await expect(guard.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
    expect(await guard.failure).toMatchObject({ reason: 'lost' })
    expect(guard.signal.aborted).toBe(true)
    configuration.broken = undefined
    await expect(guard.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
    expect(await readdir(directory)).toHaveLength(3)
  }
)

it('reports loss through the background heartbeat without explicit polling', async () => {
  guard = await reconnectProfileGuard(directory, expected)
  configuration.status = { held: false }
  expect(await guard.failure).toMatchObject({ reason: 'lost' })
  expect(guard.signal.aborted).toBe(true)
})

it('detects durable plan mutation even when the original authenticated server still responds', async () => {
  guard = await reconnectProfileGuard(directory, expected)
  plan.appName = 'tampered'
  await savePlan()
  await expect(guard.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
  expect(guard.signal.aborted).toBe(true)
})

it('latches replacement of the retained directory even when its original files still exist behind a junction', async () => {
  guard = await reconnectProfileGuard(directory, expected)
  const moved = join(root, 'moved-guard')
  await rename(directory, moved)
  await symlink(moved, directory, 'junction')
  await expect(guard.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
  expect(guard.signal.aborted).toBe(true)
  expect(await readFile(join(moved, 'plan.json'), 'utf8')).toContain('ZhuMo-fixture')
})

it('detects a ready-file replacement that occurs during a successful status exchange', async () => {
  guard = await reconnectProfileGuard(directory, expected)
  configuration.beforeStatus = async () => {
    configuration.beforeStatus = undefined
    await rename(join(directory, 'plan.json.ready.json'), join(root, 'old-ready.json'))
    await saveReady()
  }
  await expect(guard.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
})

it.each(['oversize-plan', 'hardlink-record', 'directory-junction'])(
  'rejects %s recovery records without changing them',
  async (kind) => {
    let entry = directory
    if (kind === 'oversize-plan') await writeFile(join(directory, 'plan.json'), 'x'.repeat(65537))
    if (kind === 'hardlink-record')
      await link(join(directory, 'plan.json'), join(root, 'linked-plan.json'))
    if (kind === 'directory-junction') {
      entry = join(root, 'alias')
      await symlink(directory, entry, 'junction')
    }
    await expect(reconnectProfileGuard(entry, expected)).rejects.toMatchObject({
      reason: 'startup'
    })
    expect(contacts).toBe(0)
  }
)

it('finishes an in-flight assertion before release without a false lost-lock event', async () => {
  guard = await reconnectProfileGuard(directory, expected)
  configuration.delay = 80
  const status = guard.assertHeld()
  const release = guard.release()
  await expect(status).resolves.toMatchObject({ held: true })
  await release
  expect(guard.signal.aborted).toBe(false)
})
