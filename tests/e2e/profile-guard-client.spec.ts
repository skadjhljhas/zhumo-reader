import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, backgroundTests } from './runtime'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, cp, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { admitUpdate, type UpdateAdmission } from '../../src/main/update-admission'
import {
  startProfileGuard,
  ProfileGuardError,
  type ProfileGuardClient
} from '../../src/main/profile-guard-client'
import { defaultAiProfile } from '../../src/shared/ai-types'

async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + item.name : item.name
    if (item.isSymbolicLink()) throw Error('This isolated profile must not contain links')
    if (item.isDirectory()) result.push(...(await files(root, path)))
    else result.push(path)
  }
  return result.sort()
}
async function hash(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}
async function closeReader(reader: ElectronApplication): Promise<void> {
  const closed = reader.waitForEvent('close', { timeout: 15000 })
  await reader.evaluate(({ app }) => app.quit())
  await closed
}
async function attemptLegacyLaunch(
  executable: string,
  env: NodeJS.ProcessEnv
): Promise<number | null> {
  const child = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' })
  return new Promise((done, reject) => {
    // A regression might open our isolated old reader instead of forwarding to the guard.
    // This timeout owns only that one test child, never the guard or a user's running reader.
    const timeout = setTimeout(() => {
      child.kill()
      reject(Error('The isolated old reader did not forward its launch to the profile guard'))
    }, 10000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      done(code)
    })
  })
}

