import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readProgramManifest } from '../../src/main/program-files'

test('the packaged ownership API preserves MD and modified resources through retirement and rollback, and the restored reader starts with its settings', async () => {
  test.skip(
    !process.env.ZHUMO_PROGRAM_TEST_DIR,
    'Requires an explicitly selected packaged build and its detached receipt'
  )
  test.setTimeout(120000)
  const artifact = resolve(process.env.ZHUMO_PROGRAM_TEST_DIR!),
    receipt = JSON.parse(
      await readFile(join(artifact, '../program-files-build-receipt.json'), 'utf8')
    )
  const manifestBytes = await readFile(join(artifact, 'program-files.v1.json')),
    manifest = readProgramManifest(manifestBytes, receipt.manifestHash)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-owned-package-')),
    clone = join(root, '安装副本'),
    profile = join(root, '用户配置')
  let app: ElectronApplication | undefined
  try {
    await cp(artifact, clone, { recursive: true })
    const hook = createRequire(process.execPath)(
      resolve('scripts/require-program-manifest-stage.cjs')
    ) as (context: unknown) => Promise<void>
    await writeFile(join(root, 'program-files-build-receipt.json'), JSON.stringify(receipt))
    const buildContext = {
      electronPlatformName: 'win32',
      appOutDir: clone,
      outDir: root,
      packager: { appInfo: { id: manifest.appId }, platformSpecificBuildOptions: {} }
    }
    await hook(buildContext)
    const modified = manifest.files.find((f) => f.path.endsWith('/icon.svg'))!.path
    expect(modified).toBeTruthy()
    const modifiedBytes = Buffer.concat([
      await readFile(join(clone, modified)),
      Buffer.from('\n<!-- user-modified resource -->\n')
    ])
    await writeFile(join(clone, modified), modifiedBytes)
    await mkdir(join(clone, '文稿'))
    const md = Buffer.from('\uFEFF# 所有权之外的原稿\r\n\r\n文字[^一]\r\n\r\n[^一]: 保留注释\r\n')
    await writeFile(join(clone, '文稿/原稿.md'), md)
    await writeFile(join(clone, 'resources/用户资源.md'), md)
    await expect(hook(buildContext)).rejects.toThrow('overwrite was stopped')
    expect(await readFile(join(clone, '文稿/原稿.md'))).toEqual(md)
    const launch = async (): Promise<void> => {
      app = await electron.launch({
        executablePath: join(clone, manifest.executable),
        args: [],
        env: { ...process.env, ZHUMO_USER_DATA: profile }
      })
      await expect((await app.firstWindow()).getByText('另有天地。')).toBeVisible()
    }
    const close = async (): Promise<void> => {
      const closed = app!.waitForEvent('close')
      await app!.evaluate(({ app }) => app.quit())
      await closed
      app = undefined
    }
    await launch()
    await (
      await app!.firstWindow()
    ).evaluate(async () => {
      await window.api.saveSettings({
        ...(await window.api.getSettings()),
        fontSize: 23,
        automaticSyntax: false
      })
      localStorage.setItem('zhumo.studio.theme', 'lucent')
    })
    await close()
    const settings = await readFile(join(profile, 'settings.json'))
    const driver = join(root, 'check.cjs'),
      report = join(root, 'report.json')
    await writeFile(
      driver,
      `const fs=require('node:fs/promises'),p=require('node:path');
(async()=>{
 const [modulePath,original,installed,pin,store,report,modified]=process.argv.slice(2),api=require(modulePath);
 const raw=await fs.readFile(p.join(original,'program-files.v1.json'));
 const source=await api.auditProgramFiles(original,raw,pin);
 if(source.identity!=='matched'||source.changed.length||source.missing.length||source.linked.length)throw Error('Final packaged bytes disagree with the build manifest');
 const before=await api.auditProgramFiles(installed,raw,pin);
 if(before.changed.length!==1||before.changed[0]!==modified)throw Error('Modified resource not distinguished');
 const retired=await api.retireProgramFiles(installed,raw,pin,store);
 const recovery=await api.restoreRetiredProgramFiles(installed,raw,pin,store);
 if(recovery.conflicts.length)throw Error('Recovery incomplete');
 const after=await api.auditProgramFiles(installed,raw,pin);
 await fs.writeFile(report,JSON.stringify({sourceIdentity:source.identity,sourceFiles:source.unchanged.length,retired:retired.retired.length,restored:recovery.restored.length,changed:after.changed,unlisted:after.unlisted,conflicts:recovery.conflicts},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});`
    )
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(
        join(artifact, manifest.executable),
        [
          driver,
          join(artifact, 'resources/app.asar/out/main/program-files.js'),
          artifact,
          clone,
          receipt.manifestHash,
          join(root, '可恢复暂存'),
          report,
          modified
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      const chunks: Buffer[] = []
      child.stdout.on('data', (p) => chunks.push(p))
      child.stderr.on('data', (p) => chunks.push(p))
      child.once('error', reject)
      child.once('close', (code) => done({ code, output: Buffer.concat(chunks).toString() }))
    })
    expect(result.output).not.toContain('Error')
    expect(result.code).toBe(0)
    const evidence = JSON.parse(await readFile(report, 'utf8'))
    expect(evidence.sourceFiles).toBe(manifest.files.length)
    expect(evidence.retired).toBe(manifest.files.length - 1)
    expect(evidence.restored).toBe(manifest.files.length - 1)
    expect(evidence.changed).toEqual([modified])
    expect(await readFile(join(clone, '文稿/原稿.md'))).toEqual(md)
    expect(await readFile(join(clone, 'resources/用户资源.md'))).toEqual(md)
    expect(await readFile(join(clone, modified))).toEqual(modifiedBytes)
    expect(await readFile(join(profile, 'settings.json'))).toEqual(settings)
    await launch()
    const page = await app!.firstWindow()
    expect((await page.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('lucent')
    await app!.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      },
      join(clone, '文稿/原稿.md')
    )
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.reader-scroll')).toContainText('所有权之外的原稿')
    await close()
    await mkdir('work/program-files', { recursive: true })
    await writeFile(
      'work/program-files/packaged-recovery.json',
      JSON.stringify(
        {
          ...evidence,
          fontSize: 23,
          actualTheme: 'lucent',
          manuscriptBytesPreserved: true,
          settingsPreserved: true,
          modifiedResourcePreserved: true,
          unsafeBuildOverwriteRefused: true,
          realModelsCalled: false,
          scope: 'packaged API + clone retirement/rollback; not a complete installer update'
        },
        null,
        2
      )
    )
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-owned-package-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
