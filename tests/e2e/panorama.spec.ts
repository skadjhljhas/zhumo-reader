import { READING_THEMES } from './theme-catalog'
import { electron, metricPath, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-panorama-'))
  path = join(root, '全书长卷.md')
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
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
async function open(source: string): Promise<void> {
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}
async function unfold(): Promise<void> {
  await page.getByRole('button', { name: '全书长卷', exact: true }).click()
  await expect(page.locator('.panorama-dialog')).toBeVisible()
}
async function pick(term: string, at = 0): Promise<void> {
  await page.getByRole('combobox', { name: '查找长卷章节' }).fill(term)
  await page.locator('.panorama-result').nth(at).click()
  await expect(page.locator('.panorama-picker')).toHaveCount(0)
}

test('a delayed native close event cannot cancel a newly opened annotation atlas', async () => {
  await open(await readFile('docs/panorama-reading-example.md', 'utf8'))
  await unfold()
  await pick('七 · 旁注的旁边')
  const opener = page.getByRole('button', { name: '从长卷查看注释 退让', exact: true })
  await opener.click()
  await expect(page.locator('.atlas-dialog[open]')).toBeVisible()
  await page.evaluate(() => {
    const old = document.querySelector('.atlas-dialog')!
    function delay(event: Event): void {
      if (event.target !== old) return
      document.removeEventListener('close', delay, true)
      event.stopImmediatePropagation()
      setTimeout(() => old.dispatchEvent(new Event('close')), 250)
    }
    document.addEventListener('close', delay, true)
  })
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  await page
    .locator('.panorama-detail')
    .getByRole('button', { name: '阅读注释 退让', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.atlas-dialog[open]')).toBeVisible({ timeout: 1200 })
  // The queued event from the old native dialog must not close this instance later.
  await page.waitForTimeout(300)
  await expect(page.locator('.atlas-dialog[open]')).toBeVisible()
  await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '退让'
  )
  expect(errors).toEqual([])
})

test('exploration preserves the current page and bytes, then lands at the exact repeated heading', async () => {
  const source =
    '\uFEFF# 来处\r\n\r\n原先的阅读位置。\r\n\r\n## 同名\r\n\r\n第一处。\r\n\r\n' +
    Array.from({ length: 180 }, (_, i) => `这一页${i}。${'慢慢读过中间的文字。'.repeat(8)}`).join(
      '\r\n\r\n'
    ) +
    '\r\n\r\n## 同名\r\n\r\n第二处的独有句子。\r\n'
  await open(source)
  const scroll = page.locator('.reader-scroll')
  const before = await scroll.evaluate((el) => el.scrollTop)
  await unfold()
  await pick('同名', 1)
  await expect(page.locator('.panorama-excerpt')).toContainText('第二处的独有句子')
  await expect(page.locator('.panorama-excerpt')).not.toContainText('第一处')
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(before)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '全书长卷', exact: true })).toBeFocused()
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(before)
  await unfold()
  await pick('同名', 1)
  await page.getByRole('button', { name: '从此处阅读', exact: true }).click()
  await expect(page.locator('.panorama-dialog')).toHaveCount(0)
  await expect(page.locator('.reader-scroll [data-toc-id="toc-3"]')).toBeInViewport()
  await expect(page.locator('.toc-item.is-current')).toHaveText('同名')
  expect(await readFile(path, 'utf8')).toBe(source)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the full 1500-heading book is searchable with bounded sheets, results and excerpt DOM', async () => {
  const source =
    '# 远处\n\n' +
    Array.from(
      { length: 1500 },
      (_, i) => `## 章节${String(i + 1).padStart(4, '0')}\n\n第${i + 1}处的原文。`
    ).join('\n\n')
  await open(source)
  const started = Date.now()
  await unfold()
  const openedMs = Date.now() - started
  await expect(page.locator('.panorama-head-actions')).toContainText('1,501 处篇章')
  await page.getByRole('combobox', { name: '查找长卷章节' }).focus()
  await expect(page.locator('.panorama-result')).toHaveCount(12)
  await page.getByRole('button', { name: '下一页章节结果' }).click()
  await expect(page.locator('.panorama-picker-caption')).toContainText('13–24')
  await pick('章节1500')
  await expect(page.locator('.panorama-excerpt')).toContainText('第1500处的原文')
  expect(await page.locator('.panorama-sheet').count()).toBeLessThanOrEqual(7)
  expect(await page.locator('.panorama-dialog *').count()).toBeLessThan(360)
  await page.locator('.panorama-stage').press('Home')
  await expect(page.locator('.panorama-detail > h3')).toHaveText('远处')
  await page.locator('.panorama-stage').press('End')
  await expect(page.locator('.panorama-detail > h3')).toHaveText('章节1500')
  await page.getByRole('slider', { name: '全书篇章位置' }).focus()
  await page.keyboard.press('Home')
  await expect(page.locator('.panorama-detail > h3')).toHaveText('远处')
  await expect(page.locator('.panorama-landscape-head')).not.toContainText('正在展开')
  await mkdir('work', { recursive: true })
  await writeFile(
    metricPath('panorama-performance.json'),
    JSON.stringify(
      {
        version: JSON.parse(await readFile('package.json', 'utf8')).version,
        executionMode,
        sourceChars: source.length,
        headings: 1501,
        openedMs,
        mountedSheets: await page.locator('.panorama-sheet').count(),
        dialogElements: await page.locator('.panorama-dialog *').count()
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
})

test('annotation exploration returns to the same long-scroll preview and commits sidebar exits', async () => {
  await open(await readFile('docs/panorama-reading-example.md', 'utf8'))
  await unfold()
  await pick('七 · 旁注的旁边')
  const detail = page.locator('.panorama-detail')
  const button = page.getByRole('button', { name: '从长卷查看注释 退让', exact: true })
  await button.scrollIntoViewIfNeeded()
  const offset = await detail.evaluate((el) => el.scrollTop)
  await button.click()
  await expect(page.locator('.atlas-dialog')).toBeVisible()
  await page.getByRole('button', { name: '进入子注 范围', exact: true }).click()
  await page.getByRole('button', { name: '进入子注 证据', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(button).toBeFocused()
  expect(await detail.evaluate((el) => el.scrollTop)).toBe(offset)
  await expect(page.locator('.panorama-detail > h3')).toHaveText('七 · 旁注的旁边')
  await detail.getByRole('button', { name: '阅读注释 退让', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
  await expect(page.locator('.panorama-dialog,.atlas-dialog')).toHaveCount(0)
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '退让'
  )
  expect(errors).toEqual([])
})

test('formula inspection and internal links leave no duplicate IDs or hidden destination', async () => {
  await open(String.raw`# 开端

\[\begin{equation}a=b\label{origin}\end{equation}\]

## 推导

参见 $\eqref{origin}$。

\[\begin{equation}x=y\label{later}\end{equation}\]

[回到开端](#开端)
`)
  await unfold()
  await pick('推导')
  expect(await page.locator('[id="mjx-eqn:later"]').count()).toBe(1)
  const formula = page.locator('.panorama-excerpt .zmu-math-block')
  await formula.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.math-dialog')).toBeVisible()
  await expect(page.locator('.math-eyebrow')).toContainText('推导')
  await page.keyboard.press('Escape')
  await expect(formula).toBeFocused()
  await page.locator('.panorama-excerpt a[href="#mjx-eqn%3Aorigin"]').click()
  await expect(page.locator('.panorama-dialog')).toHaveCount(0)
  await expect(page.locator('.reader-scroll [id="mjx-eqn:origin"]')).toBeInViewport()
  await unfold()
  await pick('推导')
  await page.locator('.panorama-excerpt').getByRole('link', { name: '回到开端' }).click()
  await expect(page.locator('.panorama-dialog')).toHaveCount(0)
  await expect(page.locator('.document-overture h1')).toBeInViewport()
  await expect.poll(() => page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(0)
  expect(errors).toEqual([])
})

test('small-window theme compositions retain clear controls, a complete selected page and quiet motion', async () => {
  await open(await readFile('docs/panorama-reading-example.md', 'utf8'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await mkdir('work/screens', { recursive: true })
  for (const [name, id] of READING_THEMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: name }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await unfold()
    await pick('四 · 此刻的距离')
    await expect(page.getByRole('button', { name: '从此处阅读', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('slider', { name: '全书篇章位置' })).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() =>
        page.locator('.panorama-sheet.is-selected').evaluate((el) => {
          const rect = el.getBoundingClientRect(),
            bounds = el.closest('.panorama-stage')!.getBoundingClientRect()
          return (
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.left >= bounds.left &&
            rect.right <= bounds.right
          )
        })
      )
      .toBe(true)
    expect(
      await page
        .locator('.panorama-dialog')
        .evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)
    ).toBe(true)
    await page.getByRole('combobox', { name: '查找长卷章节' }).focus()
    await expect(page.getByRole('button', { name: '下一页章节结果' })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.panorama-picker')).toHaveCount(0)
    await page.waitForTimeout(800)
    await page.screenshot({ path: `work/screens/panorama-small-${id}.png`, scale: 'css' })
    await page.keyboard.press('Escape')
  }
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page.locator('.theme-choice').filter({ hasText: '琉璃' }).click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await unfold()
  expect(
    await page.locator('.panorama-aura').evaluate((el) => getComputedStyle(el).animationName)
  ).toBe('none')
  expect(
    await page
      .locator('.panorama-sheet')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration)
  ).toBe('0s')
  await page.locator('.panorama-stage').hover()
  expect(
    await page
      .locator('.panorama-stage')
      .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--tilt'))
  ).toBe('')
  expect(errors).toEqual([])
})

test('a long unheaded text stays one chapter with a bounded faithful opening excerpt', async () => {
  const source = Array.from(
    { length: 400 },
    (_, i) => `第${i + 1}段。${'字与字之间，仍有可以停留的距离。'.repeat(18)}`
  ).join('\n\n')
  await open(source)
  await unfold()
  await expect(page.locator('.panorama-head-actions')).toContainText('1 处篇章')
  await expect(page.locator('.panorama-excerpt p')).toHaveCount(7)
  await expect(page.locator('.panorama-excerpt')).toContainText('第1段')
  await expect(page.locator('.panorama-excerpt')).not.toContainText('第8段')
  await expect(page.locator('.panorama-excerpt-end')).toBeVisible()
  await expect(page.getByRole('button', { name: '长卷下一篇章' })).toBeDisabled()
  await expect(page.locator('.panorama-landscape-head')).not.toContainText('正在展开')
  await expect(page.locator('.panorama-stats')).toContainText(
    `${Array.from(source.replace(/\s/g, '')).length.toLocaleString('zh-CN')} 正文字符`
  )
  expect(errors).toEqual([])
})
