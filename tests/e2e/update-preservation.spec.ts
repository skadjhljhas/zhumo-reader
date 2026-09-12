import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
import {
  createPreservationSnapshot,
  restorePreservationSnapshot
} from '../../src/main/update-preservation'

test('an entire stopped Electron profile recovers decryptable credentials, actual theme preferences and exact manuscripts in a new location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-recovery-ui-')),
    originalProfile = join(root, '旧配置'),
    library = join(root, '旧程序', '文稿'),
    snapshot = join(root, '保存点')
  await mkdir(library, { recursive: true })
  const bytes = Buffer.from(
    '\uFEFF# 恢复后仍然可读\r\n\r\n原文 **保留**[^注]。\r\n\r\n[^注]: 原注释。\r\n'
  )
  await writeFile(join(library, '原稿.md'), bytes)
  let app: ElectronApplication | undefined
  const launch = async (profile: string): Promise<void> => {
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
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
  try {
    await launch(originalProfile)
    let page = await app!.firstWindow()
    await app!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, library)
    expect(await page.evaluate(() => window.api.chooseManuscriptLocation())).toMatchObject({
      path: await realpath(library),
      available: true
    })
    await page.evaluate(async (defaults) => {
      await window.api.saveSettings({ ...(await window.api.getSettings()), fontSize: 23 })
      await window.ai!.saveProfile('syntax', {
        ...defaults,
        endpoint: 'http://127.0.0.1:9/v1',
        model: 'fixture-no-network',
        apiKey: 'fixture-preserved-secret'
      })
      localStorage.setItem('zhumo.studio.theme', 'chaosheng')
      localStorage.setItem('zhumo.peek.transparency', '67')
      localStorage.setItem('zhumo.notes.hover', 'false')
    }, defaultAiProfile('syntax'))
    await close()
    const state = await readFile(join(originalProfile, 'Local State')),
      config = await readFile(join(originalProfile, 'ai-models.v1.json'))
    await createPreservationSnapshot([originalProfile, join(root, '旧程序')], snapshot)
    const [profile, program] = await restorePreservationSnapshot(snapshot, join(root, '恢复副本'))
    // Verify raw profile bytes before Chromium legitimately updates its own runtime state.
    expect(await readFile(join(profile, 'Local State'))).toEqual(state)
    expect(await readFile(join(profile, 'ai-models.v1.json'))).toEqual(config)
    expect(await readFile(join(program, '文稿', '原稿.md'))).toEqual(bytes)
    await launch(profile)
    page = await app!.firstWindow()
    expect((await page.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect(await page.evaluate(() => window.api.manuscriptLocation())).toMatchObject({
      path: await realpath(library),
      available: true
    })
    expect(
      await page.evaluate(() => [
        localStorage.getItem('zhumo.studio.theme'),
        localStorage.getItem('zhumo.peek.transparency'),
        localStorage.getItem('zhumo.notes.hover')
      ])
    ).toEqual(['chaosheng', '67', 'false'])
    expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('chaosheng')
    expect((await page.evaluate(() => window.ai!.getProfiles())).syntax).toMatchObject({
      model: 'fixture-no-network',
      keyStorage: 'encrypted'
    })
    const cipher = JSON.parse(config.toString()).syntax.cipher
    expect(
      await app!.evaluate(
        ({ safeStorage }, cipher) =>
          safeStorage.decryptString(Buffer.from(cipher, 'base64')) === 'fixture-preserved-secret',
        cipher
      )
    ).toBe(true)
    await app!.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      },
      join(program, '文稿', '原稿.md')
    )
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.reader-scroll')).toContainText('恢复后仍然可读')
    await expect(page.locator('.reader-scroll .zmu-ref')).toHaveCount(1)
    await close()
    expect(await readFile(join(library, '原稿.md'))).toEqual(bytes)
    expect(await readFile(join(originalProfile, 'ai-models.v1.json'))).toEqual(config)
    await mkdir('work/update-preservation', { recursive: true })
    await writeFile(
      'work/update-preservation/electron-recovery.json',
      JSON.stringify(
        {
          encryptedCredentials: true,
          localStateBytes: true,
          actualTheme: 'chaosheng',
          fontSize: 23,
          localStoragePreferences: true,
          manuscriptBytes: true,
          originalUnchanged: true,
          modelRequests: 0,
          scope: 'stopped-profile snapshot and restore; not an NSIS upgrade test'
        },
        null,
        2
      )
    )
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-recovery-ui-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
