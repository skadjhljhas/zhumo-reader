import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string
let errors: string[]
const source =
  Array.from(
    { length: 120 },
    (_, i) =>
      `# 第${i + 1}章：光在长文中\n\n` +
      `读者穿过文字与空白[^注${i}]，光仍然缓慢地流动。\n\n` +
      '这一段留在原处。滚动改变我们阅读的位置，背景的时间继续流逝。\n\n'.repeat(9)
  ).join('\n') +
  '\n' +
  Array.from(
    { length: 120 },
    (_, i) => `[^注${i}]: 这是第${i + 1}章的页边注释，原文不应改变。\n`
  ).join('\n')

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-scroll-motion-'))
  path = join(root, '连续滚动.md')
  await writeFile(path, source)
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await mkdir('work/scroll-motion', { recursive: true })
})

test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

interface FieldSample {
  time: number
  flow: number[]
  pixels: number[]
  glError: number
  lost: boolean
  hidden: boolean
  scrollTop: number
  scrollHeight: number
  mode: string | undefined
  ready: string | undefined
  at: number
}
type FieldAudit = Omit<FieldSample, 'pixels'> & { pixels: undefined }
async function sample(selector: string): Promise<FieldSample> {
  return page.locator(selector).evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const gl = canvas.getContext('webgl')!
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
    const time = gl.getUniformLocation(program, 'time')
    const navigation = gl.getUniformLocation(program, 'navigationFlow')
    if (!time || !navigation) throw Error('Missing live animation uniforms')
    const sample = document.createElement('canvas')
    sample.width = 100
    sample.height = 70
    const ctx = sample.getContext('2d')!
    ctx.drawImage(canvas, 0, 0, 100, 70)
    const reader = document.querySelector<HTMLElement>('.reader-scroll')!
    return {
      time: Number(gl.getUniform(program, time)),
      flow: [...gl.getUniform(program, navigation)] as number[],
      pixels: [...ctx.getImageData(0, 0, 100, 70).data],
      glError: gl.getError(),
      lost: gl.isContextLost(),
      hidden: document.hidden,
      scrollTop: reader.scrollTop,
      scrollHeight: reader.scrollHeight,
      mode: document.documentElement.dataset.optics,
      ready: canvas.dataset.ready,
      at: performance.now()
    }
  })
}

for (const [name, selector] of [
  ['琉璃', '.optical-field'],
  ['潮光', '.tidal-field']
]) {
  test(`${name} keeps advancing through slow frames after scrolling`, async () => {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: name }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.locator(selector)).toHaveAttribute('data-ready', 'webgl')
    // Gate actual browser callbacks without altering their real timestamps or GPU state.
    // A slow callback must advance the animation rather than be mistaken for suspension.
    await page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window)
      const cancel = window.cancelAnimationFrame.bind(window)
      const jobs = new Map<number, number>()
      let ticket = 1000000000
      window.requestAnimationFrame = (callback) => {
        const id = ++ticket
        const start = performance.now()
        const tick = (now: number): void => {
          if (!jobs.has(id)) return
          if (now - start < 360) jobs.set(id, request(tick))
          else {
            jobs.delete(id)
            callback(now)
          }
        }
        jobs.set(id, request(tick))
        return id
      }
      window.cancelAnimationFrame = (id) => {
        const native = jobs.get(id)
        if (native !== undefined) {
          cancel(native)
          jobs.delete(id)
        } else cancel(id)
      }
    })
    const box = await page.locator('.reader-scroll').boundingBox()
    if (!box) throw Error('Missing reading viewport')
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 2400)
      await page.waitForTimeout(120)
    }
    await page.mouse.move(30, 20)
    await page.waitForTimeout(600)
    const before = await sample(selector)
    await page.waitForTimeout(1800)
    const after = await sample(selector)
    await writeFile(
      `work/scroll-motion/${name}-slow.json`,
      JSON.stringify(
        {
          before: { ...before, pixels: undefined },
          after: { ...after, pixels: undefined },
          errors
        },
        null,
        2
      )
    )
    expect(
      after.time - before.time,
      'Visible slow frames must not freeze the animation clock'
    ).toBeGreaterThan(1)
    expect(errors).toEqual([])
    expect(after.glError).toBe(0)
    expect(after.lost).toBe(false)
  })
  test(`${name} keeps flowing after prolonged forward and reverse chapter scrolling`, async () => {
    test.setTimeout(65000)
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: name }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.locator(selector)).toHaveAttribute('data-ready', 'webgl')
    const metrics: Array<{
      label: string
      before: FieldAudit
      after: FieldAudit
      pixelChange: number
    }> = []
    for (const [label, direction] of [
      ['middle', 1],
      ['end', 1],
      ['return', -1]
    ] as const) {
      const box = await page.locator('.reader-scroll').boundingBox()
      if (!box) throw Error('Missing reading viewport')
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6)
      for (let i = 0; i < 14; i++) {
        await page.mouse.wheel(0, direction * 3500)
        await page.waitForTimeout(90)
      }
      await page.mouse.move(30, 20)
      await page.waitForTimeout(400)
      const before = await sample(selector)
      await page.waitForTimeout(1700)
      const after = await sample(selector)
      const pixelChange =
        after.pixels.reduce((sum, value, i) => sum + Math.abs(value - before.pixels[i]), 0) /
        after.pixels.length
      metrics.push({
        label,
        before: { ...before, pixels: undefined },
        after: { ...after, pixels: undefined },
        pixelChange
      })
      await writeFile(
        `work/scroll-motion/${name}.json`,
        JSON.stringify({ metrics, errors }, null, 2)
      )
      expect(after.glError).toBe(0)
      expect(after.lost).toBe(false)
      expect(after.hidden).toBe(false)
      expect(after.time - before.time, `${name} ${label}: animation time`).toBeGreaterThan(0.8)
      expect(pixelChange, `${name} ${label}: rendered pixels`).toBeGreaterThan(0.01)
      expect(errors).toEqual([])
    }
    await page.screenshot({ path: `work/scroll-motion/${name}-after.png` })
    expect(await readFile(path, 'utf8')).toBe(source)
  })
}
