/// <reference types="@webgpu/types" />
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'

test('the Markdown acceptance document renders lists, tables, formula variants and a retained unsupported expression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-md-acceptance-'))
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 1200))
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, resolve('docs/markdown-compatibility-sample.md'))
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.reader-scroll .zmu-task-checkbox')).toHaveCount(3)
    await expect(page.locator('.reader-scroll table')).toHaveCount(1)
    await expect(page.locator('.reader-scroll .zmu-math[data-math-error]')).toHaveCount(1)
    await expect(page.locator('.reader-scroll [data-math-engine="mathjax"]')).not.toHaveCount(0)
    await expect(page.locator('.reader-scroll code.language-tex')).toContainText('begin{align}')
    expect(await page.locator('.reader-scroll').textContent()).toContain('普通金额 $5 和 $10')
    await page.screenshot({ path: 'work/hdr-fonts/markdown-acceptance.png' })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('native scroll anchoring, imported fonts across restart, HDR capability fallback and float output', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-hdr-fonts-')),
    profile = join(root, 'profile'),
    file = join(root, '光与字形.md')
  await mkdir(profile)
  await mkdir('work/hdr-fonts', { recursive: true })
  const source =
    '# 光与字形\n\n自由并不是任意；理解意味着重新阅读。[^a]\n\n' +
    Array.from({ length: 14 }, (_, i) => `第${i + 1}段。文字留在此处，光随阅读流动。`).join(
      '\n\n'
    ) +
    '\n\n[^a]: 这是保留在页边的用户注释。\n'
  await writeFile(file, source)
  let calls = 0,
    app: ElectronApplication | undefined
  const errors: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      calls++
      const text = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content)
        .selectedText as string
      const record = [
        { type: 'begin', version: 4 },
        {
          type: 'mark',
          quote: text.includes('自由') ? '自由' : text.slice(0, 4),
          occurrence: 1,
          textColor: '#386491',
          glowColor: '#e7bd91'
        },
        { type: 'done' }
      ]
        .map((x) => JSON.stringify(x))
        .join('\n')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content: record }, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  await writeFile(
    join(profile, 'ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'hdr-font-fixture',
        settings: {
          ...defaultAiProfile('syntax'),
          model: 'fixture',
          context: 'selection',
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
        }
      }
    })
  )
  const evidence: Record<string, unknown> = {
    execution: 'hidden offscreen; HDR display changes simulated only for GPU path checks'
  }
  try {
    const launch = async (): Promise<Page> => {
      app = await electron.launch({
        executablePath: process.env.ZHUMO_E2E_EXE,
        args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
        env: { ...process.env, ZHUMO_USER_DATA: profile }
      })
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1500, 1030)
      )
      const page = await app.firstWindow()
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('HDR'))
          console.log(message.text())
      })
      await page.evaluate(() => localStorage.setItem('zhumo.studio.theme', 'lucent'))
      await page.reload()
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })
        Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      })
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, file)
      await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
      return page
    }
    let page = await launch()
    const mark = page.locator('.reading-color-mark[data-quote="自由"]').first()
    await expect(mark).toHaveCount(1, { timeout: 16000 })
    await expect(
      page.locator('.sdr-color-canvas[data-hdr-format="rgba8unorm"]').first()
    ).toBeVisible()
    await page.waitForTimeout(2800)
    const anchored = await page.evaluate(() => {
      const range = [...CSS.highlights]
        .find(
          ([k]) =>
            k.startsWith('zhumo-reading-color-') &&
            [...CSS.highlights.get(k)!].some((r) => (r as Range).toString() === '自由')
        )![1]
        .values()
        .next().value as Range
      const mark = document.querySelector('.reading-color-mark[data-quote="自由"]')!,
        glow =
          mark.closest('.reading-color-light')?.querySelector('.sdr-color-canvas') ??
          mark.querySelector('.color-primary')!,
        scroller = document.querySelector('.reader-scroll')!
      const before = [range.getBoundingClientRect().top, glow.getBoundingClientRect().top]
      scroller.scrollTop += 60
      // Same JavaScript task: no measurement callback can have run between these reads.
      const after = [range.getBoundingClientRect().top, glow.getBoundingClientRect().top]
      return {
        before,
        after,
        drift: after[0] - before[0] - (after[1] - before[1]),
        host: glow.closest('.reading-color-anchor')?.tagName
      }
    })
    expect(Math.abs(anchored.drift)).toBeLessThan(0.05)
    expect(anchored.host).toBe('P')
    evidence.anchored = anchored
    await page.keyboard.press('Control+,')
    const fonts = [
      ['界面', 'uiFont', 'arial.ttf'],
      ['正文', 'bodyFont', 'times.ttf'],
      ['注释', 'noteFont', 'consola.ttf']
    ] as const
    for (const [name, key, filename] of fonts) {
      await app!.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, 'C:/Windows/Fonts/' + filename)
      await page.getByRole('button', { name: '导入' + name + '字体', exact: true }).click()
      await expect(page.locator('#font-' + key)).not.toHaveValue('')
    }
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const s = await window.api.getSettings()
          return !!(s.uiFont && s.bodyFont && s.noteFont)
        })
      )
      .toBe(true)
    const saved = await page.evaluate(() => window.api.getSettings())
    for (const [, key] of fonts) expect(saved[key]).toMatch(/^[0-9a-f]{64}$/)
    expect(
      await page.evaluate(
        () =>
          [...document.fonts].filter(
            (f) => f.family.startsWith('ZhuMoFont_') && f.status === 'loaded'
          ).length
      )
    ).toBe(3)
    await page.getByRole('button', { name: 'HDR · 展示', exact: true }).click()
    await expect(page.locator('.light-range-settings')).toContainText('当前系统显示通道仍为 SDR')
    expect(await page.locator('.hdr-canvas').count()).toBe(0)
    await page.screenshot({ path: 'work/hdr-fonts/settings-sdr.png' })
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.waitForTimeout(800)
    await app!.close()
    app = undefined
    page = await launch()
    const restored = await page.evaluate(() => window.api.getSettings())
    for (const [, key] of fonts) expect(restored[key]).toBe(saved[key])
    expect(restored.lightRange).toBe('hdr')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.fonts].filter(
              (f) => f.family.startsWith('ZhuMoFont_') && f.status === 'loaded'
            ).length
        )
      )
      .toBe(3)
    evidence.fonts = {
      persisted: fonts.map(([, key]) => ({ role: key, id: restored[key] })),
      bytesPreserved: (await readFile(file, 'utf8')) === source
    }
    await page.addInitScript(() => {
      localStorage.setItem('zhumo.notes.hover', 'false')
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query: string) => {
        const result = original(query)
        if (query === '(dynamic-range: high)')
          Object.defineProperty(result, 'matches', { get: () => true })
        return result
      }
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
    })
    await page.reload()
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.reading-color-light .hdr-canvas').first()).toBeVisible({
      timeout: 16000
    })
    const largeHost = page.locator('.reader-scroll .section-body p').first()
    await largeHost.evaluate((el) => {
      el.style.minHeight = '100000px'
    })
    await expect
      .poll(() =>
        largeHost
          .locator('.hdr-canvas')
          .evaluateAll((canvases) => canvases.every((c) => (c as HTMLCanvasElement).height <= 768))
      )
      .toBe(true)
    expect(await largeHost.locator('.hdr-canvas').count()).toBeGreaterThan(0)
    await largeHost.evaluate((el) => {
      el.style.removeProperty('min-height')
    })
    const resets = await page.evaluate(async () => {
      const existing = new Set(document.querySelectorAll('.reading-color-light .hdr-canvas'))
      let count = 0
      const observer = new MutationObserver((records) => {
        count += records.filter(
          (record) =>
            existing.has(record.target as Element) &&
            record.oldValue === (record.target as Element).getAttribute(record.attributeName!)
        ).length
      })
      const next = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()))
      await next()
      await next()
      observer.observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['width', 'height'],
        attributeOldValue: true
      })
      const status = document.createElement('span')
      status.hidden = true
      document.body.append(status)
      const scroll = document.querySelector('.reader-scroll')!,
        before = scroll.scrollTop
      for (let i = 0; i < 12; i++) {
        status.textContent = String(i)
        scroll.scrollTop = before + (i % 2) * 80
        await next()
      }
      scroll.scrollTop = before
      await next()
      await next()
      observer.disconnect()
      status.remove()
      return count
    })
    expect(
      resets,
      'Scrolling and unrelated UI updates must not reset HDR canvases to unchanged dimensions'
    ).toBe(0)
    expect(await page.locator('[data-hdr-renderer="instanced-bands"]').count()).toBeGreaterThan(0)
    expect(
      await page
        .locator('.color-band-svg')
        .evaluateAll(
          (elements) =>
            elements
              .flatMap((el) => el.getAnimations({ subtree: true }))
              .filter((animation) => animation.playState === 'running').length
        )
    ).toBe(0)
    const density = await page.evaluate(() => {
      const original = devicePixelRatio
      const canvas = document.querySelector(
        '[data-hdr-renderer="instanced-bands"]'
      ) as HTMLCanvasElement
      const before = {
        width: canvas.width,
        height: canvas.height,
        left: canvas.getBoundingClientRect().left
      }
      Object.defineProperty(window, 'devicePixelRatio', { value: original * 2, configurable: true })
      window.dispatchEvent(new Event('resize'))
      return { original, before }
    })
    await expect
      .poll(() =>
        page
          .locator('[data-hdr-renderer="instanced-bands"]')
          .first()
          .evaluate((c) => (c as HTMLCanvasElement).width)
      )
      .toBe(density.before.width * 2)
    expect(
      await page
        .locator('[data-hdr-renderer="instanced-bands"]')
        .first()
        .evaluate((c) => c.getBoundingClientRect().left)
    ).toBeCloseTo(density.before.left, 1)
    await page.evaluate((value) => {
      Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true })
      window.dispatchEvent(new Event('resize'))
    }, density.original)
    await expect
      .poll(() =>
        page
          .locator('[data-hdr-renderer="instanced-bands"]')
          .first()
          .evaluate((c) => (c as HTMLCanvasElement).width)
      )
      .toBe(density.before.width)
    const paragraph = page.locator('.reader-scroll .section-body p').first()
    const echoPoint = await paragraph.evaluate((el) => {
      window.getSelection()?.removeAllRanges()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const at = node.textContent!.indexOf('理解')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 2)
        const box = range.getClientRects()[0]
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      throw Error('Missing fixture echo word')
    })
    await page.mouse.up()
    await page.mouse.move(echoPoint.x, echoPoint.y)
    await page.waitForFunction(
      () =>
        Number((document.querySelector('.reading-echo-light') as HTMLElement)?.dataset.strength) >
        0.01,
      undefined,
      { timeout: 8000 }
    )
    const copied = await page.evaluate(async () => {
      const before = {
        pixels: Number(document.documentElement.dataset.hdrCopiedPixels),
        copies: Number(document.documentElement.dataset.hdrSourceCopies)
      }
      await new Promise((done) => setTimeout(done, 1200))
      const source = document.querySelector('.reading-echo-light') as HTMLCanvasElement
      return {
        pixels: Number(document.documentElement.dataset.hdrCopiedPixels) - before.pixels,
        copies: Number(document.documentElement.dataset.hdrSourceCopies) - before.copies,
        viewport: source.width * source.height
      }
    })
    expect(copied.copies).toBeGreaterThan(0)
    expect(copied.pixels / copied.copies).toBeLessThan(copied.viewport * 0.2)
    await page.locator('.reader-scroll').evaluate((el) => {
      el.scrollTop = 0
    })
    await page.locator('.reader-scroll .zmu-ref-mark').first().hover()
    await expect(page.locator('.hdr-threads .hdr-canvas').first()).toBeVisible()
    evidence.hdrLayers = await page.locator('.hdr-canvas').evaluateAll((canvases) =>
      canvases.map((canvas) => ({
        parent: canvas.parentElement?.className,
        format: (canvas as HTMLElement).dataset.hdrFormat
      }))
    )
    await expect(page.locator('.hdr-canvas').first()).toBeVisible({ timeout: 15000 })
    const gpu = await page.evaluate(async () => {
      const canvas = document.querySelector('.reading-atmosphere .hdr-canvas') as HTMLCanvasElement
      const context = canvas.getContext('webgpu')!,
        configuration = context.getConfiguration()!,
        device = configuration.device
      const result = await new Promise<{ peak: number; width: number; height: number }>((resolve) =>
        requestAnimationFrame(() => {
          const texture = context.getCurrentTexture(),
            stride = Math.ceil((texture.width * 8) / 256) * 256
          const buffer = device.createBuffer({
            size: stride * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          })
          const encoder = device.createCommandEncoder()
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [
            texture.width,
            texture.height
          ])
          device.queue.submit([encoder.finish()])
          void buffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new Uint16Array(buffer.getMappedRange())
            let peak = 0
            for (let y = 0; y < texture.height; y += 3)
              for (let x = 0; x < texture.width; x += 3)
                for (let c = 0; c < 3; c++) {
                  const h = data[(y * stride) / 2 + x * 4 + c],
                    exponent = (h >> 10) & 31,
                    mantissa = h & 1023
                  const value =
                    (h & 32768 ? -1 : 1) *
                    (exponent
                      ? Math.pow(2, exponent - 15) * (1 + mantissa / 1024)
                      : (Math.pow(2, -14) * mantissa) / 1024)
                  peak = Math.max(peak, value)
                }
            buffer.unmap()
            buffer.destroy()
            resolve({ peak, width: texture.width, height: texture.height })
          })
        })
      )
      return {
        ...result,
        format: configuration.format,
        toneMapping: configuration.toneMapping?.mode
      }
    })
    expect(gpu.format).toBe('rgba16float')
    expect(gpu.toneMapping).toBe('extended')
    expect(gpu.peak).toBeGreaterThan(1.05)
    evidence.gpu = gpu
    await page.screenshot({ path: 'work/hdr-fonts/hdr-tonemapped-preview.png' })
    // Device recovery is a software lifecycle check, not a physical HDR measurement.
    const lostDevice = await page.evaluateHandle(() => {
      const c = document.querySelector('.hdr-canvas') as HTMLCanvasElement
      return c.getContext('webgpu')!.getConfiguration()!.device
    })
    await lostDevice.evaluate((device) => device.destroy())
    await expect
      .poll(() =>
        lostDevice.evaluate((device) => {
          const c = document.querySelector(
            '.reading-atmosphere .hdr-canvas'
          ) as HTMLCanvasElement | null
          const current = c?.getContext('webgpu')?.getConfiguration()
          return Boolean(current && current.device !== device && current.format === 'rgba16float')
        })
      )
      .toBe(true)
    await lostDevice.dispose()
    expect(errors).toEqual([])
    evidence.localFixtureRequests = calls
    await writeFile('work/hdr-fonts/verification.json', JSON.stringify(evidence, null, 2))
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
