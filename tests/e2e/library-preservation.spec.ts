import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  realpath,
  rm
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultAiProfile } from '../../src/shared/ai-types'

test('library choices survive restart with settings and encrypted credentials; unavailable libraries never silently reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-library-ui-')),
    profile = join(root, 'profile'),
    library = join(root, '我的文稿'),
    relocated = join(root, '移动后的文稿')
  await mkdir(library)
  const bytes = Buffer.from(
    '\uFEFF# 旧文稿\r\n\r\n保留 **格式**[^注]。\r\n\r\n[^注]: 保留注释。\r\n'
  )
  await writeFile(join(library, '原稿.md'), bytes)
  let app: ElectronApplication | undefined, page: Page
  const launch = async (): Promise<void> => {
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
      env: { ...process.env, ZHUMO_USER_DATA: profile }
    })
    page = await app.firstWindow()
    await expect(page.getByText('另有天地。')).toBeVisible()
  }
  try {
    await launch()
    await app!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, library)
    await page!.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page!.getByRole('button', { name: '选择文稿文件夹', exact: true }).click()
    await expect(page!.locator('.manuscript-location-settings')).toContainText(
      await realpath(library)
    )
    await page!.evaluate(async (defaults) => {
      await window.api.saveSettings({ ...(await window.api.getSettings()), fontSize: 23 })
      await window.ai!.saveProfile('reading', {
        ...defaults,
        endpoint: 'http://127.0.0.1:9/v1',
        model: 'fixture-no-calls',
        apiKey: 'fixture-credential'
      })
    }, defaultAiProfile('reading'))
    const before = JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8'))
    const closed = app!.waitForEvent('close')
    await app!.evaluate(({ app }) => app.quit())
    await closed
    const key = JSON.parse(await readFile(join(profile, 'Local State'), 'utf8')).os_crypt
      ?.encrypted_key
    app = undefined
    await launch()
    expect(await page!.evaluate(() => window.api.manuscriptLocation())).toMatchObject({
      path: await realpath(library),
      available: true
    })
    expect((await page!.evaluate(() => window.api.getSettings())).fontSize).toBe(23)
    expect((await page!.evaluate(() => window.ai!.getProfiles())).reading).toMatchObject({
      model: 'fixture-no-calls',
      keyStorage: 'encrypted'
    })
    const after = JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8'))
    expect(after.reading.cipher).toBe(before.reading.cipher)
    expect(
      JSON.parse(await readFile(join(profile, 'Local State'), 'utf8')).os_crypt?.encrypted_key
    ).toBe(key)
    await rename(library, relocated)
    expect(await page!.evaluate(() => window.api.manuscriptLocation())).toMatchObject({
      path: library,
      available: false
    })
    await expect(page!.evaluate(() => window.api.openBookDialog())).rejects.toThrow(
      '未创建替代目录'
    )
    expect(await readdir(join(profile, '文稿'))).toEqual([])
    await app!.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, relocated)
    await page!.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page!.getByRole('button', { name: '选择文稿文件夹', exact: true }).click()
    await expect(page!.locator('.manuscript-location-settings')).toContainText(
      await realpath(relocated)
    )
    expect(await readFile(join(relocated, '原稿.md'))).toEqual(bytes)
    await mkdir('work/library', { recursive: true })
    await page!.screenshot({ path: 'work/library/location-and-recovery.png' })
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
