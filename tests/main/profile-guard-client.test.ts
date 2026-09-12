import { it as platformTest, expect, beforeEach, afterEach, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  startProfileGuard,
  type ProfileGuardClient,
  type ProfileGuardOptions
} from '../../src/main/profile-guard-client'
import {
  admitUpdate,
  inspectUpdateAdmission,
  type UpdateAdmission
} from '../../src/main/update-admission'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof childProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const it = process.platform === 'win32' ? platformTest : platformTest.skip

// A real Node child/pipe, never Electron or a native profile lock. It implements the guard wire
// contract so these tests exercise the client's actual spawning, cancellation and supervision.
const worker = String.raw`
const fs = require('node:fs'), net = require('node:net'), crypto = require('node:crypto');
const planPath = process.argv[2], configPath = process.argv[3], plan = JSON.parse(fs.readFileSync(planPath));
const config = () => JSON.parse(fs.readFileSync(configPath));
const active = () => {
  try { return JSON.parse(fs.readFileSync(require('node:path').join(plan.coordinator, 'states', plan.updateToken + '.json'))).phase !== 'complete'; }
  catch { return true; }
};
let parentClosed = false;
process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
process.stdin.on('end', () => { parentClosed = true; }); process.stdin.on('error', () => { parentClosed = true; }); process.stdin.resume();
setInterval(() => {
  const c = config();
  if (typeof c.exitCode === 'number') process.exit(c.exitCode);
  if (parentClosed && !active()) process.exit(0);
}, 30);
const pipe = '\\\\.\\pipe\\zhumo-profile-guard-' + crypto.randomUUID();
const server = net.createServer(socket => {
  socket.on('error', () => {}); let b = '';
  socket.on('data', chunk => {
    b += chunk.toString(); if (!b.includes('\n')) return;
    const command = JSON.parse(b.trim()), c = config(); b = '';
    if (command.token !== plan.controlToken) return socket.end(JSON.stringify({ok:false,error:'unauthorized'}) + '\n');
    if (command.action === 'release') {
      if (active() || c.refuseRelease) return socket.end(JSON.stringify({ok:false,error:'update not completed'}) + '\n');
      socket.end(JSON.stringify({ok:true,released:true}) + '\n', () => setTimeout(() => process.exit(0), 10));
      return;
    }
    if (c.status === 'close') return socket.destroy();
    if (c.status === 'hang') return;
    if (c.status === 'trickle') { const t = setInterval(() => socket.write(' '), 10); socket.on('close', () => clearInterval(t)); return; }
    if (c.status === 'oversize') return socket.end('x'.repeat(5000));
    if (c.status === 'malformed') return socket.end('{bad}\n');
    const result = {ok:true,held:true,windows:0,scratchBound:true,blocked:0,parentChannelClosed:parentClosed,...c.statusOverride};
    setTimeout(() => socket.end(JSON.stringify(result) + '\n'), c.delay || 0);
  });
});
server.listen(pipe, () => {
  const c = config();
  if (c.noReady) return;
  const ready = JSON.stringify({version:1,pid:process.pid,pipe,held:true,updateToken:plan.updateToken,windows:0,scratchBound:true,controlContactTimeoutMs:plan.controlContactTimeoutMs,...c.ready});
  if (c.partialReady) {
    fs.writeFileSync(planPath + '.ready.json', '{');
    setTimeout(() => fs.writeFileSync(planPath + '.ready.json', ready), 100);
  } else fs.writeFileSync(planPath + '.ready.json', ready);
});
`
let root: string, script: string, configPath: string
let options: ProfileGuardOptions, admission: UpdateAdmission
let client: ProfileGuardClient | undefined
const owned: childProcess.ChildProcess[] = []
const originalSpawn = (await vi.importActual<typeof childProcess>('node:child_process')).spawn
let captured: childProcess.SpawnOptions | undefined
async function config(value: Record<string, unknown>): Promise<void> {
  // Atomic publication prevents this fixture, too, from seeing partially-written JSON.
  const { rename } = await import('node:fs/promises')
  await writeFile(configPath + '.pending', JSON.stringify(value))
  await rename(configPath + '.pending', configPath)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-guard-client-'))
  script = join(root, 'guard-fixture.cjs')
  configPath = join(root, 'config.json')
  await writeFile(script, worker)
  await config({})
  const profile = join(root, 'profile'),
    program = join(root, 'program'),
    workParent = join(root, 'work')
  await Promise.all([profile, program, workParent].map((p) => mkdir(p)))
  await writeFile(join(profile, 'manuscript.md'), '# untouched')
  admission = admitUpdate([profile, program], join(root, 'coord'))
  options = {
    executable: process.execPath,
    profile,
    programRoots: [program],
    workParent,
    coordinator: join(root, 'coord'),
    appName: 'ZhuMo-test',
    admission,
    startupTimeoutMs: 2500,
    commandTimeoutMs: 350,
    heartbeatMs: 1000,
    exitTimeoutMs: 2000
  }
  vi.mocked(childProcess.spawn).mockImplementation(((exe, args, spawnOptions) => {
    captured = spawnOptions
    expect(exe).toBe(process.execPath)
    expect(args![args!.length - 2]).toBe('--zhumo-profile-guard')
    const child = originalSpawn(
      process.execPath,
      [script, args![args!.length - 1], configPath],
      spawnOptions
    )
    owned.push(child)
    return child
  }) as typeof childProcess.spawn)
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    admission.cancel()
  } catch {
    await admission.complete(async () => {})
  }
  if (client) await client.release().catch(() => {})
  client = undefined
  for (const child of owned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      // Only test-owned Node fixtures. Production client deliberately has no kill path.
      const closed = new Promise<void>((done) => child.once('close', () => done()))
      child.kill()
      await closed
    }
  }
  const rel = relative(await realpath(tmpdir()), await realpath(root))
  expect(rel.startsWith('zhumo-guard-client-') && !rel.includes('..')).toBe(true)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

