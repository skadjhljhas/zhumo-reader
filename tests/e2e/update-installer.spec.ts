import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
  rm,
  stat,
  realpath
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import {
  restorePreservationSnapshot,
  verifyPreservationSnapshot
} from '../../src/main/update-preservation'

const runtime =
  process.env.ZHUMO_UPDATE_TEST_EXE || resolve('node_modules/electron/dist/electron.exe')
const helper = process.env.ZHUMO_UPDATE_TEST_EXE
  ? join(resolve(runtime, '..'), 'resources/app.asar/out/main/update-helper.js')
  : resolve('out/main/update-helper.js')
const escape = (s: string): string => s.replaceAll('$', '$$').replaceAll('"', '$\\"')
async function run(
  file: string,
  args: string[],
  env = process.env
): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (p) => chunks.push(p))
    child.stderr.on('data', (p) => chunks.push(p))
    const timeout = setTimeout(() => child.kill(), 90000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timeout)
      done({ code, output: Buffer.concat(chunks).toString() })
    })
  })
}
async function compiler(): Promise<string> {
  if (process.env.ZHUMO_MAKENSIS) return process.env.ZHUMO_MAKENSIS
  const cache = join(process.env.LOCALAPPDATA!, 'electron-builder/Cache/nsis-3.0.4.1')
  for (const dir of await readdir(cache))
    if (dir.startsWith('nsis-3.0.4.1-')) {
      const path = join(cache, dir, 'Bin/makensis.exe')
      if ((await stat(path).catch(() => undefined))?.isFile()) return path
    }
  throw Error('Set ZHUMO_MAKENSIS to the installed NSIS compiler')
}
test('the compiled NSIS hook captures all data before a real NSIS uninstaller runs, and aborts before deletion for invalid sources or a live writer', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-nsis-guard-')),
    makensis = await compiler()
  let writer: ChildProcess | undefined
  const evidence: Record<string, unknown>[] = []
  try {
    for (const scenario of [
      'success',
      'missing-source',
      'live-writer',
      'changed-during-copy',
      'wrong-installation-root'
    ]) {
      const work = join(root, scenario),
        old = join(work, '朱墨旧版本'),
        profile = join(work, '旧配置')
      await mkdir(join(old, '文稿'), { recursive: true })
      await mkdir(join(old, 'resources'))
      await mkdir(profile)
      const bytes = Buffer.from('\uFEFF# 升级中的原稿\r\n\r\n内容[^一]\r\n\r\n[^一]: 注释\r\n')
      await writeFile(join(old, '文稿/原稿.md'), bytes)
      await writeFile(join(profile, 'settings.json'), '{"fontSize":23}')
      await writeFile(join(profile, 'Local State'), '{"os_crypt":{"encrypted_key":"fixture"}}')
      await writeFile(join(old, '未知资源.bin'), Buffer.from([255, 0, 17]))
      // Even a damaged ASAR must be captured as its physical bytes, not interpreted as a
      // virtual directory by Electron's fs shim. A valid real package is checked separately.
      const archiveBytes = Buffer.from([0, 8, 255, 16, 0, 7])
      await writeFile(join(old, 'resources/app.asar'), archiveBytes)
      // The destructive NSIS target is a directly created child of this test's workspace.
      const rel = relative(await realpath(root), await realpath(old))
      expect(rel.startsWith(scenario + sep) && !rel.includes('..')).toBe(true)
      const generator = join(work, 'old-generator.exe'),
        uninstaller = join(work, 'old-uninstaller.exe'),
        marker = join(work, 'uninstall-started.txt')
      const oldScript = join(work, 'old.nsi')
      await writeFile(
        oldScript,
        `\uFEFFUnicode true
Name "ZhuMo isolated legacy uninstaller fixture"
OutFile "${escape(generator)}"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Section
WriteUninstaller "${escape(uninstaller)}"
SectionEnd
Section "Uninstall"
FileOpen $0 "${escape(marker)}" w
FileWrite $0 "started"
FileClose $0
RMDir /r "$INSTDIR"
SectionEnd
`
      )
      let result = await run(makensis, ['/V2', oldScript])
      expect(result.output).not.toContain('Error:')
      expect(result.code).toBe(0)
      expect((await run(generator, ['/S'])).code).toBe(0)
      if (scenario === 'live-writer') {
        const exe = join(old, 'Writer.exe')
        await copyFile(process.execPath, exe)
        writer = spawn(exe, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        await new Promise<void>((done, reject) => {
          writer!.stdout!.once('data', () => done())
          writer!.once('error', reject)
        })
      }
      const plan = join(work, 'plan.json'),
        snapshot = join(work, '保存点')
      const plannedRoot = scenario === 'wrong-installation-root' ? join(work, '误选的旧程序') : old
      if (plannedRoot !== old) await mkdir(plannedRoot)
      await writeFile(
        plan,
        JSON.stringify({
          version: 1,
          action: 'capture',
          sources: [plannedRoot, scenario === 'missing-source' ? join(work, '失联配置') : profile],
          programRoots: [plannedRoot],
          destination: snapshot
        })
      )
      const installer = join(work, 'guarded-installer.exe'),
        script = join(work, 'new.nsi')
      await writeFile(
        script,
        `\uFEFFUnicode true
Name "ZhuMo isolated upgrade ordering fixture"
OutFile "${escape(installer)}"
RequestExecutionLevel user
SilentInstall silent
!include "${escape(resolve('build/update-preservation.nsh'))}"
Section
!insertmacro ZhuMoCaptureBeforeUninstall "${escape(runtime)}" "${escape(helper)}" "${escape(plan)}" "${escape(old)}"
ExecWait '"${escape(uninstaller)}" /S _?=${escape(old)}' $0
SetErrorLevel $0
SectionEnd
`
      )
      result = await run(makensis, ['/V2', script])
      expect(result.output).not.toContain('Error:')
      expect(result.code).toBe(0)
      let mutation: Promise<boolean> | undefined
      if (scenario === 'changed-during-copy')
        mutation = (async () => {
          for (let i = 0; i < 500; i++) {
            if (await stat(join(snapshot, 'payload/0/文稿/原稿.md')).catch(() => undefined)) {
              await writeFile(
                join(old, '文稿/原稿.md'),
                'Changed by a concurrent writer outside the old program directory'
              )
              return true
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          return false
        })()
      result = await run(installer, ['/S'])
      if (mutation) expect(await mutation).toBe(true)
      if (scenario === 'success') {
        expect(result.code).toBe(0)
        expect(await readFile(marker, 'utf8')).toBe('started')
        await expect(stat(old)).rejects.toMatchObject({ code: 'ENOENT' })
        const report = JSON.parse(await readFile(plan + '.result.json', 'utf8'))
        expect(report).toMatchObject({ ok: true, stage: 'captured', roots: 2 })
        const manifest = await verifyPreservationSnapshot(snapshot)
        expect(manifest.id).toBe(report.snapshotId)
        const [recovered] = await restorePreservationSnapshot(snapshot, join(work, '恢复'))
        expect(await readFile(join(recovered, '文稿/原稿.md'))).toEqual(bytes)
        expect(await readFile(join(recovered, '未知资源.bin'))).toEqual(Buffer.from([255, 0, 17]))
        expect(await readFile(join(recovered, 'resources/app.asar'))).toEqual(archiveBytes)
      } else {
        expect(result.code).not.toBe(0)
        await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        if (scenario === 'changed-during-copy')
          expect(await readFile(join(old, '文稿/原稿.md'), 'utf8')).toContain(
            'Changed by a concurrent writer'
          )
        else expect(await readFile(join(old, '文稿/原稿.md'))).toEqual(bytes)
        await expect(stat(join(snapshot, 'manifest.json'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
        if (writer) {
          expect(writer.exitCode).toBeNull()
          const closed = new Promise<void>((done) => writer!.once('close', () => done()))
          writer.kill()
          await closed
          writer = undefined
        }
      }
      expect(await readFile(join(profile, 'settings.json'), 'utf8')).toContain('23')
      evidence.push({ scenario, exitCode: result.code, passed: true })
    }
    await mkdir('work/update-installer', { recursive: true })
    await writeFile(
      'work/update-installer/nsis-ordering.json',
      JSON.stringify(
        {
          helper: 'Electron Node mode',
          windowsVisible: false,
          actualProductionInstaller: false,
          scope:
            'compiled hook + isolated real NSIS uninstaller; no registry/shortcut/file associations',
          scenarios: evidence
        },
        null,
        2
      )
    )
  } finally {
    if (writer) {
      const closed = new Promise<void>((done) => writer!.once('close', () => done()))
      writer.kill()
      await closed
    }
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-nsis-guard-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