test('the production client supervises the actual native profile lock and preserves the old profile bytes through verified release', async () => {
  const testInfo = test.info()
  test.skip(process.platform !== 'win32', 'The native profile guard is Windows-only')
  test.skip(
    !backgroundTests,
    'This integration is deliberately restricted to hidden, isolated readers'
  )
  test.setTimeout(120000)
  const oldArtifact =
      process.env.ZHUMO_LEGACY_TEST_DIR || resolve('../朱墨-AI细读/桌面候选24/win-unpacked'),
    root = await mkdtemp(join(tmpdir(), 'zhumo-guard-client-native-')),
    legacy = join(root, 'legacy'),
    profile = join(root, 'profile'),
    coordinator = join(root, 'coord'),
    workParent = join(root, 'guard-work')
  const guardExecutable =
      process.env.ZHUMO_E2E_EXE || resolve('node_modules/electron/dist/electron.exe'),
    guardArgs = process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')]
  const env = {
    ...process.env,
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: coordinator,
    ZHUMO_TEST_BACKGROUND: '1'
  }
  // Match the production client's environment rule for the isolated legacy launches too.
  for (const name of Object.keys(env))
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[name]
  let reader: ElectronApplication | undefined, gate: UpdateAdmission | undefined
  let guard: ProfileGuardClient | undefined
  let guardStarted = false,
    guardExited = false
  try {
    // The original candidate is strictly read-only input. All executable/profile writes below
    // are under a new system-temp directory; no real reader settings or manuscripts are used.
    await cp(oldArtifact, legacy, { recursive: true })
    await mkdir(workParent)
    const oldExe = join(legacy, 'ZhuMo-AI.exe')
    reader = await electron.launch({ executablePath: oldExe, args: [], env })
    const page = await reader.firstWindow(),
      appName = await reader.evaluate(({ app }) => app.getName())
    await page.evaluate(async (defaults) => {
      await window.api.saveSettings({
        ...(await window.api.getSettings()),
        fontSize: 23,
        automaticSyntax: false
      })
      await window.ai!.saveProfile('reading', {
        ...defaults,
        model: 'fixture-never-called',
        endpoint: 'http://127.0.0.1:9/v1',
        apiKey: 'isolated-fixture-not-a-real-key'
      })
      localStorage.setItem('zhumo.studio.theme', 'lucent')
    }, defaultAiProfile('reading'))
    await closeReader(reader)
    reader = undefined

    const beforeNames = await files(profile),
      before = new Map<string, string>()
    for (const file of beforeNames) before.set(file, await hash(join(profile, file)))
    const assertOriginalBytes = async (): Promise<void> => {
      for (const [file, digest] of before)
        expect(await hash(join(profile, file)), file).toBe(digest)
    }
    gate = admitUpdate([profile, legacy], coordinator)
    guardStarted = true
    guard = await startProfileGuard({
      executable: guardExecutable,
      args: guardArgs,
      profile,
      programRoots: [legacy],
      coordinator,
      workParent,
      appName,
      admission: gate
    })
    const guardedDirectory = guard.directory
    expect(await guard.assertHeld()).toMatchObject({
      held: true,
      windows: 0,
      scratchBound: true,
      parentChannelClosed: expect.any(Boolean)
    })
    expect(guard.signal.aborted).toBe(false)

    // This transaction intentionally has no file mutations. The real marker exercises the
    // refusal contract, and the verification below proves that old profile bytes stayed intact.
    gate.markMutating(join(root, 'no-file-mutations.transaction.json'))
    await expect(guard.release()).rejects.toMatchObject({ reason: 'release' })
    expect(await attemptLegacyLaunch(oldExe, env)).toBe(0)
    await expect.poll(async () => (await guard!.assertHeld()).blocked).toBeGreaterThan(0)
    expect(await guard.assertHeld()).toMatchObject({ held: true, windows: 0, scratchBound: true })
    await assertOriginalBytes()
    const addedWhileHeld = (await files(profile)).filter((file) => !before.has(file))
    expect(addedWhileHeld).toEqual(['lockfile'])

    await gate.complete(assertOriginalBytes)
    gate = undefined
    // Exceed both the production control-contact lease and the orphan confirmation window.
    // Merely replacing the old 2-second timeout with a longer fixed timeout cannot pass this.
    const ready = JSON.parse(await readFile(join(guard.directory, 'plan.json.ready.json'), 'utf8'))
    expect(ready.controlContactTimeoutMs).toBe(10000)
    const completedAdmissionHeartbeatWaitMs = ready.controlContactTimeoutMs + 3500
    await new Promise((done) => setTimeout(done, completedAdmissionHeartbeatWaitMs))
    expect(await guard.assertHeld()).toMatchObject({ held: true, windows: 0, scratchBound: true })
    expect(guard.signal.aborted).toBe(false)
    await guard.release()
    expect(await guard.exited).toEqual({ code: 0, signal: null })
    guardExited = true
    expect(guard.signal.aborted).toBe(false)
    expect(await readdir(workParent)).toEqual([])
    expect(await files(profile)).toEqual(beforeNames)
    await assertOriginalBytes()

    reader = await electron.launch({ executablePath: oldExe, args: [], env })
    const reopened = await reader.firstWindow()
    expect((await reopened.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect((await reopened.evaluate(() => window.ai!.getProfiles())).reading.keyStorage).toBe(
      'encrypted'
    )
    expect(await reopened.evaluate(() => localStorage.getItem('zhumo.studio.theme'))).toBe('lucent')
    await closeReader(reader)
    reader = undefined
    await testInfo.attach('native-profile-guard-client', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          executionMode: 'background-renderer',
          legacyVersion: '24',
          nativeLockSupervisedByProductionClient: true,
          legacyRelaunchBlockedWithoutWindow: true,
          mutatingReleaseRefused: true,
          completedAdmissionRetainsGuardWithLiveHeartbeatsBeyondThreeSeconds: true,
          completedAdmissionHeartbeatWaitMs,
          originalProfileFileCount: beforeNames.length,
          originalProfileHashesUnchangedWhileHeldAndAfterRelease: true,
          addedWhileHeld,
          guardExitCode: 0,
          ownDirectoryRemoved: !(await readdir(workParent)).includes(
            relative(workParent, guardedDirectory)
          ),
          reopenedFontSize: 23,
          encryptedFixtureKeyRetained: true,
          realApiCalls: 0
        },
        null,
        2
      )
    })
  } catch (error) {
    if (error instanceof ProfileGuardError && error.diagnostic)
      await testInfo.attach('guard-startup-diagnostic', {
        contentType: 'application/json',
        body: JSON.stringify(error.diagnostic)
      })
    throw error
  } finally {
    if (reader) {
      await closeReader(reader).catch(() =>
        reader!.evaluate(({ app }) => app.exit(1)).catch(() => {})
      )
    }
    if (gate) {
      try {
        gate.cancel()
      } catch {
        // This isolated transaction never changes any files: there is no outstanding update
        // mutation to undo. Finalizing it in teardown must not hide assertions failed above.
        await gate.complete(async () => {})
      }
    }
    if (guard && !guardExited) {
      await guard
        .release()
        .then(() => {
          guardExited = true
        })
        .catch(() => {})
    }
    if (guardStarted && !guard) {
      // Startup cancellation owns its cleanup; wait briefly for the helper's durable-state
      // watchdog. Do not delete a directory that could still hold an active helper's plan.
      await expect
        .poll(() => readdir(workParent), { timeout: 6000 })
        .toEqual([])
        .then(() => {
          guardExited = true
        })
        .catch(() => {})
    }
    if (!guardStarted || guardExited) {
      const rel = relative(await realpath(tmpdir()), await realpath(root))
      expect(rel.startsWith('zhumo-guard-client-native-') && !rel.includes('..')).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } else {
      await testInfo.attach('retained-isolated-guard-fixture', {
        contentType: 'text/plain',
        body: root
      })
    }
  }
})