it('starts hidden with authenticated identity, strips Node mode, and cleans only its own scratch after confirmed exit', async () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    client = await startProfileGuard(options)
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previous
  }
  expect(captured).toMatchObject({
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  expect(
    Object.keys(captured!.env!).some((name) => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE')
  ).toBe(false)
  expect((await client.assertHeld()).held).toBe(true)
  expect(client.pid).toBe(owned[0].pid)
  await expect(client.release()).rejects.toMatchObject({ reason: 'release' })
  expect(client.signal.aborted).toBe(false)
  expect(owned[0].exitCode).toBeNull()
  admission.cancel()
  const directory = client.directory
  await client.release()
  expect(await client.exited).toMatchObject({ code: 0, signal: null })
  expect(client.signal.aborted).toBe(false)
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(options.profile, 'manuscript.md'), 'utf8')).toBe('# untouched')
  expect(await readdir(options.profile)).toEqual(['manuscript.md'])
})

it.each([
  { pid: 1 },
  { updateToken: '00000000-0000-0000-0000-000000000000' },
  { pipe: '\\\\remote-host\\pipe\\arbitrary' },
  { windows: 1 },
  { scratchBound: false },
  { controlContactTimeoutMs: 0 }
])('rejects a ready identity mismatch %j before returning a usable guard', async (ready) => {
  await config({ ready })
  await expect(startProfileGuard(options)).rejects.toMatchObject({ reason: 'startup' })
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers).toEqual([])
  await vi.waitFor(() => expect(owned[0].exitCode).toBe(0))
  await vi.waitFor(async () => expect(await readdir(options.workParent)).toEqual([]))
})

it('waits through the ready file first partial write instead of failing startup', async () => {
  await config({ partialReady: true })
  client = await startProfileGuard(options)
  expect(await client.assertHeld()).toMatchObject({ held: true })
})

it('accepts a live authenticated native guard when Windows GUI stdin is unavailable', async () => {
  await config({ statusOverride: { parentChannelClosed: true } })
  client = await startProfileGuard(options)
  expect(await client.assertHeld()).toMatchObject({ held: true, parentChannelClosed: true })
  expect(client.signal.aborted).toBe(false)
  admission.markMutating(join(root, 'transaction.json'))
  await expect(client.release()).rejects.toMatchObject({ reason: 'release' })
  await admission.complete(async () => {})
  await client.release()
  expect(client.signal.aborted).toBe(false)
})

