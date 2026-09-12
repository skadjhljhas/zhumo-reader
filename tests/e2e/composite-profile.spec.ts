import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-types'

test('compare compositor costs using a hidden shared GPU texture surface', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-composite-profile-')),
    profile = join(root, 'profile'),
    book = join(root, '光的开销.md')
  await mkdir(profile)
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ ...DEFAULT_SETTINGS, lightRange: 'hdr', automaticSyntax: false })
  )
  await writeFile(
    book,
    '# 光的开销\n\n' +
      Array.from(
        { length: 40 },
        (_, i) => `光沿着字句移动。文字保持清晰，旁注保留另一条阅读路径。[^n${i}]\n\n`
      ).join('') +
      Array.from(
        { length: 40 },
        (_, i) => `[^n${i}]: 这是第 ${i + 1} 条旁注，它也属于同一片阅读空间。\n\n`
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
    })
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(1920, 1080)
      w.webContents.setFrameRate(240)
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
    await expect(page.locator('[data-hdr-renderer="native-field"]')).toBeVisible()
    await cdp.send('Performance.enable')
    await page.evaluate(() => {
      const target = document.querySelector('.reader-scroll .section-body')!
      for (let i = 0; i < 30; i++) {
        const layer = document.createElement('div')
        layer.className = 'reading-color-light'
        layer.dataset.motion = 'full'
        layer.innerHTML =
          '<svg class="color-band-svg" width="100" height="24"><rect class="color-opal" width="80" height="15" fill="#b4dce8"/></svg>'
        target.append(layer)
      }
    })
    const rows: Array<Record<string, unknown>> = []
    for (const [label, css] of [
      [
        'hidden-filter-animation',
        'html[data-light-range=hdr] .color-band-svg .color-opal{animation:color-opal-breath 11s ease-in-out infinite alternate!important}'
      ],
      [
        'no-hidden-animation',
        'html[data-light-range=hdr] .color-band-svg *{animation:none!important;transition:none!important}'
      ],
      [
        'field-only',
        '*{backdrop-filter:none!important} html[data-light-range=hdr] .color-band-svg *{animation:none!important} .studio-toolbar,.statusbar,.studio-rail,.toc-drawer,.notes-sidebar,.reader-scroll,.optical-overlays{visibility:hidden!important}'
      ]
    ]) {
      await page.evaluate((css) => {
        let s = document.getElementById('diagnostic-style')
        if (!s) {
          s = document.createElement('style')
          s.id = 'diagnostic-style'
          document.head.append(s)
        }
        s.textContent = css
      }, css)
      const before = await cdp.send('Performance.getMetrics')
      const frames = await page.evaluate(
        () =>
          new Promise<{ fps: number; p95: number; width: number; height: number }>((done) => {
            const durations: number[] = []
            let previous = 0
            const start = performance.now()
            function step(now: number): void {
              if (previous) durations.push(now - previous)
              previous = now
              if (now - start < 4000) {
                requestAnimationFrame(step)
                return
              }
              durations.sort((a, b) => a - b)
              const c = document.querySelector(
                '[data-hdr-renderer="native-field"]'
              ) as HTMLCanvasElement
              done({
                fps: 1000 / (durations.reduce((a, b) => a + b, 0) / durations.length),
                p95: durations[Math.floor(durations.length * 0.95)],
                width: c.width,
                height: c.height
              })
            }
            requestAnimationFrame(step)
          })
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
    await mkdir('work/hdr-perf', { recursive: true })
    await writeFile(
      'work/hdr-perf/compositor.json',
      JSON.stringify({ mode: 'hidden shared texture, not physical display FPS', rows }, null, 2)
    )
  } finally {
    await app.close()
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-composite-profile-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
