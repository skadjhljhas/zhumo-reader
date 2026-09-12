import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-types'

test('bright moving reflections follow glyph alpha while original ink and source stay intact', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-glyph-reflection-'))
  const profile = join(root, 'profile'),
    book = join(root, '日光与文字.md')
  await mkdir(profile)
  await mkdir('work/reflection61', { recursive: true })
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ ...DEFAULT_SETTINGS, lightRange: 'hdr', automaticSyntax: false })
  )
  const source =
    '# 日光穿过文字\n\n海面把一束光还给天空。不是整片海都亮起来：只有那些恰好迎向日光的细小波面，忽然成为光，随后又让它离开。\n\n文字也可以这样接住光。笔画仍然清楚，亮纹在它的表面缓缓经过，沿着边缘散成很轻的辉光。字与字之间，并不是黑暗的空洞。\n\n## 在明亮处阅读\n\n阅读不是把世界关在纸页之外。我们带着此刻的阳光、尚未解决的问题，以及一条刚刚想起的句子，走进下一行。\n\n' +
    Array.from(
      { length: 12 },
      () => '有些意义来得很慢，而光可以先到。它从文字之间流过，留下亮堂、通透的空间。\n\n'
    ).join('')
  await writeFile(book, source)
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: profile }
  })
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      localStorage.setItem('zhumo.studio.theme', 'lucent')
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const media = original(query)
        if (query === '(dynamic-range: high)')
          Object.defineProperty(media, 'matches', { get: () => true })
        return media
      }
    })
    await page.reload()
    await app.evaluate(({ dialog, BrowserWindow }, book) => {
      BrowserWindow.getAllWindows()[0].setSize(1500, 1000)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] })
    }, book)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await page.evaluate(() => document.fonts.ready)
    const reflections = page.locator('.glyph-reflection-field')
    await expect(reflections).toHaveAttribute('data-hdr-renderer', 'glyph-reflections')
    await expect(reflections).toHaveAttribute('data-hdr-format', 'rgba16float')
    await expect
      .poll(async () => Number(await reflections.getAttribute('data-glyphs')))
      .toBeGreaterThan(100)
    await expect(page.locator('.zhumo-sky-ink')).toHaveCount(0)
    expect(
      await page.evaluate(() =>
        [...CSS.highlights.keys()].some((name) => name.startsWith('zhumo-sky-tone-'))
      )
    ).toBe(false)
    const paragraph = page.locator('.reader-scroll .section-body p').first()
    const ink = await paragraph.evaluate((element) => getComputedStyle(element).color)
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'work/reflection61/reflections-on.png', scale: 'css' })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: 'work/reflection61/reflections-later.png', scale: 'css' })
    expect(await paragraph.evaluate((element) => getComputedStyle(element).color)).toBe(ink)
    const mask = await page.addStyleTag({
      content: '.glyph-reflection-field{visibility:hidden!important}'
    })
    await page.screenshot({ path: 'work/reflection61/reflections-off.png', scale: 'css' })
    await mask.evaluate((element) => element.parentNode?.removeChild(element))
    await page.locator('.reader-scroll').evaluate((element) => {
      element.scrollTop = 400
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'work/reflection61/reflections-scrolled.png', scale: 'css' })
    // Observe the actual uniform uploads to the active renderer. Quiet mode stops
    // optical time, but scrolling and layout changes must still redraw at the new position.
    const uploads = await reflections.evaluateHandle((element) => {
      const canvas = element as HTMLCanvasElement
      const queue = canvas.getContext('webgpu')!.getConfiguration()!.device.queue
      const write = queue.writeBuffer.bind(queue)
      const rows: number[][] = []
      const copies = { count: 0 }
      const copy = queue.copyExternalImageToTexture.bind(queue)
      queue.copyExternalImageToTexture = (source, destination, size) => {
        copies.count++
        copy(source, destination, size)
      }
      queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
        if (data instanceof Float32Array && data.length === 28)
          rows.push(Array.from({ length: 28 }, (_, i) => data[i]))
        write(buffer, offset, data, dataOffset, size)
      }
      return { rows, copies }
    })
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page.getByRole('button', { name: '静谧', exact: true }).click()
    await expect(page.getByRole('button', { name: '静谧', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await uploads.evaluate(({ rows }) => {
      rows.length = 0
    })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(page.locator('.settings-panel')).toHaveCount(0)
    await expect(reflections).toBeVisible()
    await expect.poll(() => uploads.evaluate(({ rows }) => rows.length)).toBeGreaterThan(0)
    const last = await uploads.evaluate(({ rows }) => rows.at(-1)!)
    expect(last).toHaveLength(28)
    const copiesBefore = await uploads.evaluate(({ copies }) => copies.count)
    await uploads.evaluate(({ rows }) => {
      rows.length = 0
    })
    const moved = await paragraph.evaluate((element) => {
      const port = element.closest('.reader-scroll')!
      const before = element.getBoundingClientRect().top
      port.scrollTop += 25
      return element.getBoundingClientRect().top - before
    })
    await expect.poll(() => uploads.evaluate(({ rows }) => rows.length)).toBeGreaterThan(0)
    const afterScroll = await uploads.evaluate(({ rows }) => rows.at(-1)!)
    const recopied = await uploads.evaluate(({ copies }) => copies.count > 0)
    if ((await uploads.evaluate(({ copies }) => copies.count)) === copiesBefore)
      expect(afterScroll[9] - last[9]).toBeCloseTo(moved, 1)
    else expect(recopied).toBe(true)
    expect(afterScroll[2]).toBe(last[2])
    await uploads.evaluate(({ rows }) => {
      rows.length = 0
    })
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page.getByRole('slider', { name: '正文字号', exact: true }).fill('23')
    await page.getByRole('button', { name: 'SDR · 阅读', exact: true }).click()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await expect(reflections).toHaveAttribute('data-hdr-format', 'rgba8unorm')
    await expect(reflections).not.toHaveAttribute('data-reflection-error', /.+/)
    await expect
      .poll(() => uploads.evaluate(({ rows }) => rows.some((row) => row[3] === 0)))
      .toBe(true)
    await page.screenshot({ path: 'work/reflection61/reflections-sdr-large.png', scale: 'css' })
    await page.locator('.reader-scroll').evaluate((element) => {
      element.scrollTop = 0
    })
    const imageHandle = await paragraph.evaluateHandle((element) => {
      const image = document.createElement('img')
      image.style.width = '300px'
      image.alt = 'delayed fixture'
      element.after(image)
      return image
    })
    await page.waitForTimeout(200)
    const following = page.locator('.reader-scroll .section-body p').nth(1)
    const topBefore = await following.evaluate((element) => element.getBoundingClientRect().top)
    const firstTop = await paragraph.evaluate((element) => element.getBoundingClientRect().top)
    const copiesBeforeImage = await uploads.evaluate(({ copies }) => copies.count)
    await imageHandle.evaluate((image) => {
      image.src =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160"><rect width="300" height="160" fill="#eef4fa"/></svg>'
        )
    })
    await expect
      .poll(() => following.evaluate((element) => element.getBoundingClientRect().top))
      .toBeGreaterThan(topBefore + 120)
    expect(await paragraph.evaluate((element) => element.getBoundingClientRect().top)).toBe(
      firstTop
    )
    await expect
      .poll(() => uploads.evaluate(({ copies }) => copies.count))
      .toBeGreaterThan(copiesBeforeImage)
    await uploads.evaluate(({ rows }) => {
      rows.length = 0
    })
    const beforeWidth = await page
      .locator('.reader-scroll')
      .evaluate((element) => element.clientWidth)
    await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
    await expect(page.locator('.notes-sidebar')).toHaveCount(0)
    await expect
      .poll(() => uploads.evaluate(({ rows }) => rows.some((row) => row[6] > 0)))
      .toBe(true)
    expect(
      await page.locator('.reader-scroll').evaluate((element) => element.clientWidth)
    ).toBeGreaterThan(beforeWidth)
    await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
    await expect(page.locator('.notes-sidebar')).toBeVisible()
    const oldDevice = await reflections.evaluateHandle(
      (element) => (element as HTMLCanvasElement).getContext('webgpu')!.getConfiguration()!.device
    )
    await oldDevice.evaluate((device) => device.destroy())
    await expect
      .poll(() =>
        oldDevice.evaluate((device) => {
          const canvas = document.querySelector(
            '.glyph-reflection-field'
          ) as HTMLCanvasElement | null
          const next = canvas?.getContext('webgpu')?.getConfiguration()?.device
          return Boolean(next && next !== device)
        })
      )
      .toBe(true)
    await expect(reflections).toHaveAttribute('data-hdr-format', 'rgba8unorm')
    await expect(reflections).not.toHaveAttribute('data-reflection-error', /.+/)
    await expect
      .poll(async () => Number(await reflections.getAttribute('data-glyphs')))
      .toBeGreaterThan(100)
    await oldDevice.dispose()
    await imageHandle.dispose()
    expect(errors).toEqual([])
    expect(await readFile(book, 'utf8')).toBe(source)
  } finally {
    await app.close()
  }
})