it('cancels startup preparation and lets the helper leave without force termination', async () => {
  await config({ noReady: true })
  const signal = new AbortController()
  const result = startProfileGuard({ ...options, signal: signal.signal })
  const rejection = expect(result).rejects.toMatchObject({ reason: 'cancelled' })
  await vi.waitFor(() => expect(owned).toHaveLength(1))
  signal.abort()
  await rejection
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers).toEqual([])
  await vi.waitFor(() => expect(owned[0].exitCode).toBe(0))
  await vi.waitFor(async () => expect(await readdir(options.workParent)).toEqual([]))
})

it('retains a mutating transaction and its live helper when startup is cancelled', async () => {
  await config({ noReady: true })
  const signal = new AbortController()
  const result = startProfileGuard({ ...options, signal: signal.signal })
  const rejection = expect(result).rejects.toMatchObject({ reason: 'cancelled' })
  await vi.waitFor(() => expect(owned).toHaveLength(1))
  admission.markMutating(join(root, 'transaction.json'))
  signal.abort()
  await rejection
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers[0].phase).toBe(
    'mutating'
  )
  expect(owned[0].exitCode).toBeNull()
  expect(await readdir(options.workParent)).toHaveLength(1)
  await admission.complete(async () => {})
  await vi.waitFor(() => expect(owned[0].exitCode).toBe(0))
})

it.each(['close', 'malformed', 'oversize', 'trickle'])(
  'latches %s channel failure without killing a still-protecting helper',
  async (status) => {
    client = await startProfileGuard(options)
    admission.markMutating(join(root, 'transaction.json'))
    await config({ status })
    await expect(client.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
    expect(await client.failure).toMatchObject({ reason: 'lost' })
    expect(client.signal.aborted).toBe(true)
    expect(owned[0].exitCode).toBeNull()
    await config({})
    await expect(client.assertHeld()).rejects.toMatchObject({ reason: 'lost' })
    await expect(client.release()).rejects.toMatchObject({ reason: 'release' })
    await admission.complete(async () => {})
    await client.release()
  }
)

it('heartbeat reports a spontaneous child exit even without an explicit assert call', async () => {
  client = await startProfileGuard(options)
  admission.markMutating(join(root, 'transaction.json'))
  await config({ exitCode: 7 })
  expect(await client.failure).toMatchObject({ reason: 'lost' })
  expect(client.signal.aborted).toBe(true)
  expect(await client.exited).toMatchObject({ code: 7 })
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers[0].phase).toBe(
    'mutating'
  )
  expect(await readdir(options.workParent)).toHaveLength(1)
})

it('heartbeat checks the held state and rejects silent loss even while the process stays alive', async () => {
  client = await startProfileGuard({ ...options, heartbeatMs: 30 })
  await config({ statusOverride: { held: false } })
  expect(await client.failure).toMatchObject({ reason: 'lost' })
  expect(owned[0].exitCode).toBeNull()
})

it('serializes an in-flight status exchange before release and permits retry after a server refusal', async () => {
  client = await startProfileGuard(options)
  await config({ delay: 100, refuseRelease: true })
  const status = client.assertHeld()
  admission.cancel()
  await expect(client.release()).rejects.toMatchObject({ reason: 'release' })
  await expect(status).resolves.toMatchObject({ held: true })
  expect(client.signal.aborted).toBe(false)
  await config({})
  await client.release()
  expect(client.signal.aborted).toBe(false)
})

it('startup timeout releases only a preparation admission and preserves the original error category', async () => {
  await config({ noReady: true })
  await expect(startProfileGuard({ ...options, startupTimeoutMs: 400 })).rejects.toMatchObject({
    reason: 'startup'
  })
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers).toEqual([])
  await vi.waitFor(() => expect(owned[0].exitCode).toBe(0))
})

it('handles an asynchronous spawn failure without waiting for an exit event that never occurs', async () => {
  vi.mocked(childProcess.spawn).mockImplementationOnce(((_exe, args, spawnOptions) => {
    const child = originalSpawn(join(root, 'missing-executable.exe'), args, spawnOptions)
    owned.push(child)
    return child
  }) as typeof childProcess.spawn)
  await expect(startProfileGuard(options)).rejects.toMatchObject({ reason: 'startup' })
  expect(inspectUpdateAdmission([options.profile], options.coordinator).writers).toEqual([])
  await vi.waitFor(async () => expect(await readdir(options.workParent)).toEqual([]))
})
