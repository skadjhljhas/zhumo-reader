import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
let app: ElectronApplication, page: Page, root: string, path: string
const source =
  '# 回声的时间\n\n海水映着月光，日光慢慢抵达文字。\n\n化学反应 $\\ce{2H2 + O2 -> 2H2O}$，以及真正的变量 $X+1$。\n\n' +
  '在文字和空白之间，仍有可以停留的地方。\n\n'.repeat(70)
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-echo2-'))
  path = join(root, '回声的时间.md')
  await writeFile(path, source)
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await mkdir('work/echo-v2', { recursive: true })
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('button', { name: '回声：停留的字句', exact: true })).toBeEnabled()
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
async function word(text: string): Promise<void> {
  const p = page.locator('.reader-scroll .section-body p').filter({ hasText: text }).first()
  await p.scrollIntoViewIfNeeded()
  const point = await p.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = node.textContent!.indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const r = range.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    throw Error('Missing word')
  }, text)
  await page.mouse.move(point.x, point.y)
}
test('silent echo waits three seconds, reaches sunlight at fifteen and shares places with Lucent', async () => {
  test.setTimeout(65000)
  await theme('潮光')
  await word('月光')
  await page.waitForTimeout(2600)
  expect(await page.evaluate(() => CSS.highlights.has('reading-echo-current'))).toBe(false)
  await expect(page.locator('.echo-current-word')).toHaveCount(0)
  await expect(page.locator('.tidal-echo-action,.tidal-trace')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has('reading-echo-current')), { timeout: 4000 })
    .toBe(true)
  await expect(page.locator('.echo-current-word')).toHaveText('月光')
  await expect
    .poll(
      async () => Number(await page.locator('.reading-echo-light').getAttribute('data-strength')),
      { timeout: 18000 }
    )
    .toBe(1)
  const warm = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--echo-current-ink')
  )
  // Sunlight ink at the 15 s peak: the tide keeps its letters bright over the sea.
  expect(warm.replace(/\s/g, '')).toBe('rgb(255,233,194)')
  await mkdir('work/echo-v2', { recursive: true })
  await page.screenshot({ path: 'work/echo-v2/潮光-15秒日光.png' })
  await page.mouse.move(60, 20)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  // The compact field draws light, not DOM stars; the count travels as data.
  await expect(page.locator('.tidal-memory-rail .tidal-memory-chart')).toHaveAttribute(
    'data-count',
    '1'
  )
  await theme('琉璃')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await word('月光')
  await page.waitForTimeout(3600)
  expect(await page.evaluate(() => CSS.highlights.has('reading-echo-current'))).toBe(true)
  const cool = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--echo-current-ink')
  )
  expect(cool).not.toBe(warm)
  await page.screenshot({ path: 'work/echo-v2/琉璃-折射回声.png' })
  await page.mouse.move(60, 20)
  await page.getByRole('button', { name: '展开回声', exact: true }).click()
  await expect(page.locator('.tidal-place-context')).toContainText('月光')
  await page.getByRole('button', { name: '回到这句', exact: true }).click()
  await expect(page.locator('.tidal-memory-dialog')).not.toBeVisible()
  expect(await readFile(path, 'utf8')).toBe(source)
})
test('chemistry layout phantoms remain invisible and mathematical X stays real', async () => {
  const chemistry = page
    .locator('.zmu-math')
    .filter({ has: page.locator('[style*="color:transparent"]') })
    .first()
  await chemistry.scrollIntoViewIfNeeded()
  await page.locator('.reader-scroll .section-body p').filter({ hasText: '化学反应' }).hover()
  const phantoms = await chemistry.locator('[style*="color:transparent"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent,
      visibility: getComputedStyle(node).visibility,
      shadow: getComputedStyle(node).textShadow
    }))
  )
  expect(phantoms.length).toBeGreaterThan(0)
  expect(phantoms.every((node) => node.visibility === 'hidden' && node.shadow === 'none')).toBe(
    true
  )
  const real = page
    .locator('.zmu-math[data-math-source="X+1"] .mathnormal')
    .filter({ hasText: 'X' })
  await expect(real).toHaveCSS('visibility', 'visible')
  await real.hover()
  await page.waitForTimeout(3500)
  expect(await page.evaluate(() => CSS.highlights.has('reading-echo-current'))).toBe(false)
  await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'control')
  await expect(real).toHaveCSS('cursor', 'none')
  await page.screenshot({ path: 'work/echo-v2/化学公式-无X虚影.png' })
})
test('scroll habits alter the light field without translating its canvas and reading controls keep their cursor', async () => {
  for (const name of ['琉璃', '潮光']) {
    await theme(name)
    const canvas = page.locator(name === '琉璃' ? '.optical-field' : '.tidal-field')
    await expect(canvas).toHaveAttribute('data-ready', 'webgl')
    const read = (): Promise<number[]> =>
      canvas.evaluate((node) => {
        const gl = (node as HTMLCanvasElement).getContext('webgl')!,
          p = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram,
          location = gl.getUniformLocation(p, 'navigationFlow')
        if (!location) throw Error('Missing scroll input')
        return [...gl.getUniform(p, location)]
      })
    const before = await read()
    const box = await page.locator('.reader-scroll').boundingBox()
    if (!box) throw Error('No reader')
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6)
    await page.mouse.wheel(0, 420)
    await page.waitForTimeout(250)
    await page.mouse.wheel(0, -230)
    await page.waitForTimeout(350)
    const after = await read()
    expect(after[1]).toBeGreaterThan(0)
    expect(after[2]).toBeGreaterThan(0)
    expect(after).not.toEqual(before)
    await expect(canvas).toHaveCSS('transform', 'none')
    await page.getByRole('button', { name: '阅读设置', exact: true }).hover()
    await expect(page.locator('html')).toHaveAttribute(
      name === '琉璃' ? 'data-cursor-field' : 'data-tide-cursor',
      'control'
    )
    await expect(page.getByRole('button', { name: '阅读设置', exact: true })).toHaveCSS(
      'cursor',
      'none'
    )
  }
  expect(await readFile(path, 'utf8')).toBe(source)
})
