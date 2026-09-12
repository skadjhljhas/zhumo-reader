import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'

test('automatic annotation delay is adjustable from one to fifteen seconds and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-dwell-setting-')),
    profile = join(root, 'profile')
  let app: ElectronApplication | undefined
  const launch = async (): Promise<void> => {
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
      env: { ...process.env, ZHUMO_USER_DATA: profile }
    })
  }
  try {
    await launch()
    let page = await app!.firstWindow()
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    let slider = page.getByRole('slider', { name: '自动标注等待时间', exact: true })
    await expect(slider).toHaveValue('5')
    await slider.focus()
    await page.keyboard.press('Home')
    await expect(slider).toHaveValue('1')
    await page.keyboard.press('End')
    await expect(slider).toHaveValue('15')
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}'))
            .automaticSyntaxWaitSeconds
      )
      .toBe(15)
    await app!.close()
    app = undefined
    await launch()
    page = await app!.firstWindow()
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    slider = page.getByRole('slider', { name: '自动标注等待时间', exact: true })
    await expect(slider).toHaveValue('15')
    expect((await page.evaluate(() => window.api.getSettings())).automaticSyntaxWaitSeconds).toBe(
      15
    )
  } finally {
    await app?.close()
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-dwell-setting-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
