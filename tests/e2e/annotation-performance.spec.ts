import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-types'
import { defaultAiProfile } from '../../src/shared/ai-types'

const words = ['自由', '理解', '经验', '语言', '关系', '世界', '解释', '意义']
const send = (res: ServerResponse, record: unknown): void => {
  res.write(
    'data: ' +
      JSON.stringify({ choices: [{ delta: { content: JSON.stringify(record) } }] }) +
      '\n\n'
  )
}

test('profile ten concurrent annotation streams and scrolling at native HDR density', async () => {
  test.setTimeout(90000)
  const sdr = process.env.ZHUMO_PERF_RANGE === 'sdr'
  const root = await mkdtemp(join(tmpdir(), 'zhumo-annotation-profile-')),
    profile = join(root, 'profile'),
    book = join(root, '标注与帧时间.md')
  const pending: ServerResponse[] = [],
    timers: ReturnType<typeof setTimeout>[] = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      pending.push(res)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': fixed localhost fixture; no model calls\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  await mkdir(profile)
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      lightRange: sdr ? 'sdr' : 'hdr',
      automaticSyntax: true,
      automaticSyntaxWaitSeconds: 1
    })
  )
  await writeFile(
    join(profile, 'ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'performance-fixture',
        settings: {
          ...defaultAiProfile('syntax'),
          model: 'fixture-no-real-model',
          context: 'selection',
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
        }
      }
    })
  )
  await writeFile(
    book,
    '# 标注与帧时间\n\n' +
      Array.from(
        { length: 45 },
        (_, i) => `第${i + 1}段：${words.join('、')}，都在阅读中重新相遇。\n\n`
      ).join('')
  )
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: profile, ZHUMO_TEST_SHARED_TEXTURES: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      localStorage.setItem('zhumo.studio.theme', 'lucent')
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const media = original(query)
        if (query === '(dynamic-range: high)')
          Object.defineProperty(media, 'matches', { get: () => true })
        return media
      }
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true })
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
    })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1920, 1080)
      win.webContents.setFrameRate(240)
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 2,
      mobile: false
    })
    await page.reload()
    await app.evaluate(({ dialog }, book) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] })
    }, book)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(
      page.locator(sdr ? '.optical-field' : '[data-hdr-renderer="native-field"]')
    ).toBeVisible()
    await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
    await expect.poll(() => pending.length, { timeout: 10000 }).toBe(10)
    await cdp.send('Performance.enable')
    const rows: Array<Record<string, unknown>> = []
    const sample = async (label: string, duration = 3000, scroll = false): Promise<void> => {
      const before = await cdp.send('Performance.getMetrics')
      const frames = await page.evaluate(
        ({ duration, scroll }) =>
          new Promise<Record<string, unknown>>((done) => {
            const times: number[] = [],
              start = performance.now()
            const scroller = document.querySelector('.reader-scroll') as HTMLElement
            let previous = 0
            function tick(now: number): void {
              if (previous) times.push(now - previous)
              previous = now
              if (scroll) scroller.scrollTop = 100 + Math.sin((now - start) / 650) * 90
              if (now - start < duration) {
                requestAnimationFrame(tick)
                return
              }
              times.sort((a, b) => a - b)
              done({
                fps: (1000 * times.length) / times.reduce((a, b) => a + b, 0),
                p95: times[Math.floor(times.length * 0.95)],
                p99: times[Math.floor(times.length * 0.99)],
                over16ms: times.filter((t) => t > 16.7).length,
                marks: document.querySelectorAll('.reading-color-mark').length,
                canvases: document.querySelectorAll('[data-hdr-renderer="instanced-bands"]').length,
                highlighters: CSS.highlights.size
              })
            }
            requestAnimationFrame(tick)
          }),
        { duration, scroll }
      )
      const after = await cdp.send('Performance.getMetrics')
      rows.push({
        label,
        ...frames,
        metrics: after.metrics
          .filter((m) => /Duration|Count/.test(m.name))
          .map((m) => ({
            name: m.name,
            delta: m.value - (before.metrics.find((p) => p.name === m.name)?.value ?? 0)
          }))
      })
    }
    await sample('before-marks')
    for (const [responseIndex, response] of pending.entries()) {
      send(response, { type: 'begin', version: 4 })
      words.forEach((word, i) =>
        timers.push(
          setTimeout(
            () =>
              send(response, {
                type: 'mark',
                quote: word,
                occurrence: 1,
                textColor: i % 2 ? '#386491' : '#855578',
                glowColor: i % 2 ? '#e7bd91' : '#9ccfcb',
                ...(process.env.ZHUMO_PERF_RADIANCE === '1' && responseIndex < 3 && i === 0
                  ? { radiance: 0.6 }
                  : {})
              }),
            i * 180
          )
        )
      )
    }
    await sample('streaming-reveal', 5000)
    await expect(page.locator('.reading-color-mark')).toHaveCount(80)
    await sample('settled')
    const highlights = await page.evaluateHandle(
      () => new Map([...CSS.highlights].filter(([name]) => name.startsWith('zhumo-reading-color-')))
    )
    await sample('scrolling', 4000, true)
    expect(
      await highlights.evaluate(
        (before) =>
          before.size === 80 &&
          [...before].every(([name, value]) => CSS.highlights.get(name) === value)
      )
    ).toBe(true)
    await highlights.dispose()
    await page.evaluate(() => {
      CSS.highlights.clear()
    })
    await sample('diagnostic-without-highlights')
    await page.addStyleTag({ content: '.hdr-band-tile {visibility:hidden!important}' })
    await sample('diagnostic-without-band-composition')
    await mkdir('work/hdr-perf', { recursive: true })
    const variant = (process.env.ZHUMO_PERF_VARIANT || 'current').replace(/[^\w-]/g, '')
    await writeFile(
      `work/hdr-perf/annotations-${variant}.json`,
      JSON.stringify(
        {
          mode: 'hidden shared texture, not physical display FPS',
          rows
        },
        null,
        2
      )
    )
  } finally {
    timers.forEach(clearTimeout)
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-annotation-profile-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
