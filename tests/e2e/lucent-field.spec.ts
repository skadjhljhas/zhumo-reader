import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
let app: ElectronApplication, page: Page, root: string, path: string
const source =
  '# 光在阅读中\n\n我们在一句话里停留[^光]，它伸向另一段理解。\n\n' +
  '文字之间也有光。\n\n'.repeat(16) +
  '[^光]: 注释让一段文字向外展开。'
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-living-light-'))
  path = join(root, '光在阅读中.md')
  await writeFile(path, source)
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function theme(name: string): Promise<void> {
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page
    .locator('.theme-choice')
    .filter({ has: page.locator('strong', { hasText: name }) })
    .click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
}
test('the live field flows and note attention rises and lingers rather than flashing', async () => {
  const pixels = (): Promise<number[]> =>
    page.locator('.optical-field').evaluate((node) => {
      const sample = document.createElement('canvas')
      sample.width = 100
      sample.height = 70
      const ctx = sample.getContext('2d')!
      ctx.drawImage(node as HTMLCanvasElement, 0, 0, 100, 70)
      return [...ctx.getImageData(0, 0, 100, 70).data]
    })
  const before = await pixels()
  await page.waitForTimeout(2200)
  const after = await pixels()
  const mean = after.reduce((sum, n, i) => sum + Math.abs(n - before[i]), 0) / after.length
  expect(mean).toBeGreaterThan(0.04)
  expect(mean).toBeLessThan(5)
  const mark = page.locator('.reader-scroll .zmu-ref-mark').first()
  await mark.hover()
  await expect
    .poll(async () => Number(await page.locator('.optical-field').getAttribute('data-field-hover')))
    .toBeGreaterThan(0.35)
  const attention = (): Promise<number> =>
    page.locator('.optical-field').evaluate((node) => {
      const gl = (node as HTMLCanvasElement).getContext('webgl')!,
        program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
      const location = gl.getUniformLocation(program, 'attention')
      if (!location) throw new Error('Missing live attention uniform')
      return gl.getUniform(program, location)[0]
    })
  const peak = await attention()
  await page.mouse.move(60, 20)
  await page.waitForTimeout(700)
  const released = await attention()
  expect(released).toBeGreaterThan(0)
  expect(released).toBeLessThan(peak)
  expect(await readFile(path, 'utf8')).toBe(source)
  await mkdir('work/lucent-living', { recursive: true })
  await page.screenshot({ path: 'work/lucent-living/琉璃-流光阅读.png' })
  await writeFile(
    'work/lucent-living/live.json',
    JSON.stringify(
      { meanFrameChangeAfter2_2s: mean, hoverPeak: peak, hoverAfterRelease: released },
      null,
      2
    )
  )
})
test('the reading clock survives theme switches and pauses in editing', async () => {
  await expect
    .poll(async () =>
      Number(await page.locator('.optical-field').getAttribute('data-reading-seconds'))
    )
    .toBeGreaterThan(0.5)
  const before = Number(await page.locator('.optical-field').getAttribute('data-reading-seconds'))
  await theme('潮光')
  await page.waitForTimeout(1000)
  await theme('琉璃')
  await expect
    .poll(async () =>
      Number(await page.locator('.optical-field').getAttribute('data-reading-seconds'))
    )
    .toBeGreaterThan(before + 0.8)
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()
  await page.waitForTimeout(600)
  const held = Number(await page.locator('.optical-field').getAttribute('data-reading-seconds'))
  await page.waitForTimeout(1000)
  expect(Number(await page.locator('.optical-field').getAttribute('data-reading-seconds'))).toBe(
    held
  )
})
test('calendar, reading structure and hover uniforms all change actual GPU pixels', async () => {
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-optics', 'quiet')
  const results = await page.locator('.optical-field').evaluate((node) => {
    const canvas = node as HTMLCanvasElement,
      gl = canvas.getContext('webgl')!,
      program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
    const names = ['climate', 'readingState', 'attention', 'structure']
    const loc = Object.fromEntries(
      [...names, 'time'].map((name) => [name, gl.getUniformLocation(program, name)])
    )
    const baseline = [
      [0.4, 0.7, 0.2, -0.8],
      [0.2, 0.2, 0.4, 0.3],
      [0.6, 0.2, 0.4, 0.5],
      [0.4, 0.3, 0.2, 0.25]
    ]
    const sample = document.createElement('canvas')
    sample.width = 120
    sample.height = 80
    const ctx = sample.getContext('2d')!
    const reset = (): void => {
      names.forEach((name, i) => gl.uniform4fv(loc[name], baseline[i]))
      gl.uniform1f(loc.time, 25)
    }
    const pixels = (): Uint8ClampedArray => {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      ctx.drawImage(canvas, 0, 0, 120, 80)
      return ctx.getImageData(0, 0, 120, 80).data
    }
    reset()
    const before = pixels(),
      changes: Array<{ name: string; index: number; mean: number }> = []
    names.forEach((name, i) => {
      for (let k = 0; k < 4; k++) {
        reset()
        const v = [...baseline[i]]
        v[k] += 0.3
        gl.uniform4fv(loc[name], v)
        const after = pixels()
        let sum = 0
        for (let n = 0; n < after.length; n++) sum += Math.abs(after[n] - before[n])
        changes.push({ name, index: k, mean: sum / after.length })
      }
    })
    reset()
    return { changes, error: gl.getError() }
  })
  expect(results.error).toBe(0)
  for (const change of results.changes)
    expect(change.mean, `${change.name}[${change.index}]`).toBeGreaterThan(0.015)
  await mkdir('work/lucent-living', { recursive: true })
  await writeFile('work/lucent-living/gpu-inputs.json', JSON.stringify(results, null, 2))
})
