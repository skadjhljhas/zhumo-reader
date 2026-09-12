import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { admitUpdate } from '../../src/main/update-admission'
import {
  createPreservationSnapshot,
  restorePreservationSnapshot
} from '../../src/main/update-preservation'
import { defaultAiProfile } from '../../src/shared/ai-types'
async function files(root: string, prefix = ''): Promise<string[]> {
  const all: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + item.name : item.name
    if (item.isDirectory()) all.push(...(await files(root, path)))
    else all.push(path)
  }
  return all.sort()
}
async function command(
  pipe: string,
  token: unknown,
  action: string
): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const socket = connect(pipe),
      chunks: Buffer[] = []
    socket.setTimeout(5000, () => {
      socket.destroy()
      reject(Error('Guard did not reply'))
    })
    socket.on('connect', () => socket.write(JSON.stringify({ token, action }) + '\n'))
    socket.on('data', (b) => {
      chunks.push(b)
      const text = Buffer.concat(chunks).toString()
      if (text.includes('\n')) {
        socket.end()
        done(JSON.parse(text.trim()))
      }
    })
    socket.on('error', reject)
  })
}
test('a scratch-initialized native guard blocks the real pre-admission reader without changing existing profile bytes or opening windows', async () => {
  test.setTimeout(120000)
  const oldArtifact =
    process.env.ZHUMO_LEGACY_TEST_DIR || resolve('../朱墨-AI细读/桌面候选24/win-unpacked')
  const root = await mkdtemp(join(tmpdir(), 'zhumo-native-guard-')),
    legacy = join(root, 'legacy'),
    profile = join(root, 'profile'),
    coord = join(root, 'coord')
  await cp(oldArtifact, legacy, { recursive: true })
  const oldExe = join(legacy, 'ZhuMo-AI.exe'),
    guardExe = process.env.ZHUMO_E2E_EXE || resolve('node_modules/electron/dist/electron.exe'),
    guardArgs = process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')]
  const legacyEnv = { ...process.env, ZHUMO_USER_DATA: profile, ZHUMO_TEST_BACKGROUND: '1' }
  let app: ElectronApplication | undefined, guard: ChildProcess | undefined
  let guardErrors = ''
  let gate: ReturnType<typeof admitUpdate> | undefined
  const launchGuard = (plan: string): ChildProcess => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(guardExe, [...guardArgs, '--zhumo-profile-guard', plan], {
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdout!.resume()
    child.stderr!.on('data', (chunk) => {
      guardErrors += chunk.toString()
    })
    return child
  }
  try {
    app = await electron.launch({ executablePath: oldExe, args: [], env: legacyEnv })
    const page = await app.firstWindow(),
      name = await app.evaluate(({ app }) => app.getName())
    await page.evaluate(async (defaults) => {
      await window.api.saveSettings({
        ...(await window.api.getSettings()),
        fontSize: 23,
        automaticSyntax: false
      })
      await window.ai!.saveProfile('reading', {
        ...defaults,
        model: 'fixture',
        endpoint: 'http://127.0.0.1:9/v1',
        apiKey: 'fixture-secret'
      })
      localStorage.setItem('zhumo.studio.theme', 'lucent')
    }, defaultAiProfile('reading'))
    gate = admitUpdate([profile], coord)
    const token = randomBytes(32).toString('hex'),
      plan = {
        version: 1,
        profile,
        coordinator: coord,
        updateToken: gate.token,
        controlToken: token,
        appName: name,
        programRoots: [legacy]
      }
    const busy = join(root, 'busy.json')
    await writeFile(busy, JSON.stringify({ ...plan, scratch: join(root, 'scratch-busy') }))
    guard = launchGuard(busy)
    const busyCode = await new Promise<number | null>((done, reject) => {
      guard!.once('error', reject)
      guard!.once('close', done)
    })
    guard = undefined
    expect(busyCode, guardErrors).toBe(74)
    expect(app.windows()).toHaveLength(1)
    gate.cancel()
    gate = undefined
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await closed
    app = undefined
    const beforeNames = await files(profile),
      hashes = new Map<string, string>()
    for (const file of beforeNames)
      hashes.set(
        file,
        createHash('sha256')
          .update(await readFile(join(profile, file)))
          .digest('hex')
      )
    gate = admitUpdate([profile], coord)
    const job = join(root, 'held.json')
    await writeFile(
      job,
      JSON.stringify({ ...plan, updateToken: gate.token, scratch: join(root, 'scratch-held') })
    )
    guard = launchGuard(job)
    await expect
      .poll(async () => Boolean(await readFile(job + '.ready.json').catch(() => undefined)), {
        timeout: 15000
      })
      .toBe(true)
    const ready = JSON.parse(await readFile(job + '.ready.json', 'utf8'))
    expect(ready).toMatchObject({ held: true, windows: 0, scratchBound: true })
    const status = await command(ready.pipe, token, 'status')
    expect(status).toMatchObject({ held: true, windows: 0, scratchBound: true })
    expect(await command(ready.pipe, '0'.repeat(64), 'release')).toMatchObject({
      ok: false,
      error: 'unauthorized'
    })
    expect(await command(ready.pipe, 12, 'status')).toMatchObject({
      ok: false,
      error: 'unauthorized'
    })
    expect(await command(ready.pipe, token, 'status')).toMatchObject({ held: true })
    expect(await command(ready.pipe, token, 'release')).toMatchObject({
      ok: false,
      error: 'update not completed'
    })
    gate.markMutating(join(root, 'transaction.json'))
    guard.stdin!.end()
    await expect
      .poll(async () => (await command(ready.pipe, token, 'status')).parentChannelClosed)
      .toBe(true)
    expect(ready.controlContactTimeoutMs).toBe(10000)
    // Stop all authenticated heartbeats beyond the production contact grace and cleanup
    // grace. A mutating durable transaction must continue to hold the native lock anyway.
    await new Promise((done) => setTimeout(done, ready.controlContactTimeoutMs + 3000))
    expect(await command(ready.pipe, token, 'status')).toMatchObject({ held: true, windows: 0 })
    const attempted = spawn(oldExe, [], { env: legacyEnv, windowsHide: true, stdio: 'ignore' })
    expect(
      await new Promise<number | null>((done, reject) => {
        const timer = setTimeout(() => attempted.kill(), 8000)
        attempted.once('error', reject)
        attempted.once('close', (code) => {
          clearTimeout(timer)
          done(code)
        })
      })
    ).toBe(0)
    expect((await command(ready.pipe, token, 'status')).blocked).toBeGreaterThan(0)
    for (const [file, hash] of hashes)
      expect(
        createHash('sha256')
          .update(await readFile(join(profile, file)))
          .digest('hex'),
        file
      ).toBe(hash)
    const extraDuring = (await files(profile)).filter((f) => !hashes.has(f))
    await createPreservationSnapshot([profile], join(root, 'snapshot'))
    await gate.complete(async () => {
      for (const [file, hash] of hashes)
        expect(
          createHash('sha256')
            .update(await readFile(join(profile, file)))
            .digest('hex'),
          file
        ).toBe(hash)
    })
    gate = undefined
    const exited = new Promise<void>((done) => guard!.once('close', () => done()))
    expect(await command(ready.pipe, token, 'release')).toMatchObject({ ok: true, released: true })
    await exited
    guard = undefined
    expect(await files(profile)).toEqual(beforeNames)
    for (const [file, hash] of hashes)
      expect(
        createHash('sha256')
          .update(await readFile(join(profile, file)))
          .digest('hex'),
        file
      ).toBe(hash)
    gate = admitUpdate([profile], coord)
    const orphanJob = join(root, 'orphan.json')
    await writeFile(
      orphanJob,
      JSON.stringify({ ...plan, updateToken: gate.token, scratch: join(root, 'scratch-orphan') })
    )
    guard = launchGuard(orphanJob)
    await expect
      .poll(async () => Boolean(await readFile(orphanJob + '.ready.json').catch(() => undefined)), {
        timeout: 15000
      })
      .toBe(true)
    guard.stdin!.end()
    const harmlessExit = new Promise<void>((done) => guard!.once('close', () => done()))
    const orphanReady = JSON.parse(await readFile(orphanJob + '.ready.json', 'utf8'))
    let unauthorizedReplies = 0
    // Unauthenticated traffic must not impersonate the lost coordinator or renew its lease.
    const unrelatedTraffic = setInterval(() => {
      void command(orphanReady.pipe, '0'.repeat(64), 'status')
        .then((reply) => {
          if (reply.ok === false && reply.error === 'unauthorized') unauthorizedReplies++
        })
        .catch(() => {})
    }, 400)
    gate.cancel()
    gate = undefined
    try {
      await harmlessExit
    } finally {
      clearInterval(unrelatedTraffic)
    }
    expect(unauthorizedReplies).toBeGreaterThan(0)
    guard = undefined
    const [restored] = await restorePreservationSnapshot(
      join(root, 'snapshot'),
      join(root, '恢复副本')
    )
    app = await electron.launch({ executablePath: oldExe, args: [], env: legacyEnv })
    expect(
      (await (await app.firstWindow()).evaluate(() => window.api.getSettings())).fontSize
    ).toBe(23)
    expect(
      (await (await app.firstWindow()).evaluate(() => window.ai!.getProfiles())).reading.keyStorage
    ).toBe('encrypted')
    const oldClosed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await oldClosed
    app = undefined
    app = await electron.launch({
      executablePath: oldExe,
      args: [],
      env: { ...legacyEnv, ZHUMO_USER_DATA: restored }
    })
    expect(
      (await (await app.firstWindow()).evaluate(() => window.api.getSettings())).fontSize
    ).toBe(23)
    expect(
      (await (await app.firstWindow()).evaluate(() => window.ai!.getProfiles())).reading.keyStorage
    ).toBe('encrypted')
    await mkdir('work/profile-guard', { recursive: true })
    await writeFile(
      'work/profile-guard/native-profile.json',
      JSON.stringify(
        {
          legacyVersion: '24',
          busyRejectedWithoutNewWindow: true,
          blockedLegacyRelaunch: true,
          existingProfileHashesUnchanged: true,
          extraDuring,
          afterReleaseFilesUnchanged: true,
          guardWindows: 0,
          parentDisconnectionRetainsGuard: true,
          mutationRetainsGuardBeyondExpiredAuthenticatedHeartbeat: true,
          releaseRequiresCompletedUpdate: true,
          snapshotWhileHeld: true,
          restoredSnapshotReopens: true,
          harmlessDisconnectedGuardExits: true,
          unauthenticatedTrafficCannotKeepOrphanAlive: true,
          invalidPeerDoesNotDropLock: true
        },
        null,
        2
      )
    )
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    try {
      gate?.cancel()
    } catch {
      /* Failed tests retain their mutating marker until this isolated fixture is removed. */
    }
    if (guard && guard.exitCode === null && guard.signalCode === null) {
      const dead = new Promise<void>((done) => guard!.once('close', () => done()))
      guard.kill()
      await dead
    }
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-native-guard-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
