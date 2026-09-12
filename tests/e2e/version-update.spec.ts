import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, backgroundTests } from './runtime'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { defaultAiProfile } from '../../src/shared/ai-types'
import { readCurrentVersion } from '../../src/main/current-version'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
const source = resolve('../朱墨-AI细读/桌面候选28/win-unpacked')
const running = new Set<ChildProcess>()
async function hashes(root: string, prefix = ''): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) for (const [path, hash] of await hashes(root, name)) result.set(path, hash)
    else if (e.isFile())
      result.set(
        name,
        createHash('sha256')
          .update(await readFile(join(root, name)))
          .digest('hex')
      )
    else throw Error('Unexpected link in isolated fixture')
  }
  return result
}
async function unchanged(root: string, before: Map<string, string>): Promise<void> {
  for (const [path, hash] of before)
    expect(
      createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex'),
      path
    ).toBe(hash)
}
async function command(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string; errors: string }> {
  return new Promise((done, reject) => {
    const p = spawn(exe, args, {
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    running.add(p)
    let output = '',
      errors = ''
    p.stdout.on('data', (data) => {
      output += String(data)
    })
    p.stderr.on('data', (data) => {
      errors += String(data)
    })
    p.once('error', reject)
    p.once('close', (code) => {
      running.delete(p)
      done({ code, output, errors })
    })
  })
}
async function close(reader: ElectronApplication): Promise<void> {
  const closed = reader.waitForEvent('close')
  await reader.evaluate(({ app }) => app.quit())
  await closed
}
test('real side-by-side updater and current launcher preserve settings, manuscripts and the old program', async () => {
  test.skip(!backgroundTests, 'This migration uses only hidden, isolated readers')
  test.setTimeout(180000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-version-native-')),
    installRoot = join(root, '朱墨'),
    profile = join(root, 'profile'),
    library = join(installRoot, '文稿'),
    workRoot = join(root, 'recovery'),
    coordinator = join(root, 'coord')
  let reader: ElectronApplication | undefined,
    appName = ''
  const env = {
    ...process.env,
    ZHUMO_TEST_BACKGROUND: '1',
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: coordinator
  }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  try {
    await cp(resolve('../朱墨-AI细读/桌面候选27/win-unpacked'), installRoot, { recursive: true })
    for (const path of [profile, library, workRoot, coordinator]) await mkdir(path)
    const book = join(library, '书页 & 光.md'),
      bytes = Buffer.from(
        '\ufeff# 更新后的原稿\r\n\r\n保留 **格式**[^a]。\r\n\r\n[^a]: 我写的注释。\r\n'
      )
    await writeFile(book, bytes)
    await writeFile(join(library, '图片.bin'), Buffer.from([0, 1, 2, 255]))
    await writeFile(
      join(profile, 'manuscript-library.v1.json'),
      JSON.stringify({ version: 1, path: library })
    )
    reader = await electron.launch({
      executablePath: join(installRoot, 'ZhuMo-AI.exe'),
      args: [],
      env
    })
    const page = await reader.firstWindow()
    appName = await reader.evaluate(({ app }) => app.getName())
    await page.evaluate(async (defaults) => {
      await window.api.saveSettings({
        ...(await window.api.getSettings()),
        fontSize: 23,
        automaticSyntax: false
      })
      localStorage.setItem('zhumo.studio.theme', 'lucent')
      await window.ai!.saveProfile('reading', {
        ...defaults,
        model: 'fixture-no-api',
        endpoint: 'http://127.0.0.1:9/v1',
        apiKey: 'isolated-encrypted-fixture'
      })
    }, defaultAiProfile('reading'))
    await close(reader)
    reader = undefined
    const originals = await hashes(installRoot),
      profileBytes = await hashes(profile)
    const receipt = JSON.parse(
      await readFile(resolve('../朱墨-AI细读/桌面候选28/program-files-build-receipt.json'), 'utf8')
    )
    const planFile = join(root, 'update-plan.json')
    await writeFile(
      planFile,
      JSON.stringify({
        version: 1,
        operation: 'install',
        manifestFile: join(source, 'program-files.v1.json'),
        plan: {
          installRoot,
          profile,
          source,
          workRoot,
          coordinator,
          libraryRoots: [],
          expectedAppId: receipt.appId,
          expectedCurrentBytes: null,
          manifestSha256: receipt.manifestHash,
          appName
        }
      })
    )
    const update = await command(
      join(source, 'ZhuMo-AI.exe'),
      [join(source, 'resources/app.asar/out/main/version-update-runner.js'), planFile],
      { ...env, ELECTRON_RUN_AS_NODE: '1' }
    )
    expect(update.errors).not.toContain('isolated-encrypted-fixture')
    expect(update.code, update.errors).toBe(0)
    const result = JSON.parse(update.output.trim().split('\n').at(-1)!).result
    expect(result.phase).toBe('committed')
    await unchanged(installRoot, originals)
    await unchanged(profile, profileBytes)
    const current = (await readCurrentVersion(installRoot))!
    expect(current.pointer.profile).toBe(profile)
    expect(current.pointer.appVersion).toBe('2.0.0-preview.ai.28')
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toHaveLength(0)
    const executable = join(result.directory, current.pointer.executable)
    await writeFile(join(result.directory, '随手存的文稿.md'), '额外文稿也不妨碍启动')
    reader = await electron.launch({
      executablePath: executable,
      args: [],
      env: { ...env, ZHUMO_INSTALL_ROOT: installRoot }
    })
    const active = await reader.firstWindow()
    expect(await reader.evaluate(({ app }) => app.getVersion())).toBe('2.0.0-preview.ai.28')
    expect((await active.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect(await active.evaluate(() => localStorage.getItem('zhumo.studio.theme'))).toBe('lucent')
    expect(await active.evaluate(() => window.api.manuscriptLocation())).toMatchObject({
      path: library,
      available: true
    })
    expect((await active.evaluate(() => window.ai!.getProfiles())).reading.keyStorage).toBe(
      'encrypted'
    )
    // Exercise the actual GUI launcher role. It inherits profile from current.json and
    // forwards the book into the already inspected reader's second native window.
    const launcherEnv: NodeJS.ProcessEnv = { ...env }
    delete launcherEnv.ZHUMO_USER_DATA
    const newWindow = reader.waitForEvent('window')
    const launched = await command(
      join(source, 'ZhuMo-AI.exe'),
      ['--zhumo-launch-current', installRoot, '--', book],
      launcherEnv
    )
    expect(launched.code, launched.errors).toBe(0)
    const bookPage = await newWindow
    await expect(bookPage.locator('.section-body')).toContainText('保留')
    await expect(bookPage.locator('.section-body h1[data-heading-hash]')).toContainText(
      '更新后的原稿'
    )
    expect(await readFile(book)).toEqual(bytes)
    await mkdir('work/update28', { recursive: true })
    await bookPage.screenshot({ path: 'work/update28/managed-reader.png' })
    await writeFile(
      'work/update28/native-update.json',
      JSON.stringify(
        {
          version: current.pointer.appVersion,
          programFilesUnchanged: originals.size,
          profileFilesUnchanged: profileBytes.size,
          launcherForwardedBook: true,
          encryptedConfigurationReadable: true,
          libraryUnchanged: true,
          extraManuscriptAccepted: true
        },
        null,
        2
      )
    )
    await close(reader)
    reader = undefined
  } finally {
    await reader?.evaluate(({ app }) => app.exit(1)).catch(() => {})
    const writers = inspectUpdateAdmission([installRoot, profile], coordinator).writers
    if (!running.size && !writers.some((w) => w.phase === 'mutating' || w.ownerAlive)) {
      const part = relative(await realpath(tmpdir()), await realpath(root))
      expect(part.startsWith('zhumo-version-native-') && !part.includes('..')).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})

for (const action of ['commit', 'rollback'] as const)
  test(`a real updater exit after publication can ${action} through the retained native guard`, async () => {
    test.skip(!backgroundTests, 'Hidden isolated update recovery only')
    test.setTimeout(180000)
    const root = await mkdtemp(join(tmpdir(), 'zhumo-version-crash-')),
      installRoot = join(root, '朱墨'),
      profile = join(root, 'profile'),
      workRoot = join(root, 'recovery'),
      coordinator = join(root, 'coord')
    const env: Record<string, string> = Object.fromEntries(
      Object.entries({
        ...process.env,
        ZHUMO_TEST_BACKGROUND: '1',
        ZHUMO_USER_DATA: profile,
        ZHUMO_UPDATE_COORDINATION: coordinator
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
    for (const key of Object.keys(env))
      if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
    let reader: ElectronApplication | undefined
    try {
      await cp(resolve('../朱墨-AI细读/桌面候选27/win-unpacked'), installRoot, { recursive: true })
      for (const path of [profile, workRoot, coordinator]) await mkdir(path)
      const book = join(installRoot, '原文.md'),
        bytes = Buffer.from(
          '\ufeff# 中断后仍在\r\n\r\n保留正文与注释[^a]。\r\n\r\n[^a]: 原注释。\r\n'
        )
      await writeFile(book, bytes)
      reader = await electron.launch({
        executablePath: join(installRoot, 'ZhuMo-AI.exe'),
        args: [],
        env
      })
      const appName = await reader.evaluate(({ app }) => app.getName())
      await (
        await reader.firstWindow()
      ).evaluate(async () =>
        window.api.saveSettings({
          ...(await window.api.getSettings()),
          fontSize: 22,
          automaticSyntax: false
        })
      )
      await close(reader)
      reader = undefined
      const oldFiles = await hashes(installRoot),
        oldProfile = await hashes(profile)
      const receipt = JSON.parse(
        await readFile(
          resolve('../朱墨-AI细读/桌面候选28/program-files-build-receipt.json'),
          'utf8'
        )
      )
      const plan = {
        installRoot,
        profile,
        source,
        workRoot,
        coordinator,
        libraryRoots: [],
        expectedAppId: receipt.appId,
        expectedCurrentBytes: null,
        manifestSha256: receipt.manifestHash,
        manifestBytes: await readFile(join(source, 'program-files.v1.json'), 'utf8'),
        appName
      }
      const planPath = join(root, 'crash-plan.json'),
        driver = join(root, 'crash-driver.cjs')
      await writeFile(planPath, JSON.stringify(plan))
      await writeFile(
        driver,
        `const fs=require('node:fs');
const {installVersion}=require(${JSON.stringify(join(source, 'resources/app.asar/out/main/version-update.js'))});
const plan=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));
installVersion(plan,{progress(phase){if(phase==='published')process.exit(91)}}).catch(e=>{console.error(e.message);process.exitCode=1});`
      )
      const crashed = await command(join(source, 'ZhuMo-AI.exe'), [driver], {
        ...env,
        ELECTRON_RUN_AS_NODE: '1'
      })
      expect(crashed.code, crashed.errors).toBe(91)
      const transaction = join(
        workRoot,
        (await readdir(workRoot)).find((name) => name.startsWith('update-'))!
      )
      const journal = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8'))
      expect(journal.phase).toBe('published')
      const writers = inspectUpdateAdmission([installRoot, profile], coordinator).writers
      expect(writers).toHaveLength(1)
      expect(writers[0]).toMatchObject({ phase: 'mutating', ownerAlive: false })
      const current = (await readCurrentVersion(installRoot))!
      const installed = join(
        installRoot,
        '.zhumo',
        'versions',
        current.pointer.releaseId,
        current.pointer.executable
      )
      const blocked = await command(installed, [], { ...env, ZHUMO_INSTALL_ROOT: installRoot })
      expect(blocked.code).toBe(73)
      await unchanged(profile, oldProfile)
      const recoveryPlan = join(root, 'recover.json')
      await writeFile(
        recoveryPlan,
        JSON.stringify({
          version: 1,
          operation: 'recover',
          transaction,
          action,
          expected: { installRoot, profile, coordinator, appId: receipt.appId }
        })
      )
      const recovered = await command(
        join(source, 'ZhuMo-AI.exe'),
        [join(source, 'resources/app.asar/out/main/version-update-runner.js'), recoveryPlan],
        { ...env, ELECTRON_RUN_AS_NODE: '1' }
      )
      expect(recovered.code, recovered.errors).toBe(0)
      expect(JSON.parse(recovered.output.trim().split('\n').at(-1)!).result.phase).toBe(
        action === 'commit' ? 'committed' : 'rolled-back'
      )
      expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toHaveLength(0)
      await unchanged(installRoot, oldFiles)
      await unchanged(profile, oldProfile)
      expect(Boolean(await readCurrentVersion(installRoot))).toBe(action === 'commit')
      reader = await electron.launch({
        executablePath: action === 'commit' ? installed : join(installRoot, 'ZhuMo-AI.exe'),
        args: [book],
        env: action === 'commit' ? { ...env, ZHUMO_INSTALL_ROOT: installRoot } : env
      })
      const page = await reader.firstWindow()
      await expect(page.locator('.section-body')).toContainText('保留正文与注释')
      expect((await page.evaluate(() => window.api.getSettings())).fontSize).toBe(22)
      expect(await readFile(book)).toEqual(bytes)
      await close(reader)
      reader = undefined
      await mkdir('work/update28', { recursive: true })
      await writeFile(
        `work/update28/crash-${action}.json`,
        JSON.stringify(
          {
            processExited: 91,
            blockedReaderExit: 73,
            recovery: action,
            originalFilesUnchanged: oldFiles.size,
            profileFilesUnchanged: oldProfile.size,
            reopened: true
          },
          null,
          2
        )
      )
    } finally {
      await reader?.evaluate(({ app }) => app.exit(1)).catch(() => {})
      const writers = inspectUpdateAdmission([installRoot, profile], coordinator).writers
      if (!running.size && !writers.some((w) => w.phase === 'mutating' || w.ownerAlive)) {
        const part = relative(await realpath(tmpdir()), await realpath(root))
        expect(part.startsWith('zhumo-version-crash-') && !part.includes('..')).toBe(true)
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  })
