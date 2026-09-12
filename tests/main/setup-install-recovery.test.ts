import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  rename
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { installFromSetup, runSetupCommand, type SetupRequest } from '../../src/main/setup-action'
import { recoverVersionUpdate, type VersionUpdateRuntime } from '../../src/main/version-update'
import { readCurrentVersion } from '../../src/main/current-version'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import {
  changeRegistration,
  readRegistration,
  sameRegistration,
  registrationValue
} from '../../src/main/setup-registry'
import { inspectUpdateAdmission } from '../../src/main/update-admission'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })
const cases: { root: string; request: SetupRequest }[] = []
const runtime: VersionUpdateRuntime = {
  assertClosed: async () => {},
  reconnectGuard: async () => {
    throw Error('No native guard in this unit fixture')
  },
  startGuard: async (options) => ({
    pid: process.pid,
    directory: options.workParent,
    signal: new AbortController().signal,
    assertHeld: async () => ({
      ok: true,
      held: true,
      windows: 0,
      scratchBound: true,
      blocked: 0,
      parentChannelClosed: false
    }),
    release: async () => {}
  })
}
async function prepareSource(
  root: string,
  name: string
): Promise<{ source: string; hash: string; uninstaller: string }> {
  const source = join(root, name, 'payload')
  await mkdir(join(source, 'resources'), { recursive: true })
  await writeFile(join(source, 'ZhuMo.exe'), 'executable fixture ' + name)
  await writeFile(join(source, 'resources/app.asar'), 'application fixture ' + name)
  const bytes = JSON.stringify(
    await createProgramManifest(
      source,
      { appId: 'fixture.install-recovery', appVersion: '2.0-' + name, executable: 'ZhuMo.exe' },
      ['ZhuMo.exe', 'resources/app.asar']
    )
  )
  await writeFile(join(source, 'program-files.v1.json'), bytes)
  const uninstaller = join(dirname(source), 'remove.exe')
  await writeFile(uninstaller, 'uninstaller fixture')
  return { source, hash: programManifestHash(bytes), uninstaller }
}
async function fixture(
  upgrade: boolean
): Promise<{ root: string; request: SetupRequest; book: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-install-recovery-'))
  const release = await prepareSource(root, 'first')
  const request: SetupRequest = {
    source: release.source,
    uninstaller: release.uninstaller,
    manifestHash: release.hash,
    installRoot: join(root, '朱墨 & 原稿'),
    defaultProfile: join(root, 'profile'),
    workRoot: join(root, 'work'),
    coordinator: join(root, 'coord'),
    appId: 'fixture.install-recovery',
    appName: 'fixture-reader',
    resultFile: join(dirname(release.source), 'installed.ini'),
    desktopDirectory: join(root, 'desktop'),
    menuDirectory: join(root, 'menu'),
    displayName: '朱墨安装恢复',
    registryKey: 'Software\\ZhuMoInstallerTests\\' + randomUUID()
  }
  cases.push({ root, request })
  for (const folder of [
    request.installRoot,
    request.defaultProfile,
    request.workRoot,
    request.coordinator
  ])
    await mkdir(folder)
  const book = join(request.installRoot, '文稿.md')
  await writeFile(book, '\ufeff# 原稿\r\n安装不能改写的文字。\r\n')
  await writeFile(join(request.defaultProfile, 'settings.json'), '{"fontSize":25}')
  if (upgrade) {
    await installFromSetup(request, undefined, runtime)
    const next = await prepareSource(root, 'second')
    request.source = next.source
    request.uninstaller = next.uninstaller
    request.manifestHash = next.hash
    request.resultFile = join(dirname(next.source), 'installed.ini')
  }
  await writeFile(
    join(dirname(request.source), 'setup.ini'),
    Buffer.from(
      '\ufeff[Setup]\r\n' +
        Object.entries(request)
          .map(([key, value]) => key + '=' + value)
          .join('\r\n') +
        '\r\n',
      'utf16le'
    )
  )
  return { root, request, book }
}
afterEach(async () => {
  for (const { root, request } of cases.splice(0)) {
    if (
      inspectUpdateAdmission(
        [request.installRoot, request.defaultProfile],
        request.coordinator
      ).writers.some((w) => w.phase === 'mutating')
    )
      throw Error('Unfinished installation fixture retained: ' + root)
    expect(request.registryKey).toMatch(/^Software\\ZhuMoInstallerTests\\[a-f0-9-]{36}$/)
    await changeRegistration(
      {
        key: request.registryKey!,
        before: await readRegistration(request.registryKey!),
        after: { exists: false, values: [], subkeys: [] }
      },
      root
    )
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-install-recovery-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
async function interrupt(root: string, request: SetupRequest, stage: string): Promise<string> {
  const wrapper = join(root, 'interrupt.cjs'),
    input = join(root, 'request.json'),
    result = join(root, 'transaction.txt')
  await writeFile(input, JSON.stringify(request))
  await writeFile(
    wrapper,
    `const fs=require('node:fs');const {installFromSetup}=require(${JSON.stringify(resolve('out/main/setup-action.js'))});
const runtime={assertClosed:async()=>{},reconnectGuard:async()=>{throw Error('none')},startGuard:async(o)=>({pid:process.pid,directory:o.workParent,signal:new AbortController().signal,assertHeld:async()=>({ok:true,held:true,windows:0,scratchBound:true,blocked:0,parentChannelClosed:false}),release:async()=>{}})};
installFromSetup(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),undefined,runtime,{progress:async(stage,transaction)=>{if(stage===process.argv[3]){fs.writeFileSync(process.argv[4],transaction);process.exit(69)}}}).catch(error=>{process.stderr.write(error.message);process.exitCode=1});`
  )
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [wrapper, input, stage, result], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('close', done)
  })
  expect(code).toBe(69)
  return readFile(result, 'utf8')
}
it.each([
  { upgrade: false, stage: 'desktop-linked', changedLink: false },
  { upgrade: false, stage: 'desktop-linked', changedLink: true },
  { upgrade: false, stage: 'registered', changedLink: false },
  { upgrade: true, stage: 'registered', changedLink: false }
])(
  'restores program and native state after $stage (upgrade=$upgrade, changedLink=$changedLink)',
  async ({ upgrade, stage, changedLink }) => {
    const { root, request, book } = await fixture(upgrade)
    const before = (await readCurrentVersion(request.installRoot))?.bytes ?? null,
      registration = await readRegistration(request.registryKey!)
    const oldDesktop = new Map<string, Buffer>()
    for (const file of await readdir(request.desktopDirectory!).catch(() => []))
      if (file.endsWith('.lnk'))
        oldDesktop.set(file, await readFile(join(request.desktopDirectory!, file)))
    const transaction = await interrupt(root, request, stage)
    const journal = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8'))
    expect(journal.version).toBe(2)
    expect(journal.phase).toBe('published')
    expect(
      inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
        .writers[0]
    ).toMatchObject({ ownerAlive: false, phase: 'mutating' })
    await writeFile(book, '# 用户在中断之后继续改稿\n新的句子必须保留。')
    let modified: string | undefined
    if (changedLink) {
      modified = join(
        request.desktopDirectory!,
        (await readdir(request.desktopDirectory!)).find((name) => name.endsWith('.lnk'))!
      )
      await writeFile(modified, 'user changed this newly created shortcut')
    }
    await recoverVersionUpdate(
      transaction,
      {
        installRoot: request.installRoot,
        profile: request.defaultProfile,
        coordinator: request.coordinator,
        appId: request.appId
      },
      'rollback',
      {},
      runtime
    )
    expect((await readCurrentVersion(request.installRoot))?.bytes ?? null).toBe(before)
    expect(sameRegistration(await readRegistration(request.registryKey!), registration)).toBe(true)
    expect(await readFile(book, 'utf8')).toContain('新的句子')
    if (modified) expect(await readFile(modified, 'utf8')).toContain('user changed')
    else
      expect(
        (await readdir(request.desktopDirectory!).catch(() => []))
          .filter((name) => name.endsWith('.lnk'))
          .sort()
      ).toEqual([...oldDesktop.keys()].sort())
    for (const [file, bytes] of oldDesktop)
      expect(await readFile(join(request.desktopDirectory!, file))).toEqual(bytes)
    expect(
      inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
        .writers
    ).toEqual([])
  }
)
it('finishes a committed installation through its actual command entry without rejecting newer user documents or settings', async () => {
  const { root, request, book } = await fixture(true)
  const transaction = await interrupt(root, request, 'committed')
  const pointer = (await readCurrentVersion(request.installRoot))!.bytes
  await writeFile(book, '# 提交之后又写下的文字')
  await writeFile(join(request.defaultProfile, 'settings.json'), '{"fontSize":29}')
  await writeFile(join(request.source, '提交后保留的文稿.md'), '# 用户放入公开启动器目录的文稿')
  const failureWrapper = join(root, 'recovery-failure.cjs'),
    failurePlan = join(root, 'recovery-failure.json')
  await writeFile(
    failurePlan,
    JSON.stringify({
      transaction,
      expected: {
        installRoot: request.installRoot,
        profile: request.defaultProfile,
        coordinator: request.coordinator,
        appId: request.appId
      }
    })
  )
  await writeFile(
    failureWrapper,
    `const fs=require('node:fs');const {recoverVersionUpdate}=require(${JSON.stringify(resolve('out/main/version-update.js'))});
const plan=JSON.parse(fs.readFileSync(process.argv[2]));
const runtime={assertClosed:async()=>{},reconnectGuard:async()=>{throw Error('fixture reconnect unavailable')},startGuard:async()=>{throw Error('fixture transient guard failure')}};
recoverVersionUpdate(plan.transaction,plan.expected,'commit',{},runtime).then(()=>process.exit(0)).catch(()=>process.exit(71));`
  )
  const failedCode = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [failureWrapper, failurePlan], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('close', done)
  })
  expect(failedCode).toBe(71)
  const failedJournal = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8'))
  expect(failedJournal.phase).toBe('recovery-needed')
  expect(failedJournal.decision).toBe('commit')
  const count = (await readdir(request.workRoot)).filter((name) =>
    name.startsWith('update-')
  ).length
  const result = await runSetupCommand(
    ['--plan', join(dirname(request.source), 'setup.ini')],
    undefined,
    runtime
  )
  expect(result.transaction).toBe(transaction)
  expect((await readCurrentVersion(request.installRoot))?.bytes).toBe(pointer)
  expect(
    (await readdir(request.workRoot)).filter((name) => name.startsWith('update-'))
  ).toHaveLength(count)
  expect(registrationValue(await readRegistration(request.registryKey!), 'UninstallString')).toBe(
    '"' + request.uninstaller + '"'
  )
  expect(await readFile(book, 'utf8')).toContain('提交之后')
  expect(await readFile(join(request.source, '提交后保留的文稿.md'), 'utf8')).toContain(
    '公开启动器'
  )
  expect(await readFile(join(request.defaultProfile, 'settings.json'), 'utf8')).toBe(
    '{"fontSize":29}'
  )
  expect(
    inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
      .writers
  ).toEqual([])
})
it('returns the same fully completed installation after a release failure and refuses a replacement receipt', async () => {
  const { request } = await fixture(false)
  const failRelease: VersionUpdateRuntime = {
    ...runtime,
    startGuard: async (options) => {
      const guard = await runtime.startGuard(options)
      return {
        ...guard,
        release: async () => {
          throw Error('fixture release failed after completion')
        }
      }
    }
  }
  await expect(installFromSetup(request, undefined, failRelease)).rejects.toMatchObject({
    committed: true
  })
  expect(
    inspectUpdateAdmission([request.installRoot, request.defaultProfile], request.coordinator)
      .writers
  ).toEqual([])
  const receipt = await readFile(request.resultFile)
  expect(receipt.toString('utf16le')).toContain('Status=committed')
  const before = (await readCurrentVersion(request.installRoot))!.bytes
  const count = (await readdir(request.workRoot)).filter((name) =>
    name.startsWith('update-')
  ).length
  const args = ['--plan', join(dirname(request.source), 'setup.ini')]
  const result = await runSetupCommand(args, undefined, runtime)
  expect((await readCurrentVersion(request.installRoot))!.bytes).toBe(before)
  expect(
    (await readdir(request.workRoot)).filter((name) => name.startsWith('update-'))
  ).toHaveLength(count)
  expect(result.transaction).toContain('update-')
  await rename(request.resultFile, request.resultFile + '.original')
  await writeFile(request.resultFile, receipt)
  await expect(runSetupCommand(args, undefined, runtime)).rejects.toThrow('回执已被替换')
  expect(await readFile(request.resultFile)).toEqual(receipt)
})
it('can explicitly finish an interrupted first install without duplicating its already published desktop link', async () => {
  const { root, request } = await fixture(false)
  const transaction = await interrupt(root, request, 'desktop-linked')
  const desktop = (await readdir(request.desktopDirectory!)).filter((name) => name.endsWith('.lnk'))
  await recoverVersionUpdate(
    transaction,
    {
      installRoot: request.installRoot,
      profile: request.defaultProfile,
      coordinator: request.coordinator,
      appId: request.appId
    },
    'commit',
    {},
    runtime
  )
  expect(
    (await readdir(request.desktopDirectory!)).filter((name) => name.endsWith('.lnk'))
  ).toEqual(desktop)
  expect(
    (await readdir(request.menuDirectory!)).filter((name) => name.endsWith('.lnk'))
  ).toHaveLength(1)
  expect(registrationValue(await readRegistration(request.registryKey!), 'ZhuMoTransaction')).toBe(
    (await readCurrentVersion(request.installRoot))!.pointer.transactionId
  )
})
