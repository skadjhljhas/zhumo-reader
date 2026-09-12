import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
let app: ElectronApplication, page: Page, root: string, file: string
const source =
  '# 琉璃：光有自己的时间\n\n文字留下来，光缓慢经过。[^甲]\n\n' +
  '阅读展开另一层空间。\n\n'.repeat(25) +
  '[^甲]: 注释走向更深处。[^乙]\n\n[^乙]: 隐约的联系。'
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-lucent14-'))
  file = join(root, '琉璃的光.md')
  await writeFile(file, source)
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.optical-field')).toHaveAttribute(
    'data-field-version',
    'lucent-air-14'
  )
  await page.evaluate(() => document.fonts.ready)
  await mkdir('work/lucent14', { recursive: true })
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
test('all calendar, manuscript, habit and seed channels change real pixels', async () => {
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  const audit = await page.locator('.optical-field').evaluate((node) => {
    const gl = (node as HTMLCanvasElement).getContext('webgl')!,
      program = gl.getParameter(gl.CURRENT_PROGRAM)
    const names = [
      'climate',
      'readingState',
      'attention',
      'structure',
      'topology',
      'encounterSeed',
      'readingHabits',
      'navigationMemory'
    ]
    const base = [
      [0.4, 0.7, 0.2, -0.8],
      [0.2, 0.2, 0.4, 0.3],
      [0.6, 0.2, 0.4, 0.5],
      [0.4, 0.3, 0.2, 0.25],
      [0.3, 0.4, 0.2, -0.4],
      [0.13, 0.29, 0.57, 0.73],
      [0.5, 0.3, 0.2, 0.4],
      [0.2, 0.4, 0.3, 0.5]
    ]
    const locations = names.map((name) => gl.getUniformLocation(program, name))
    const time = gl.getUniformLocation(program, 'time')
    const sample = document.createElement('canvas')
    sample.width = 144
    sample.height = 96
    const context = sample.getContext('2d')!
    const reset = (): void => {
      base.forEach((v, i) => gl.uniform4fv(locations[i], v))
      gl.uniform1f(time, 25)
    }
    const read = (): Uint8ClampedArray => {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      context.drawImage(node as HTMLCanvasElement, 0, 0, 144, 96)
      return context.getImageData(0, 0, 144, 96).data
    }
    reset()
    const before = read(),
      effects: Array<{ name: string; channel: number; mean: number }> = []
    names.forEach((name, i) => {
      for (let channel = 0; channel < 4; channel++) {
        reset()
        const v = [...base[i]]
        v[channel] += 0.3
        gl.uniform4fv(locations[i], v)
        const pixels = read()
        effects.push({
          name,
          channel,
          mean: pixels.reduce((sum, x, k) => sum + Math.abs(x - before[k]), 0) / pixels.length
        })
      }
    })
    reset()
    return { effects, error: gl.getError() }
  })
  await writeFile('work/lucent14/32-controls.json', JSON.stringify(audit, null, 2))
  expect(audit.error).toBe(0)
  for (const e of audit.effects)
    expect(e.mean, e.name + '[' + e.channel + ']').toBeGreaterThan(0.005)
})
test('the off-screen light changes its silhouette and aperture over time without moving the page', async () => {
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  const paragraph = page.locator('.reader-scroll .section-body p').first(),
    box = await paragraph.boundingBox()
  const samples: Array<{ time: number; pixels: number[]; centroid: number; width: number }> = []
  for (const time of [0, 20, 55]) {
    const sample = await page.locator('.optical-field').evaluate((node, time) => {
      const gl = (node as HTMLCanvasElement).getContext('webgl')!,
        program = gl.getParameter(gl.CURRENT_PROGRAM)
      gl.uniform4fv(gl.getUniformLocation(program, 'encounterSeed'), [0.13, 0.29, 0.57, 0.73])
      gl.uniform1f(gl.getUniformLocation(program, 'time'), time)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const c = document.createElement('canvas')
      c.width = 120
      c.height = 80
      const ctx = c.getContext('2d')!
      ctx.drawImage(node as HTMLCanvasElement, 0, 0, 120, 80)
      const pixels = [...ctx.getImageData(0, 0, 120, 80).data]
      let mass = 0,
        x = 0,
        spread = 0
      for (let y = 8; y < 72; y++)
        for (let col = 40; col < 118; col++) {
          const at = (y * 120 + col) * 4
          const value = Math.max(0, (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 - 238)
          mass += value
          x += value * col
          spread += value * col * col
        }
      return {
        time,
        pixels,
        centroid: x / Math.max(1, mass),
        width: Math.sqrt(Math.max(0, spread / Math.max(1, mass) - (x / Math.max(1, mass)) ** 2))
      }
    }, time)
    samples.push(sample)
    await page.screenshot({ path: 'work/lucent14/圣光-' + time + '秒.png' })
  }
  const deltas = samples
    .slice(1)
    .map(
      (s) =>
        s.pixels.reduce((sum, p, i) => sum + Math.abs(p - samples[0].pixels[i]), 0) /
        s.pixels.length
    )
  await writeFile(
    'work/lucent14/beam-evolution.json',
    JSON.stringify(
      {
        samples: samples.map((s) => ({ time: s.time, centroid: s.centroid, width: s.width })),
        deltas
      },
      null,
      2
    )
  )
  expect(deltas.every((n) => n > 1)).toBe(true)
  expect(
    Math.max(...samples.map((s) => s.centroid)) - Math.min(...samples.map((s) => s.centroid))
  ).toBeGreaterThan(1)
  expect(await paragraph.boundingBox()).toEqual(box)
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('reopening changes all seeds; context recovery and effect modes keep a continuous loop', async () => {
  const seeds = (): Promise<number[]> =>
    page.locator('.optical-field').evaluate((node) => {
      const gl = (node as HTMLCanvasElement).getContext('webgl')!,
        p = gl.getParameter(gl.CURRENT_PROGRAM)
      return [...gl.getUniform(p, gl.getUniformLocation(p, 'encounterSeed')!)]
    })
  const before = await seeds()
  await page.getByRole('button', { name: '打开书籍', exact: true }).click()
  await expect.poll(async () => JSON.stringify(await seeds())).not.toBe(JSON.stringify(before))
  const phase = (): Promise<number> =>
    page.locator('.optical-field').evaluate((node) => {
      const gl = (node as HTMLCanvasElement).getContext('webgl')!,
        p = gl.getParameter(gl.CURRENT_PROGRAM)
      return gl.getUniform(p, gl.getUniformLocation(p, 'time')!)
    })
  const prior = await phase()
  await page.locator('.optical-field').evaluate((node) => {
    const ext = (node as HTMLCanvasElement).getContext('webgl')!.getExtension('WEBGL_lose_context')!
    ext.loseContext()
    setTimeout(() => ext.restoreContext(), 200)
  })
  await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
  await expect.poll(phase).toBeGreaterThan(prior + 0.5)
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  const held = await phase()
  await page.waitForTimeout(550)
  expect(await phase()).toBe(held)
  await page.getByRole('button', { name: '光影：静谧', exact: true }).click()
  await page.getByRole('button', { name: '光影：关闭', exact: true }).click()
  await expect.poll(phase).toBeGreaterThan(held + 0.5)
})
