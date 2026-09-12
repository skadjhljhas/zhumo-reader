import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  realpath,
  rm
} from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { extractFile } from '@electron/asar'
import { readCurrentVersion } from '../../src/main/current-version'
import { readProgramManifest } from '../../src/main/program-files'
import {
  readRegistration,
  changeRegistration,
  registrationValue
} from '../../src/main/setup-registry'
import { inspectUpdateAdmission } from '../../src/main/update-admission'
import type { SetupRequest } from '../../src/main/setup-action'

const payload = resolve(
  process.env.ZHUMO_MANAGED_PAYLOAD ?? '../朱墨-AI细读/安装验证39/win-unpacked'
)
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function command(
  exe: string,
  args: string[],
  env = process.env
): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(exe, args, {
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (part) => {
      output += String(part)
    })
    child.stderr.on('data', (part) => {
      output += String(part)
    })
    child.once('error', reject)
    child.once('close', (code) => done({ code, output }))
  })
}
test('actual installer recovers interrupted Windows integration and the original command finishes a sealed commit', async () => {
  test.setTimeout(900000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-setup-integration-')),
    installRoot = join(root, '朱墨 & 文稿'),
    profile = join(root, 'profile'),
    work = join(root, 'work'),
    coordinator = join(root, 'coord'),
    desktop = join(root, 'desktop'),
    menu = join(root, 'menu'),
    runtimes = join(root, 'runtimes'),
    registryKey = 'Software\\ZhuMoInstallerTests\\' + randomUUID()
  for (const dir of [installRoot, profile, work, coordinator, runtimes]) await mkdir(dir)
  await mkdir('work/setup38', { recursive: true })
  const book = join(installRoot, '原稿.md'),
    settings = join(profile, 'settings.json')
  let currentBook = Buffer.from('\ufeff# 读者的文字\r\n原稿与注释不能因安装丢失。\r\n')
  await writeFile(book, currentBook)
  await writeFile(settings, '{"fontSize":23,"lightRange":"hdr"}')
  await writeFile(
    join(profile, 'manuscript-library.v1.json'),
    JSON.stringify({ version: 1, path: installRoot })
  )
  const manifestBytes = await readFile(join(payload, 'program-files.v1.json'))
  const manifestHash = JSON.parse(
    await readFile(join(dirname(payload), 'program-files-build-receipt.json'), 'utf8')
  ).manifestHash
  const manifest = readProgramManifest(manifestBytes, manifestHash)
  const pkg = JSON.parse(
    extractFile(join(payload, 'resources/app.asar'), 'package.json').toString()
  )
  const env = {
    ...process.env,
    ZHUMO_TEST_BACKGROUND: '1',
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: coordinator
  }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  const evidence: Record<string, unknown> = {
    version: manifest.appVersion,
    manifestHash,
    executionMode: 'hidden, isolated'
  }
  const assertData = async (): Promise<void> => {
    expect(await readFile(book)).toEqual(currentBook)
    expect(await readFile(settings, 'utf8')).toBe('{"fontSize":23,"lightRange":"hdr"}')
  }
  const prepareAttempt = async (
    stage: string
  ): Promise<{ request: SetupRequest; ini: string; transaction: string }> => {
    const runtime = join(runtimes, randomUUID()),
      source = join(runtime, 'payload')
    await mkdir(source, { recursive: true })
    for (const file of manifest.files) {
      const target = join(source, file.path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(payload, file.path), target)
      expect(hash(await readFile(target))).toBe(file.sha256)
    }
    await writeFile(join(source, 'program-files.v1.json'), manifestBytes)
    const uninstaller = join(runtime, 'remove.exe')
    await writeFile(uninstaller, 'unused uninstaller placeholder for interrupted helper fixture')
    const request: SetupRequest = {
      source,
      installRoot,
      defaultProfile: profile,
      workRoot: work,
      coordinator,
      manifestHash,
      appId: manifest.appId,
      appName: pkg.productName || pkg.name,
      resultFile: join(runtime, 'installed.ini'),
      desktopDirectory: desktop,
      menuDirectory: menu,
      displayName: '朱墨安装恢复验证',
      registryKey,
      uninstaller
    }
    const ini = join(runtime, 'setup.ini')
    await writeFile(
      ini,
      Buffer.from(
        '\ufeff[Setup]\r\n' +
          Object.entries(request)
            .map(([key, value]) => key + '=' + value)
            .join('\r\n') +
          '\r\n',
        'utf16le'
      )
    )
    const marker = join(runtime, 'transaction.txt'),
      wrapper = join(runtime, 'interrupt.cjs')
    await writeFile(
      wrapper,
      `const fs=require('node:fs');const {installFromSetup,parseSetupIni}=require(${JSON.stringify(join(source, 'resources/app.asar/out/main/setup-action.js'))});
installFromSetup(parseSetupIni(fs.readFileSync(process.argv[2])),undefined,undefined,{progress:async(stage,transaction)=>{if(stage===process.argv[3]){fs.writeFileSync(process.argv[4],transaction);process.exit(69)}}}).catch(error=>{process.stderr.write(error.message);process.exitCode=1});`
    )
    const interrupted = await command(
      join(source, manifest.executable),
      [wrapper, ini, stage, marker],
      nodeEnv
    )
    expect(interrupted.code, interrupted.output).toBe(69)
    const transaction = await readFile(marker, 'utf8')
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers[0]).toMatchObject({
      phase: 'mutating',
      ownerAlive: false
    })
    await assertData()
    return { request, ini, transaction }
  }
  try {
    const installer = join(root, 'install.exe'),
      plan = join(root, 'build.json')
    await writeFile(
      plan,
      JSON.stringify({
        payload,
        output: installer,
        defines: {
          DISPLAY_NAME: '朱墨安装恢复验证',
          DEFAULT_INSTALL: installRoot,
          PROFILE_DIR: profile,
          WORK_DIR: work,
          COORDINATOR_DIR: coordinator,
          RUNTIME_BASE: runtimes,
          DESKTOP_DIR: desktop,
          MENU_DIR: menu,
          REGISTRY_KEY: registryKey
        }
      })
    )
    const built = await command(process.execPath, [
      resolve('scripts/build-managed-installer.mjs'),
      '--plan',
      plan
    ])
    expect(built.code, built.output).toBe(0)
    const orphan = await prepareAttempt('desktop-linked')
    expect((await readdir(desktop)).filter((name) => name.endsWith('.lnk'))).toHaveLength(1)
    expect((await readRegistration(registryKey)).exists).toBe(false)
    // A v1 recovery helper must refuse v2 rather than release the gate after changing only current.json.
    const old = resolve('../朱墨-AI细读/安装验证37/win-unpacked')
    const legacyPlan = join(root, 'legacy-recovery.json')
    await writeFile(
      legacyPlan,
      JSON.stringify({
        version: 1,
        operation: 'recover',
        action: 'rollback',
        transaction: orphan.transaction,
        expected: { installRoot, profile, coordinator, appId: manifest.appId }
      })
    )
    const beforeLegacy = (await readCurrentVersion(installRoot))!.bytes
    const legacy = await command(
      join(old, 'ZhuMo-AI.exe'),
      [join(old, 'resources/app.asar/out/main/version-update-runner.js'), legacyPlan],
      nodeEnv
    )
    expect(legacy.code).not.toBe(0)
    expect((await readCurrentVersion(installRoot))!.bytes).toBe(beforeLegacy)
    currentBook = Buffer.concat([currentBook, Buffer.from('\r\n首次安装中断后继续写。\r\n')])
    await writeFile(book, currentBook)
    const firstRetry = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(firstRetry.code, firstRetry.output).toBe(0)
    expect(JSON.parse(await readFile(join(orphan.transaction, 'journal.json'), 'utf8')).phase).toBe(
      'rolled-back'
    )
    expect((await readdir(desktop)).filter((name) => name.endsWith('.lnk'))).toHaveLength(1)
    await assertData()
    const partial = await prepareAttempt('registered')
    expect(registrationValue(await readRegistration(registryKey), 'UninstallString')).toBe(
      '"' + partial.request.uninstaller + '"'
    )
    currentBook = Buffer.concat([currentBook, Buffer.from('\r\n覆盖安装中断后继续写。\r\n')])
    await writeFile(book, currentBook)
    const secondRetry = await command(installer, ['/S', '/D=' + installRoot], env)
    expect(secondRetry.code, secondRetry.output).toBe(0)
    expect(
      JSON.parse(await readFile(join(partial.transaction, 'journal.json'), 'utf8')).phase
    ).toBe('rolled-back')
    expect((await readdir(desktop)).filter((name) => name.endsWith('.lnk'))).toHaveLength(1)
    expect((await readdir(menu)).filter((name) => name.endsWith('.lnk'))).toHaveLength(1)
    await assertData()
    const sealed = await prepareAttempt('committed'),
      sealedPointer = (await readCurrentVersion(installRoot))!.bytes
    currentBook = Buffer.concat([currentBook, Buffer.from('\r\n提交完成之后的新文字。\r\n')])
    await writeFile(book, currentBook)
    const bootstrapBook = join(sealed.request.source, '公开启动器旁的新文稿.md')
    await writeFile(bootstrapBook, '# 用户后来放入启动器目录的文字')
    const sealedJournal = JSON.parse(
      await readFile(join(sealed.transaction, 'journal.json'), 'utf8')
    )
    const ready = JSON.parse(
      await readFile(join(sealedJournal.guardDirectory, 'plan.json.ready.json'), 'utf8')
    )
    expect(Number.isSafeInteger(ready.pid) && ready.pid > 0).toBe(true)
    expect(ready.windows).toBe(0)
    const inspectScript =
      '$ProgressPreference="SilentlyContinue"; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $guardItem=Get-CimInstance Win32_Process -Filter "ProcessId=' +
      ready.pid +
      '"; if($null -eq $guardItem){[Console]::Write("null")}else{$guardItem | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress}'
    const processInfo = await command('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(inspectScript, 'utf16le').toString('base64')
    ])
    expect(processInfo.code, processInfo.output).toBe(0)
    const guardProcess = JSON.parse(processInfo.output.replace(/^\ufeff/, ''))
    if (guardProcess) {
      expect(guardProcess.ExecutablePath.toLowerCase()).toBe(
        join(sealed.request.source, manifest.executable).toLowerCase()
      )
      expect(guardProcess.CommandLine).toContain('--zhumo-profile-guard')
      expect(guardProcess.CommandLine).toContain(sealedJournal.guardDirectory)
      // Fault injection targets only the validated zero-window guard owned by this fixture.
      process.kill(ready.pid)
    } else {
      expect(() => process.kill(ready.pid, 0)).toThrow()
    }
    const failedRecovery = join(root, 'recovery-failure.cjs')
    await writeFile(
      failedRecovery,
      `const {recoverVersionUpdate}=require(${JSON.stringify(join(sealed.request.source, 'resources/app.asar/out/main/version-update.js'))});
const runtime={assertClosed:async()=>{},reconnectGuard:async()=>{throw Error('fixture disconnected guard')},startGuard:async()=>{throw Error('fixture transient reacquisition failure')}};
recoverVersionUpdate(process.argv[2],JSON.parse(process.argv[3]),'commit',{},runtime).then(()=>process.exit(0)).catch(()=>process.exit(71));`
    )
    const failedRecoveryResult = await command(
      join(sealed.request.source, manifest.executable),
      [
        failedRecovery,
        sealed.transaction,
        JSON.stringify({ installRoot, profile, coordinator, appId: manifest.appId })
      ],
      nodeEnv
    )
    expect(failedRecoveryResult.code, failedRecoveryResult.output).toBe(71)
    const failureState = JSON.parse(
      await readFile(join(sealed.transaction, 'journal.json'), 'utf8')
    )
    expect(failureState.phase).toBe('recovery-needed')
    expect(failureState.decision).toBe('commit')
    const count = (await readdir(work)).filter((name) => name.startsWith('update-')).length
    const finish = await command(
      join(sealed.request.source, manifest.executable),
      [
        join(sealed.request.source, 'resources/app.asar/out/main/setup-action.js'),
        '--plan',
        sealed.ini
      ],
      nodeEnv
    )
    expect(finish.code, finish.output).toBe(0)
    expect((await readCurrentVersion(installRoot))!.bytes).toBe(sealedPointer)
    expect((await readdir(work)).filter((name) => name.startsWith('update-'))).toHaveLength(count)
    expect(inspectUpdateAdmission([installRoot, profile], coordinator).writers).toEqual([])
    const finishAgain = await command(
      join(sealed.request.source, manifest.executable),
      [
        join(sealed.request.source, 'resources/app.asar/out/main/setup-action.js'),
        '--plan',
        sealed.ini
      ],
      nodeEnv
    )
    expect(finishAgain.code, finishAgain.output).toBe(0)
    expect((await readdir(work)).filter((name) => name.startsWith('update-'))).toHaveLength(count)
    expect(await readFile(bootstrapBook, 'utf8')).toContain('用户后来')
    await assertData()
    evidence.cases = {
      orphanShortcutRecovered: true,
      registryUpdateRecovered: true,
      sealedCommandFinishedOnce: true,
      committedDecisionSurvivedRecoveryFailure: true,
      completedPlanRetriedWithoutWriter: true,
      bootstrapManuscriptPreserved: true,
      legacyHelperRefused: true,
      latestManuscriptPreserved: true,
      settingsPreserved: true,
      duplicateShortcuts: 0
    }
    await writeFile('work/setup38/native-install-recovery.json', JSON.stringify(evidence, null, 2))
  } catch (error) {
    await writeFile(
      'work/setup38/native-install-recovery-failure.json',
      JSON.stringify({ root, registryKey, message: String(error) }, null, 2)
    )
    throw error
  } finally {
    const writers = inspectUpdateAdmission([installRoot, profile], coordinator).writers
    if (!writers.some((writer) => writer.phase === 'mutating')) {
      await changeRegistration(
        {
          key: registryKey,
          before: await readRegistration(registryKey),
          after: { exists: false, values: [], subkeys: [] }
        },
        root
      )
      const part = relative(await realpath(tmpdir()), await realpath(root))
      expect(part.startsWith('zhumo-setup-integration-') && !part.includes('..')).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    } else
      await writeFile(
        'work/setup38/retained-integration-fixture.json',
        JSON.stringify({ root, registryKey })
      )
  }
})
