import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, backgroundTests } from './runtime'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
  appendFile,
  rm,
  realpath
} from 'node:fs/promises'
import { join, resolve, dirname, relative, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { readProgramManifest } from '../../src/main/program-files'
import { readCurrentVersion } from '../../src/main/current-version'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
import { defaultAiProfile } from '../../src/shared/ai-types'
import { boundReaderProfile } from '../../src/main/profile-selection'
import { productIdentity } from '../../src/main/product-identity'
import { extractFile } from '@electron/asar'

const payload = resolve(
  process.env.ZHUMO_MANAGED_PAYLOAD ?? '../朱墨-AI细读/安装验证57/win-unpacked'
)
const oldPayload = resolve(
  process.env.ZHUMO_OLD_PAYLOAD ?? '../朱墨-AI细读/桌面候选35/win-unpacked'
)
const evidenceDirectory = resolve(process.env.ZHUMO_MANAGED_EVIDENCE ?? 'work/managed-setup')
let commandSequence = 0
const commandRunId = randomUUID()
const activeCommands = new Set<number>()
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function command(
  exe: string,
  args: string[],
  env = process.env,
  timeoutMs = 120000
): Promise<{ code: number | null; output: string }> {
  const id = ++commandSequence,
    started = Date.now()
  const record = async (event: object): Promise<void> => {
    await mkdir(evidenceDirectory, { recursive: true })
    await appendFile(
      join(evidenceDirectory, 'command-timing.jsonl'),
      JSON.stringify({
        run: commandRunId,
        id,
        command: basename(exe),
        at: new Date().toISOString(),
        ...event
      }) + '\n'
    )
  }
  return new Promise((done, reject) => {
    const child = spawn(exe, args, {
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (child.pid) activeCommands.add(child.pid)
    // Observe a bounded command without killing a recovery helper mid-transaction.
    // On failure the private fixture is retained while any child is still active.
    const timer = setTimeout(() => {
      void record({
        state: 'observation-timeout',
        pid: child.pid,
        elapsedMs: Date.now() - started
      }).catch(() => undefined)
      reject(
        Error(
          `${basename(exe)} exceeded ${timeoutMs / 1000}s; process ${child.pid} and private recovery data were retained.`
        )
      )
    }, timeoutMs)
    void record({ state: 'started', pid: child.pid }).catch(() => undefined)
    let output = ''
    child.stdout.on('data', (value) => {
      output += String(value)
    })
    child.stderr.on('data', (value) => {
      output += String(value)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      if (child.pid) activeCommands.delete(child.pid)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (child.pid) activeCommands.delete(child.pid)
      void record({ state: 'finished', code, elapsedMs: Date.now() - started })
        .catch(() => undefined)
        .then(() => done({ code, output }))
    })
  })
}
async function powershell(script: string): Promise<string> {
  script = "$ProgressPreference='SilentlyContinue'; " + script + '; exit 0'
  const result = await command('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ])
  expect(result.code, result.output).toBe(0)
  return result.output.replace(/^\ufeff/, '').trim()
}
const literal = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
async function files(root: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) for (const [p, hash] of await files(root, path)) out.set(p, hash)
    else if (e.isFile()) out.set(path, digest(await readFile(join(root, path))))
    else throw Error('Unexpected fixture link')
  }
  return out
}
async function unchanged(root: string, before: Map<string, string>): Promise<void> {
  for (const [path, hash] of before)
    expect(digest(await readFile(join(root, path))), path).toBe(hash)
}
async function programCopy(source: string, destination: string): Promise<void> {
  const receipt = JSON.parse(
    await readFile(join(dirname(source), 'program-files-build-receipt.json'), 'utf8')
  )
  const bytes = await readFile(join(source, 'program-files.v1.json'))
  const manifest = readProgramManifest(bytes, receipt.manifestHash)
  await mkdir(destination)
  // Copy only checked release members; never copy a user's additions to an old candidate.
  for (const file of manifest.files) {
    const target = join(destination, file.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(source, file.path), target)
    expect(digest(await readFile(target))).toBe(file.sha256)
  }
  await writeFile(join(destination, 'program-files.v1.json'), bytes)
}
async function close(reader: ElectronApplication): Promise<void> {
  const closed = reader.waitForEvent('close')
  await reader.evaluate(({ app }) => app.quit())
  await closed
}

test('compiled managed NSIS installs over real old program data, preserves encrypted settings, and its shortcut forwards to the verified current version', async () => {
  test.skip(!backgroundTests, 'Only isolated hidden installation verification')
  // Includes NSIS compilation, three installs and two full cleanup/recovery passes.
  test.setTimeout(2100000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-managed-setup-')),
    installRoot = join(root, '朱墨 & 原资料'),
    profile = join(root, 'appData', 'ZhuMo-AI-preview'),
    workRoot = join(root, 'recovery'),
    coordinator = join(root, 'coord'),
    runtimeBase = join(root, 'runtimes'),
    desktop = join(root, 'desktop'),
    menu = join(root, 'menu')
  const keyId = randomUUID(),
    registry = 'Software\\ZhuMoInstallerTests\\' + keyId
  let reader: ElectronApplication | undefined
  const env = {
    ...process.env,
    ZHUMO_TEST_BACKGROUND: '1',
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: coordinator
  }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  const evidence: Record<string, unknown> = {
    root,
    registry,
    executionMode: 'hidden, isolated',
    complete: false
  }
  async function checkpoint(phase: string): Promise<void> {
    evidence.lastVerifiedPhase = phase
    await writeFile(
      join(evidenceDirectory, 'managed-installer-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
  }
  try {
    await mkdir(evidenceDirectory, { recursive: true })
    await programCopy(oldPayload, installRoot)
    const oldReceipt = JSON.parse(
      await readFile(join(dirname(oldPayload), 'program-files-build-receipt.json'), 'utf8')
    )
    const oldManifest = readProgramManifest(
      await readFile(join(oldPayload, 'program-files.v1.json')),
      oldReceipt.manifestHash
    )
    const targetReceipt = JSON.parse(
      await readFile(join(dirname(payload), 'program-files-build-receipt.json'), 'utf8')
    )
    const targetManifest = readProgramManifest(
      await readFile(join(payload, 'program-files.v1.json')),
      targetReceipt.manifestHash
    )
    const executable = targetManifest.executable
    for (const folder of [profile, coordinator]) await mkdir(folder, { recursive: true })
    const library = join(installRoot, '文稿')
    await mkdir(library)
    const book = join(library, '仍在原处 & 中文.md')
    const source = Buffer.from(
      '\ufeff# 仍在原处\r\n\r\n原文与注释都应保留。[^甲]\r\n\r\n[^甲]: 用户自己的注释。\r\n'
    )
    await writeFile(book, source)
    await writeFile(join(library, '用户图片.bin'), Buffer.from([0, 255, 17, 28]))
    await writeFile(
      join(profile, 'manuscript-library.v1.json'),
      JSON.stringify({ version: 1, path: library })
    )
    reader = await electron.launch({
      executablePath: join(installRoot, oldManifest.executable),
      args: [],
      env
    })
    const oldPage = await reader.firstWindow()
    await reader.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ['C:/Windows/Fonts/arial.ttf']
      })
    })
    const appName = await reader.evaluate(({ app }) => app.getName())
    const pkg = JSON.parse(
      extractFile(join(payload, 'resources/app.asar'), 'package.json').toString('utf8')
    )
    const oldPackage = JSON.parse(
      extractFile(join(installRoot, 'resources/app.asar'), 'package.json').toString('utf8')
    )
    expect(appName).toBe(oldPackage.productName || oldPackage.name)
    evidence.identities = {
      source: oldManifest.appId,
      target: targetManifest.appId,
      sourceName: appName,
      targetName: pkg.productName || pkg.name
    }
    // Let the live renderer finish its own settings writes before seeding external profile values.
    await oldPage.getByRole('button', { name: '新建 Markdown', exact: true }).click()
    const draftEditor = oldPage.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
    await expect(draftEditor).toBeFocused()
    await oldPage.keyboard.insertText('# 安装前的未命名草稿\n\n尚未取名的文字，也属于用户。')
    await expect(draftEditor).toContainText('尚未取名的文字，也属于用户。')
    await expect
      .poll(() =>
        oldPage.evaluate(
          () =>
            new Promise<boolean>((done, reject) => {
              const open = indexedDB.open('zhumo-recovery', 2)
              open.onerror = () => reject(open.error)
              open.onsuccess = () => {
                const db = open.result
                const read = db.transaction('drafts-v2').objectStore('drafts-v2').getAll()
                read.onsuccess = () => {
                  db.close()
                  done(read.result.some((d) => d.source.includes('尚未取名的文字，也属于用户。')))
                }
                read.onerror = () => {
                  db.close()
                  reject(read.error)
                }
              }
            })
        )
      )
      .toBe(true)
    await oldPage.evaluate(
      async (defaults) => {
        const imported = await window.api.importFont()
        if (!imported) throw new Error('Fixture font import failed')
        await window.api.saveSettings({
          ...(await window.api.getSettings()),
          fontSize: 22,
          lightRange: 'hdr',
          uiFont: imported.font.id,
          bodyFont: imported.font.id,
          noteFont: imported.font.id,
          automaticSyntax: false
        })
        localStorage.setItem('zhumo.studio.theme', 'lucent')
        await window.ai!.saveProfile('reading', {
          ...defaults,
          model: 'fixture-retained',
          endpoint: 'http://127.0.0.1:1/v1',
          apiKey: 'fixture-retained-key'
        })
      },
      { ...defaultAiProfile('reading'), maxTokens: 32768, context: 'full' as const }
    )
    expect((await oldPage.evaluate(() => window.api.getSettings())).fontSize).toBe(22)
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}'))
            .fontSize
      )
      .toBe(22)
    const oldClosed = reader.waitForEvent('close')
    await reader.evaluate(({ app }) => app.exit(0))
    await oldClosed
    reader = undefined
    const oldFiles = await files(installRoot),
      oldProfile = await files(profile)
    expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).fontSize).toBe(22)
    const models = JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8'))
    const buildPlan = join(root, 'build.json'),
      installer = join(root, 'install.exe')
    await writeFile(
      buildPlan,
      JSON.stringify({
        payload,
        output: installer,
        defines: {
          DISPLAY_NAME: '朱墨隔离安装验证',
          DEFAULT_INSTALL: installRoot,
          PROFILE_DIR:
            targetManifest.appId === 'com.zhumo.reader.v2'
              ? join(dirname(profile), 'ZhuMo-2.0')
              : profile,
          WORK_DIR: workRoot,
          COORDINATOR_DIR: coordinator,
          RUNTIME_BASE: runtimeBase,
          DESKTOP_DIR: desktop,
          MENU_DIR: menu,
          REGISTRY_KEY: registry
        }
      })
    )
    const built = await command(
      process.execPath,
      [resolve('scripts/build-managed-installer.mjs'), '--plan', buildPlan],
      process.env,
      720000
    )
    expect(built.code, built.output).toBe(0)
    evidence.build = JSON.parse(await readFile(installer + '.receipt.json', 'utf8'))
    await checkpoint('installer-built')
    const installing = command(installer, ['/S', '/D=' + installRoot], env)
    await expect
      .poll(async () => (await readdir(runtimeBase).catch(() => [])).length, { timeout: 30000 })
      .toBeGreaterThan(0)
    const competing = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(competing.code, competing.output).toBe(94)
    const installed = await installing
    expect(installed.code, installed.output).toBe(0)
    const current = await readCurrentVersion(installRoot)
    expect(current?.pointer.appId).toBe(targetManifest.appId)
    expect(current?.pointer.appVersion).toBe(pkg.version)
    expect(current?.pointer.profile).toBe(profile)
    if (targetManifest.appId === 'com.zhumo.reader.v2')
      expect(
        boundReaderProfile(dirname(profile), productIdentity({ zhumoChannel: 'stable' }))
      ).toBe(profile)
    await unchanged(installRoot, oldFiles)
    await unchanged(profile, oldProfile)
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toEqual([])
    const registration = JSON.parse(
      await powershell(
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-ItemProperty -LiteralPath ' +
          literal('HKCU:\\' + registry) +
          ' | Select-Object InstallLocation,DisplayVersion,UninstallString,ManifestHash | ConvertTo-Json -Compress'
      )
    )
    expect(registration.InstallLocation).toBe(installRoot)
    expect(registration.DisplayVersion).toBe(pkg.version)
    const shortcuts = await readdir(desktop)
    expect(shortcuts.filter((file) => file.endsWith('.lnk'))).toHaveLength(1)
    const shortcut = JSON.parse(
      await powershell(
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut(' +
          literal(join(desktop, shortcuts[0])) +
          '); [pscustomobject]@{target=$link.TargetPath;arguments=$link.Arguments} | ConvertTo-Json -Compress'
      )
    )
    expect(shortcut.arguments).toBe('--zhumo-launch-current "' + installRoot + '"')
    const currentExe = join(installRoot, '.zhumo/versions', current!.pointer.releaseId, executable)
    reader = await electron.launch({ executablePath: currentExe, args: [], env })
    const newPage = await reader.firstWindow()
    expect(await reader.evaluate(({ app }) => app.getVersion())).toBe(pkg.version)
    expect(await reader.evaluate(({ app }) => app.getName())).toBe(pkg.productName || pkg.name)
    const restoredSettings = await newPage.evaluate(() => window.api.getSettings())
    expect(restoredSettings.fontSize).toBe(22)
    expect(restoredSettings.lightRange).toBe('hdr')
    expect(restoredSettings.uiFont).toMatch(/^[a-f0-9]{64}$/)
    expect(restoredSettings.bodyFont).toBe(restoredSettings.uiFont)
    expect(restoredSettings.noteFont).toBe(restoredSettings.uiFont)
    await expect
      .poll(() =>
        newPage.evaluate(
          () =>
            [...document.fonts].filter(
              (font) => font.family.startsWith('ZhuMoFont_') && font.status === 'loaded'
            ).length
        )
      )
      .toBe(1)
    expect(await newPage.evaluate(() => localStorage.getItem('zhumo.studio.theme'))).toBe('lucent')
    await expect(newPage.locator('.untitled-drafts .recent-book').first()).toContainText(
      '安装前的未命名草稿'
    )
    const restored = await newPage.evaluate(() => window.ai!.getProfiles())
    expect(restored.reading.hasKey).toBe(true)
    expect(restored.reading.keyStorage).not.toBe('unavailable')
    expect(restored.reading.model).toBe('fixture-retained')
    expect(
      JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8')).reading.cipher
    ).toBe(models.reading.cipher)
    const opened = reader.waitForEvent('window')
    const forwarded = await command(
      shortcut.target,
      ['--zhumo-launch-current', installRoot, '--', book],
      env
    )
    expect(forwarded.code, forwarded.output).toBe(0)
    const bookPage = await opened
    await expect(bookPage.locator('.document-overture h1')).toHaveText('仍在原处')
    expect(await readFile(book)).toEqual(source)
    // The actual installer must refuse an update while the native reader owns this profile.
    const busy = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(busy.code, busy.output).not.toBe(0)
    expect((await readCurrentVersion(installRoot))?.bytes).toBe(current!.bytes)
    expect(await readFile(book)).toEqual(source)
    expect((await newPage.evaluate(() => window.api.getSettings())).uiFont).toBe(
      restoredSettings.uiFont
    )
    const firstUninstaller = registration.UninstallString.slice(1, -1)
    const busyUninstall = await command(
      firstUninstaller,
      ['/S', '_?=' + dirname(firstUninstaller)],
      env
    )
    expect(busyUninstall.code, busyUninstall.output).toBe(95)
    expect((await readCurrentVersion(installRoot))?.bytes).toBe(current!.bytes)
    expect((await readdir(desktop)).filter((file) => file.endsWith('.lnk'))).toEqual(shortcuts)
    evidence.installed = {
      version: current!.pointer.appVersion,
      oldProgramFilesPreserved: oldFiles.size,
      profileFilesPreserved: oldProfile.size,
      shortcut,
      registration,
      keyCipherPreserved: true,
      untitledDraftPreserved: true,
      openedOriginalBook: true
    }
    await close(reader)
    reader = undefined
    // A later edit belongs to the user; a repeat install must never restore an older snapshot over it.
    const laterSource = Buffer.concat([source, Buffer.from('\r\n安装后继续写下的新段落。\r\n')])
    await writeFile(book, laterSource)
    const laterProfile = await files(profile)
    const shortcutBytes = await readFile(join(desktop, shortcuts[0]))
    const repeated = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(repeated.code, repeated.output).toBe(0)
    expect(await readFile(book)).toEqual(laterSource)
    await unchanged(profile, laterProfile)
    expect((await readdir(desktop)).filter((path) => path.endsWith('.lnk'))).toEqual(shortcuts)
    expect(await readFile(join(desktop, shortcuts[0]))).toEqual(shortcutBytes)
    const again = await readCurrentVersion(installRoot)
    expect(again?.pointer.releaseId).not.toBe(current!.pointer.releaseId)
    expect(again?.pointer.profile).toBe(profile)
    evidence.repeat = {
      runningReaderRefused: true,
      laterManuscriptPreserved: true,
      profileFiles: laterProfile.size,
      shortcutBytesUnchanged: true
    }
    const staleUninstall = await command(
      firstUninstaller,
      ['/S', '_?=' + dirname(firstUninstaller)],
      env
    )
    expect(staleUninstall.code, staleUninstall.output).toBe(95)
    const currentRegistration = JSON.parse(
      await powershell(
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-ItemProperty -LiteralPath ' +
          literal('HKCU:\\' + registry) +
          ' | Select-Object UninstallString | ConvertTo-Json -Compress'
      )
    )
    const activeUninstaller = currentRegistration.UninstallString.slice(1, -1)
    expect(activeUninstaller).not.toBe(firstUninstaller)
    const customLink = join(desktop, shortcuts[0])
    await writeFile(customLink, '用户改过的快捷方式，卸载保留')
    // Stop a real Node-mode helper after files, pointer and registry have been withdrawn.
    // Its native profile guard remains in place; the actual NSIS retry must recover it.
    const runtimeDirectory = dirname(activeUninstaller)
    const addedRuntimeBook = join(runtimeDirectory, 'payload/用户留下的.md')
    const addedRuntimeImage = join(runtimeDirectory, 'payload/用户图片.png')
    await writeFile(addedRuntimeBook, '# 启动目录中的个人文稿')
    await writeFile(addedRuntimeImage, Buffer.from([10, 20, 255, 4]))
    const crashWrapper = join(root, 'interrupt-removal.cjs')
    const interruptedTransaction = join(root, 'interrupted-transaction.txt')
    await writeFile(
      crashWrapper,
      `const fs=require('node:fs');
const {parseSetupIni}=require(${JSON.stringify(join(runtimeDirectory, 'payload/resources/app.asar/out/main/setup-action.js'))});
const {withdrawSetup}=require(${JSON.stringify(join(runtimeDirectory, 'payload/resources/app.asar/out/main/setup-withdrawal.js'))});
const request=parseSetupIni(fs.readFileSync(process.argv[2]));
withdrawSetup(request,undefined,undefined,{progress:async(phase,transaction)=>{if(phase==='withdrawn'){fs.writeFileSync(process.argv[3],transaction);process.exit(69)}}}).catch(error=>{process.stderr.write(error.message);process.exitCode=1});`
    )
    const crashed = await command(
      join(runtimeDirectory, 'payload', executable),
      [crashWrapper, join(runtimeDirectory, 'setup.ini'), interruptedTransaction],
      { ...env, ELECTRON_RUN_AS_NODE: '1' }
    )
    expect(crashed.code, crashed.output).toBe(69)
    expect(await readCurrentVersion(installRoot)).toBeNull()
    const pending = inspectUpdateAdmission([installRoot, profile], coordinator).writers
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ phase: 'mutating', ownerAlive: false })
    const crashTransaction = await readFile(interruptedTransaction, 'utf8')
    const afterCrashSource = Buffer.concat([
      laterSource,
      Buffer.from('\r\n卸载中断后，用户又继续写下的文字。\r\n')
    ])
    await writeFile(book, afterCrashSource)
    const uninstallRunner = join(root, 'run-uninstall.exe')
    await copyFile(activeUninstaller, uninstallRunner)
    const uninstall = await command(
      uninstallRunner,
      ['/S', '_?=' + dirname(activeUninstaller)],
      env,
      480000
    )
    expect(uninstall.code, uninstall.output).toBe(0)
    expect(
      await powershell(
        '[Console]::Write([bool](Test-Path -LiteralPath ' + literal('HKCU:\\' + registry) + '))'
      )
    ).toBe('False')
    expect((await readdir(menu)).filter((file) => file.endsWith('.lnk'))).toEqual([])
    expect(await readFile(customLink, 'utf8')).toBe('用户改过的快捷方式，卸载保留')
    expect(await readFile(book)).toEqual(afterCrashSource)
    await unchanged(profile, laterProfile)
    const preservedOriginals = new Map(oldFiles)
    preservedOriginals.set(
      relative(installRoot, book).replaceAll('\\', '/'),
      digest(afterCrashSource)
    )
    await unchanged(installRoot, preservedOriginals)
    expect(await readCurrentVersion(installRoot)).toBeNull()
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toEqual([])
    const recovered = JSON.parse(await readFile(join(crashTransaction, 'withdrawal.json'), 'utf8'))
    expect(recovered.phase).toBe('rolled-back')
    const removalDirectory = (await readdir(workRoot))
      .filter((name) => name.startsWith('withdraw-'))
      .map((name) => join(workRoot, name))
    const removals = await Promise.all(
      removalDirectory.map(async (dir) =>
        JSON.parse(await readFile(join(dir, 'withdrawal.json'), 'utf8'))
      )
    )
    const committedRemoval = removals.find((item) => item.phase === 'committed')
    expect(committedRemoval?.removedFiles).toBeGreaterThan(100)
    for (const program of committedRemoval.programs)
      await expect(readFile(join(program.directory, executable))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    const cleanup = JSON.parse(
      await readFile(
        join(workRoot, 'withdraw-' + committedRemoval.id, 'cleanup-result.json'),
        'utf8'
      )
    )
    expect(cleanup.deleted).toBeGreaterThan(300)
    for (const entry of removals)
      for (const program of entry.programs)
        await expect(readFile(join(program.storage, 'files', executable))).rejects.toMatchObject({
          code: 'ENOENT'
        })
    await expect(readFile(join(runtimeDirectory, 'payload', executable))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(activeUninstaller)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(addedRuntimeBook, 'utf8')).toContain('个人文稿')
    expect(await readFile(addedRuntimeImage)).toEqual(Buffer.from([10, 20, 255, 4]))
    evidence.withdrawal = {
      runningReaderRefused: true,
      staleSameVersionRefused: true,
      customShortcutPreserved: true,
      ownedMenuLinkRemoved: true,
      registrationRemoved: true,
      laterManuscriptPreserved: true,
      profileFiles: laterProfile.size,
      programRetirement: true,
      removedProgramFiles: committedRemoval.removedFiles,
      realHelperCrashRecovered: true,
      editsAfterInterruptionPreserved: true,
      obsoleteProgramCopiesDeleted: cleanup.deleted,
      userRuntimeFilesPreserved: true
    }
    evidence.competingInstallerRefused = true
    await checkpoint('interrupted-removal-recovered')
    const reinstalled = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(reinstalled.code, reinstalled.output).toBe(0)
    expect((await readCurrentVersion(installRoot))?.pointer.profile).toBe(profile)
    expect(await readFile(book)).toEqual(afterCrashSource)
    await unchanged(profile, laterProfile)
    evidence.reinstallAfterRemoval = {
      originalProfilePreserved: true,
      latestManuscriptPreserved: true
    }
    await checkpoint('reinstalled-after-removal')
    // Also stop after the committed checkpoint. Retrying must report completion, not
    // attempt a fresh removal against a current pointer that correctly no longer exists.
    const finalRegistration = JSON.parse(
      await powershell(
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-ItemProperty -LiteralPath ' +
          literal('HKCU:\\' + registry) +
          ' | Select-Object UninstallString | ConvertTo-Json -Compress'
      )
    )
    const finalUninstaller = finalRegistration.UninstallString.slice(1, -1),
      finalRuntime = dirname(finalUninstaller)
    const finalWrapper = join(root, 'interrupt-committed.cjs'),
      finalTransactionFile = join(root, 'committed-transaction.txt')
    await writeFile(
      finalWrapper,
      `const fs=require('node:fs');
const {parseSetupIni}=require(${JSON.stringify(join(finalRuntime, 'payload/resources/app.asar/out/main/setup-action.js'))});
const {withdrawSetup}=require(${JSON.stringify(join(finalRuntime, 'payload/resources/app.asar/out/main/setup-withdrawal.js'))});
withdrawSetup(parseSetupIni(fs.readFileSync(process.argv[2])),undefined,undefined,{progress:async(phase,transaction)=>{if(phase==='committed'){fs.writeFileSync(process.argv[3],transaction);process.exit(69)}}}).catch(error=>{process.stderr.write(error.message);process.exitCode=1});`
    )
    const committedCrash = await command(
      join(finalRuntime, 'payload', executable),
      [finalWrapper, join(finalRuntime, 'setup.ini'), finalTransactionFile],
      { ...env, ELECTRON_RUN_AS_NODE: '1' }
    )
    expect(committedCrash.code, committedCrash.output).toBe(69)
    const finalRunner = join(root, 'run-final-uninstall.exe')
    await copyFile(finalUninstaller, finalRunner)
    const committedRetry = await command(finalRunner, ['/S', '_?=' + finalRuntime], env, 480000)
    expect(committedRetry.code, committedRetry.output).toBe(0)
    expect(await readCurrentVersion(installRoot)).toBeNull()
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toEqual([])
    const committedTransaction = await readFile(finalTransactionFile, 'utf8')
    expect(
      JSON.parse(await readFile(join(committedTransaction, 'withdrawal.json'), 'utf8')).phase
    ).toBe('committed')
    expect(await readFile(book)).toEqual(afterCrashSource)
    await unchanged(profile, laterProfile)
    evidence.committedRemovalRetry = {
      completedWithoutSecondRemoval: true,
      nativeGuardReleased: true,
      latestDataPreserved: true
    }
    evidence.complete = true
    await checkpoint('complete')
  } catch (error) {
    await writeFile(
      join(evidenceDirectory, 'managed-installer-failure.json'),
      JSON.stringify(
        {
          root,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        null,
        2
      )
    )
    throw error
  } finally {
    await reader?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    const state = inspectUpdateAdmission([installRoot, profile], coordinator)
    if (activeCommands.size || state.writers.some((writer) => writer.phase === 'mutating')) {
      await writeFile(
        join(evidenceDirectory, 'retained-fixture.json'),
        JSON.stringify({
          root,
          reason: 'unfinished transaction retained',
          activeCommands: [...activeCommands]
        })
      )
    } else {
      const expected = 'HKEY_CURRENT_USER\\' + registry
      await powershell(
        '$expected=' +
          literal(expected) +
          '; $item=Get-Item -LiteralPath ("Registry::"+$expected) -ErrorAction SilentlyContinue; if($item){if($item.Name -ne $expected){exit 3}; Remove-Item -LiteralPath $item.PSPath -Recurse -Force}'
      )
      const part = relative(await realpath(tmpdir()), await realpath(root))
      expect(part.startsWith('zhumo-managed-setup-') && !part.includes('..')).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
