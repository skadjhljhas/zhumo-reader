import { electron, readClipboard } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string
let errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-formulas-'))
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function openSource(source: string): Promise<void> {
  const path = join(root, '公式阅读.md')
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
}

const wideSum = Array.from({ length: 48 }, (_, i) => `a_{${i + 1}}`).join('+') + '=0'
const wideMatrix =
  String.raw`\begin{equation}\begin{bmatrix}` +
  Array.from({ length: 18 }, (_, row) =>
    Array.from({ length: 20 }, (_, col) => `x_{${row + 1},${col + 1}}`).join('&')
  ).join(String.raw`\\`) +
  String.raw`\end{bmatrix}\label{matrix}\end{equation}`

for (const [engine, formula] of [
  ['katex', wideSum],
  ['mathjax', wideMatrix]
]) {
  test(`wide ${engine} formulas remain fully reachable, fit, zoom and pan in the native inspector`, async () => {
    if (engine === 'mathjax') {
      await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
      await page.locator('.theme-choice').filter({ hasText: '星辰' }).click()
      await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    }
    await openSource(`# 公式的空间\n\n先读原式，再展开。\n\n\\[\n${formula}\n\\]\n`)
    const original = page.locator('.reader-scroll .zmu-math-block')
    await expect(original).toHaveAttribute('data-math-engine', engine)
    expect(await original.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    const bounds = await original.evaluate((el) => ({
      outer: el.getBoundingClientRect().left,
      inner: el.firstElementChild!.getBoundingClientRect().left
    }))
    expect(bounds.inner).toBeGreaterThanOrEqual(bounds.outer)
    await original.focus()
    await page.keyboard.press('Enter')
    const area = page.getByRole('region', { name: '放大的公式，可横向和纵向滚动' })
    const fits = async (): Promise<boolean> =>
      area.evaluate((el) => {
        const content = el.querySelector('.math-content')!.getBoundingClientRect(),
          rect = el.getBoundingClientRect()
        return (
          content.left >= rect.left &&
          content.right <= rect.right &&
          content.top >= rect.top &&
          content.bottom <= rect.bottom
        )
      })
    await expect.poll(fits).toBe(true)
    await page.getByRole('button', { name: '实际大小', exact: true }).click()
    await expect(page.locator('.math-scale')).toHaveText('100%')
    await area.evaluate((el) => {
      el.scrollLeft = 0
      el.scrollTop = 0
    })
    expect(
      await area.evaluate(
        (el) =>
          el.querySelector('.math-content')!.getBoundingClientRect().left >=
          el.getBoundingClientRect().left
      )
    ).toBe(true)
    await area.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
      el.scrollTop = el.scrollHeight
    })
    expect(
      await area.evaluate(
        (el) =>
          el.querySelector('.math-content')!.getBoundingClientRect().right <=
          el.getBoundingClientRect().right
      )
    ).toBe(true)
    await area.evaluate((el) => {
      el.scrollLeft = 200
      el.scrollTop = 0
    })
    await area.focus()
    const rect = (await area.boundingBox())!
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.keyboard.down('Space')
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width / 2 - 140, rect.y + rect.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    expect(await area.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300)
    await page.keyboard.press('+')
    await expect(page.locator('.math-scale')).toHaveText('120%')
    await page.keyboard.press('f')
    await expect.poll(fits).toBe(true)
    await page.getByRole('button', { name: '复制 LaTeX', exact: true }).click()
    await expect(page.locator('.math-copy-status')).toHaveText('LaTeX 已复制')
    expect((await readClipboard(app)).trim()).toBe(formula)
    await mkdir('work/screens', { recursive: true })
    await page.screenshot({ path: `work/screens/formula-workspace-${engine}.png`, scale: 'css' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
    await expect.poll(fits).toBe(true)
    await expect(page.getByRole('button', { name: '适合窗口', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('button', { name: '复制 LaTeX', exact: true })).toBeInViewport({
      ratio: 1
    })
    await page.screenshot({ path: `work/screens/formula-small-${engine}.png`, scale: 'css' })
    await page.keyboard.press('Escape')
    await expect(original).toBeFocused()
    expect(errors).toEqual([])
  })
}

test('equation references land in distant sections and inside long notes in reading and editing', async () => {
  const sections = Array.from(
    { length: 30 },
    (_, i) => `# 中间章节 ${i}\n\n${'把推导放回论述中。'.repeat(150)}\n`
  ).join('\n')
  const refs = Array.from({ length: 100 }, (_, i) => `[^n${i}]`).join(' ')
  const notes = Array.from({ length: 100 }, (_, i) => `[^n${i}]: 另一条注释 ${i}。`).join('\n\n')
  const longNote = Array.from(
    { length: 32 },
    (_, i) => `    解释的第 ${i + 1} 段。${'每一步需要理由。'.repeat(20)}`
  ).join('\n\n')
  await openSource(
    String.raw`# 从引用开始
先见 $\eqref{far}$；再见 $\eqref{detail}$。

` +
      refs +
      ' [^math]\n\n' +
      sections +
      String.raw`
# 推导终点
\[\begin{equation}E=mc^2\label{far}\end{equation}\]

` +
      notes +
      '\n\n[^math]: 推导的来路。\n\n' +
      longNote +
      String.raw`

    \[\begin{equation}a=b\label{detail}\end{equation}\]
`
  )
  const farLink = page.locator('.reader-scroll a[href="#mjx-eqn%3Afar"]')
  await expect(farLink).toBeVisible()
  await farLink.click()
  await expect(page.locator('.reader-scroll [id="mjx-eqn:far"]')).toBeInViewport()
  await expect(page.locator('.math-dialog')).not.toBeVisible()
  await page.getByRole('button', { name: '从引用开始', exact: true }).click()
  await page.locator('.reader-scroll a[href="#mjx-eqn%3Adetail"]').click()
  await expect(page.locator('.notes-scroll [id="mjx-eqn:detail"]')).toBeInViewport()
  expect(await page.locator('.note-card').count()).toBeLessThan(25)
  await page.locator('.notes-scroll').focus()
  await page.keyboard.press('Control+Home')
  await expect(page.locator('.notes-scroll .note-mark').first()).toHaveText('n0')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  // Editing now starts at the currently read annotation. Navigate explicitly
  // back to the beginning before following the formula reference in the body.
  await expect(page.locator('.preview-note').filter({ hasText: '另一条注释 0。' })).toBeInViewport()
  await page.locator('.preview-scroll').focus()
  await page.keyboard.press('Control+Home')
  await page.locator('.preview-scroll a[href="#mjx-eqn%3Adetail"]').click()
  await expect(page.locator('.preview-scroll [id="mjx-eqn:detail"]')).toBeInViewport()
  await expect(page.locator('.cm-editor')).toBeVisible()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await page.locator('.preview-scroll').focus()
  await page.keyboard.press('Control+Home')
  const previewRef = page
    .locator('.preview-scroll .zmu-math')
    .filter({ has: page.locator('a[href="#mjx-eqn%3Afar"]') })
  await previewRef.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.math-dialog')).toBeVisible()
  await page.locator('.math-content a[href="#mjx-eqn%3Afar"]').click()
  await expect(page.locator('.preview-scroll [id="mjx-eqn:far"]')).toBeInViewport()
  await expect(page.locator('.cm-editor')).toBeVisible()
  expect(errors).toEqual([])
})

test('search lands on the matching paragraph of a long annotation', async () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `    第 ${i} 段。${'继续解释这个问题。'.repeat(20)}`
  ).join('\n\n')
  await openSource(
    '# 注释检索\n\n正文[^长注]。\n\n[^长注]: 旁注的开头。\n\n' +
      paragraphs +
      '\n\n    唯一的检索落点在这里。'
  )
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('唯一的检索落点')
  await page.locator('.search-result').click()
  await expect(page.locator('.note-card p').filter({ hasText: '唯一的检索落点' })).toBeInViewport()
  await expect(page.locator('.note-card p').first()).not.toBeInViewport()
  expect(errors).toEqual([])
})
