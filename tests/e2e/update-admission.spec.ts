import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, assertBackgroundWindow } from './runtime'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { admitUpdate, inspectUpdateAdmission } from '../../src/main/update-admission'

test('a real reader cannot touch its profile during an update or after an updater crash, and explicit verified recovery restores admission', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-admission-ui-')),
    profile = join(root, '资料'),
    coord = join(root, '协调'),
    txn = join(root, 'transaction.json')
  const exe = process.env.ZHUMO_E2E_EXE || resolve('node_modules/electron/dist/electron.exe')
  const args = process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')]
  await mkdir(profile)
  const bytes = Buffer.from('{"fontSize":23,"automaticSyntax":false}')
  await writeFile(join(profile, 'settings.json'), bytes)
  let app: ElectronApplication | undefined, worker: ChildProcess | undefined
  const blockedLaunch = async (selectedProfile = profile): Promise<number | null> =>
    new Promise((done, reject) => {
      const child = spawn(exe, args, {
        windowsHide: true,
        env: {
          ...process.env,
          ZHUMO_USER_DATA: selectedProfile,
          ZHUMO_TEST_BACKGROUND: '1',
          ZHUMO_UPDATE_COORDINATION: coord
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.resume()
      child.stderr.resume()
      const timer = setTimeout(() => child.kill(), 12000)
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(timer)
        done(code)
      })
    })
  try {
    const gate = admitUpdate([profile], coord)
    expect(await blockedLaunch()).toBe(73)
    expect(await readdir(profile)).toEqual(['settings.json'])
    expect(await readFile(join(profile, 'settings.json'))).toEqual(bytes)
    gate.cancel()
    app = await electron.launch({
      executablePath: exe,
      args,
      env: { ...process.env, ZHUMO_USER_DATA: profile, ZHUMO_UPDATE_COORDINATION: coord }
    })
    const page = await app.firstWindow()
    expect((await page.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect(() => admitUpdate([profile], coord)).toThrow('正常保存并退出')
    if (process.env.ZHUMO_E2E_EXE)
      expect(() => admitUpdate([dirname(exe)], coord)).toThrow('正常保存并退出')
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await closed
    app = undefined
    const afterClose = await readFile(join(profile, 'settings.json'))
    if (process.env.ZHUMO_E2E_EXE) {
      const other = join(root, '另一资料')
      await mkdir(other)
      await writeFile(join(other, 'settings.json'), bytes)
      const gate = admitUpdate([dirname(exe)], coord)
      expect(await blockedLaunch(other)).toBe(73)
      expect(await readdir(other)).toEqual(['settings.json'])
      gate.cancel()
    }
    const driver = join(root, 'updater.cjs')
    await writeFile(
      driver,
      `const fs=require('node:fs');const [modulePath,profile,coord,txn,phase]=process.argv.slice(2);const gate=require(modulePath).admitUpdate([profile],coord);if(phase==='mutating'){fs.writeFileSync(txn,'test transaction');gate.markMutating(txn);fs.writeFileSync(require('node:path').join(profile,'settings.json'),'{"fontSize":21,"automaticSyntax":false}');}process.stdout.write(JSON.stringify({token:gate.token})+'\\n');setInterval(()=>{},1000);`
    )
    const startWorker = async (phase: string): Promise<string> => {
      worker = spawn(
        process.execPath,
        [driver, resolve('out/main/update-admission.js'), profile, coord, txn, phase],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      return new Promise<string>((done, reject) => {
        let output = ''
        worker!.stdout!.on('data', (chunk) => {
          output += chunk.toString()
          if (output.includes('\n')) done(JSON.parse(output.trim()).token)
        })
        worker!.stderr!.resume()
        worker!.once('error', reject)
        worker!.once('close', () => {
          if (!output.includes('\n')) reject(Error('Updater exited before admission'))
        })
      })
    }
    const stopWorker = async (): Promise<void> => {
      const dead = new Promise<void>((done) => worker!.once('close', () => done()))
      worker!.kill()
      await dead
      worker = undefined
    }
    await startWorker('preparing')
    await stopWorker()
    app = await electron.launch({
      executablePath: exe,
      args,
      env: { ...process.env, ZHUMO_USER_DATA: profile, ZHUMO_UPDATE_COORDINATION: coord }
    })
    const cleaned = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await cleaned
    app = undefined
    const token = await startWorker('mutating')
    await stopWorker()
    expect(inspectUpdateAdmission([profile], coord).writers[0]).toMatchObject({
      token,
      phase: 'mutating',
      ownerAlive: false
    })
    const incomplete = await readFile(join(profile, 'settings.json'))
    expect(await blockedLaunch()).toBe(73)
    expect(await readFile(join(profile, 'settings.json'))).toEqual(incomplete)
    const recovery = admitUpdate([profile], coord, token)
    expect(await blockedLaunch()).toBe(73)
    await writeFile(join(profile, 'settings.json'), afterClose)
    await recovery.complete(async () => {
      expect(await readFile(join(profile, 'settings.json'))).toEqual(afterClose)
    })
    expect(inspectUpdateAdmission([profile], coord).writers).toEqual([])
    app = await electron.launch({
      executablePath: exe,
      args,
      env: { ...process.env, ZHUMO_USER_DATA: profile, ZHUMO_UPDATE_COORDINATION: coord }
    })
    expect(
      (await (await app.firstWindow()).evaluate(() => window.api.getSettings())).fontSize
    ).toBe(23)
    const exited = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await exited
    app = undefined
    await mkdir('work/update-admission', { recursive: true })
    await writeFile(
      'work/update-admission/reader-recovery.json',
      JSON.stringify(
        {
          blockedBeforeProfileWrite: true,
          liveReaderBlocksUpdate: true,
          abandonedPreparationDoesNotBlockReader: true,
          sharedProgramProtectsOtherProfiles: Boolean(process.env.ZHUMO_E2E_EXE),
          deadMutatingOwnerStillBlocksReader: true,
          verifiedRecoveryAllowsReader: true,
          restoredFontSize: 23,
          legacyVersionsCovered: false,
          scope: 'new cooperating readers and updater admission, not a full installer transaction'
        },
        null,
        2
      )
    )
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    if (worker) {
      const exited = new Promise<void>((done) => worker!.once('close', () => done()))
      worker.kill()
      await exited
    }
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-admission-ui-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('racing independent reader and updater processes cannot both enter a shared resource', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-admission-race-')),
    profile = join(root, 'profile'),
    coord = join(root, 'coord'),
    script = join(root, 'contender.cjs')
  const workers: ChildProcess[] = []
  try {
    await writeFile(
      script,
      `const [modulePath,role,profile,coord]=process.argv.slice(2),api=require(modulePath);let gate,attempts=0;function finish(value){process.stdout.write(value+'\\n');process.stdin.once('data',()=>{if(gate)gate.cancel();process.exit(0);});}function attempt(){try{if(role==='writer')gate=api.admitUpdate([profile],coord);else api.admitReader([profile],coord);finish('entered');}catch(e){if(['updating','readers'].includes(e.reason)&&attempts++<15)setTimeout(attempt,15+Math.random()*35);else finish('denied:'+e.reason);}}process.stdin.once('data',attempt);process.stdout.write('armed\\n');`
    )
    const rounds: Array<{ readers: number; writers: number }> = []
    for (let round = 0; round < 4; round++) {
      const group = Array.from({ length: 6 }, (_, index) => {
        const role = index % 2 ? 'writer' : 'reader'
        const child = spawn(
          process.execPath,
          [script, resolve('out/main/update-admission.js'), role, profile, coord],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
        workers.push(child)
        child.stderr.resume()
        let ready!: () => void,
          settled!: (v: string) => void,
          output = ''
        const armed = new Promise<void>((done) => {
            ready = done
          }),
          outcome = new Promise<string>((done) => {
            settled = done
          })
        child.stdout.on('data', (chunk) => {
          output += chunk.toString()
          while (output.includes('\n')) {
            const index = output.indexOf('\n'),
              line = output.slice(0, index)
            output = output.slice(index + 1)
            if (line === 'armed') ready()
            else settled(line)
          }
        })
        return { child, role, armed, outcome }
      })
      await Promise.all(group.map((p) => p.armed))
      for (const p of group) p.child.stdin.write('go\n')
      const results = await Promise.all(group.map((p) => p.outcome))
      expect(
        results.every((r) => ['entered', 'denied:updating', 'denied:readers'].includes(r))
      ).toBe(true)
      const readers = group.filter(
          (p, index) => p.role === 'reader' && results[index] === 'entered'
        ).length,
        writers = group.filter(
          (p, index) => p.role === 'writer' && results[index] === 'entered'
        ).length
      expect(writers).toBeLessThanOrEqual(1)
      expect(readers + writers).toBeGreaterThan(0)
      if (writers) expect(readers).toBe(0)
      rounds.push({ readers, writers })
      await Promise.all(
        group.map(
          (p) =>
            new Promise<void>((done) => {
              p.child.once('close', () => done())
              p.child.stdin.write('exit\n')
            })
        )
      )
      workers.splice(0)
    }
    await mkdir('work/update-admission', { recursive: true })
    await writeFile(
      'work/update-admission/races.json',
      JSON.stringify({ processesPerRound: 6, rounds, mutualExclusion: true }, null, 2)
    )
  } finally {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((done) => {
            if (worker.exitCode !== null) return done()
            worker.once('close', () => done())
            worker.kill()
          })
      )
    )
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-admission-race-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
test('secondary launches still open another hidden reader window and cannot release the live process admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-admission-windows-')),
    profile = join(root, 'profile'),
    coord = join(root, 'coord'),
    file = join(root, '第二本文稿.md')
  const exe = process.env.ZHUMO_E2E_EXE || resolve('node_modules/electron/dist/electron.exe'),
    args = process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')]
  const env = {
    ...process.env,
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: coord,
    ZHUMO_TEST_BACKGROUND: '1'
  }
  let app: ElectronApplication | undefined
  try {
    await writeFile(file, '# 第二本文稿\n\n保留原来的阅读窗口。\n')
    app = await electron.launch({ executablePath: exe, args, env })
    await expect((await app.firstWindow()).getByText('另有天地。')).toBeVisible()
    const created = app.waitForEvent('window')
    const child = spawn(exe, [...args, file], { env, windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((done, reject) => {
      child.once('error', reject)
      child.once('close', () => done())
    })
    const page = await created
    await expect(page.locator('.reader-scroll')).toContainText('保留原来的阅读窗口')
    await assertBackgroundWindow(app)
    expect(() => admitUpdate([profile], coord)).toThrow('正常保存并退出')
    const gone = page.waitForEvent('close')
    await (await app.browserWindow(page)).evaluate((window) => window.close())
    await gone
    expect(() => admitUpdate([profile], coord)).toThrow('正常保存并退出')
    const closed = app.waitForEvent('close')
    await app.evaluate(({ app }) => app.quit())
    await closed
    app = undefined
    const gate = admitUpdate([profile], coord)
    gate.cancel()
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-admission-windows-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
