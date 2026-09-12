import { READING_THEME_NAMES } from './theme-catalog'
import { electron, metricPath, readClipboard, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-search-'))
  path = join(root, '文句.md')
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
  expect(errors).toEqual([])
})
async function open(source: string): Promise<void> {
  await writeFile(path, source)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}
async function search(term: string, count: number): Promise<void> {
  await page.keyboard.press('Control+f')
  await expect(page.locator('.search-dialog')).toBeVisible()
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill(term)
  await expect(page.locator('.search-count strong')).toHaveText(count.toLocaleString() + ' 处')
  await expect(page.locator('.search-body')).toHaveAttribute('aria-busy', 'false')
}
async function highlightInViewport(container: string, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ container, text }) => {
          const ranges = [...(CSS.highlights.get('zhumo-search-match') ?? [])] as Range[]
          const root = document.querySelector(container)!.getBoundingClientRect()
          if (!ranges.length || ranges.map((range) => range.toString()).join('') !== text)
            return false
          return ranges.every((range) => {
            const r = range.getBoundingClientRect()
            return (
              r.top >= root.top &&
              r.bottom <= root.bottom &&
              r.left >= root.left &&
              r.right <= root.right
            )
          })
        },
        { container, text }
      )
    )
    .toBe(true)
}

test('all occurrences beyond 100 results remain reachable with separate body and note scopes', async () => {
  const source =
    '# 一封札记\n\n门槛，**门槛**，门槛。[^parent]\n\n' +
    Array.from({ length: 131 }, (_, i) => '第' + (i + 1) + '段 门槛进入，门槛改变。').join('\n\n') +
    '\n\n[^parent]: 门槛有两面，门槛还引出另一问。[^child]\n\n[^child]: 门槛之后。'
  await open(source)
  await search('门槛', 268)
  await expect(page.locator('.search-result')).toHaveCount(24)
  await page.getByRole('button', { name: '最后一页结果', exact: true }).click()
  await expect(page.locator('.search-result')).toHaveCount(4)
  await expect(page.locator('.search-result').last()).toContainText('旁注 child')
  await page
    .getByRole('group', { name: '检索范围' })
    .getByRole('button', { name: '正文', exact: true })
    .click()
  await expect(page.locator('.search-count strong')).toHaveText('265 处')
  await page.getByRole('button', { name: '最后一页结果', exact: true }).click()
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  await highlightInViewport('.reader-scroll', '门槛')
  await expect(page.locator('.search-landed')).toContainText('第131段')
  expect(await readFile(path, 'utf8')).toBe(source)
})

test('a later match in a very long formatted paragraph has its own context and exact visible landing', async () => {
  const source =
    '# 长段\n\n门槛在起点。' +
    '沿着这条长路，文字仍在继续。'.repeat(650) +
    '门**槛**在远处。\n\n结束。'
  await open(source)
  const reader = page.locator('.reader-scroll')
  const before = await reader.evaluate((el) => el.scrollTop)
  const html = await page.locator('.section-body').first().innerHTML()
  await search('门槛', 2)
  await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
  await expect(page.locator('.search-context-text')).toContainText('在远处')
  await expect(page.locator('.search-excerpt-notice')).toBeVisible()
  expect((await page.locator('.search-context-text').textContent())!.length).toBeLessThan(2000)
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(before)
  await page.getByRole('button', { name: '复制完整段落', exact: true }).click()
  expect((await readClipboard(app)).endsWith('门槛在远处。')).toBe(true)
  await page.getByRole('button', { name: '从此处阅读', exact: true }).click()
  await highlightInViewport('.reader-scroll', '门槛')
  expect(await reader.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)
  expect(
    (await page.locator('.section-body').first().innerHTML()).replace(/ class="search-landed"/g, '')
  ).toBe(html)
})

test('a deep annotation opens its hidden sidebar at a later occurrence without moving the body', async () => {
  const source =
    '# 支线\n\n正文[^parent]\n\n[^parent]: 去往[^child]。\n\n[^child]: 转向开始。' +
    '沿着旁注，继续追问。'.repeat(450) +
    '转向结束。'
  await open(source)
  await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
  const bodyTop = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await search('转向', 2)
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).press('ArrowDown')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).press('Enter')
  await expect(page.locator('.notes-sidebar')).toBeVisible()
  await highlightInViewport('.notes-scroll', '转向')
  expect(await page.locator('.notes-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(1000)
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(bodyTop)
})

test('nested list parent text, table cells and literal formula/code source are indexed once and locate correctly', async () => {
  const fence = '\u0060\u0060\u0060'
  const source =
    '# 结构\n\n- 门槛在父项\n  - 门槛在子项\n    - 门槛在孙项\n\n' +
    '| 表头 |\n| --- |\n| 门槛在表格 |\n\n' +
    '$\\alpha + 1$\n\n$$\n\\alpha^2\n$$\n\n' +
    fence +
    '\na.*[b]\n' +
    fence
  await open(source)
  await search('门槛', 4)
  await page.locator('.search-result').first().click()
  await highlightInViewport('.reader-scroll', '门槛')
  await search('门槛', 4)
  await page.locator('.search-result').nth(2).click()
  await highlightInViewport('.reader-scroll', '门槛')
  await expect(page.locator('.search-landed').last()).toContainText('孙项')
  await search('\\alpha', 2)
  await page.locator('.search-result').last().click()
  await expect(page.locator('.search-source-landed')).toHaveAttribute(
    'data-math-source',
    /^\\alpha\^2\s*$/
  )
  await search('a.*[b]', 1)
  await page.locator('.search-result').click()
  await highlightInViewport('.reader-scroll', 'a.*[b]')
})

test('Unicode case matching, composition Enter, and delayed native close events preserve search state', async () => {
  await open('# 字形\n\nİ X 在此，x 在后来。')
  await search('x', 2)
  await page.getByRole('checkbox', { name: '区分大小写' }).check()
  await expect(page.locator('.search-count strong')).toHaveText('1 处')
  await page.getByRole('checkbox', { name: '区分大小写' }).uncheck()
  await expect(page.locator('.search-count strong')).toHaveText('2 处')
  await page
    .getByRole('textbox', { name: '搜索正文与旁注' })
    .evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      )
    )
  await expect(page.locator('.search-dialog')).toBeVisible()
  await page.evaluate(() => {
    function delay(event: Event): void {
      if (!(event.target instanceof HTMLDialogElement) || !event.target.matches('.search-dialog'))
        return
      event.stopImmediatePropagation()
      document.removeEventListener('close', delay, true)
      const old = event.target
      setTimeout(() => old.dispatchEvent(new Event('close')), 250)
    }
    document.addEventListener('close', delay, true)
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+f')
  await page.waitForTimeout(350)
  await expect(page.locator('.search-dialog')).toBeVisible()
  await page.locator('.search-result').first().click()
  await highlightInViewport('.reader-scroll', 'X')
})

test('all nine themes keep context and controls reachable at a small window size', async () => {
  await open(
    '# 一次重读\n\n门槛最初是分界。[^a]\n\n## 后来\n\n门槛也容许经过。\n\n[^a]: 门槛的另一面，属于正在到来的读者。'
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  const themes = READING_THEME_NAMES
  await mkdir('work/screens', { recursive: true })
  for (const theme of themes) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: theme }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await search('门槛', 3)
    await expect(page.getByRole('button', { name: '从此处阅读', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('button', { name: '下一页结果', exact: true })).toBeInViewport({
      ratio: 1
    })
    const size = await page.locator('.search-context-scroll').evaluate((el) => ({
      height: el.clientHeight,
      width: el.clientWidth,
      overflows: el.scrollWidth > el.clientWidth + 1
    }))
    expect(size.height).toBeGreaterThan(100)
    expect(size.overflows).toBe(false)
    if (theme === '琉璃' || theme === '星辰' || theme === '潮光')
      await page.screenshot({ path: 'work/screens/search-' + theme + '-960.png', scale: 'css' })
    await page.keyboard.press('Escape')
  }
})

test('saving an edited manuscript rebuilds search before using an outdated paragraph address', async () => {
  const original = '# 初稿\n\n旧入口与门槛。'
  await open(original)
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText('# 新序\n\n新的门槛。\n\n')
  await page.getByRole('button', { name: '全文检索', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('门槛')
  await expect(page.locator('.search-count strong')).toHaveText('1 处')
  await page.locator('.search-result').click()
  await expect(page.locator('.leave-dialog')).toBeVisible()
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await expect(page.locator('.search-dialog')).toBeVisible()
  await expect(page.locator('.search-count strong')).toHaveText('2 处')
  await expect(page.locator('.search-notice')).toContainText('文稿已更新')
  await page.locator('.search-result').last().click()
  await highlightInViewport('.reader-scroll', '门槛')
  await expect(page.locator('.search-landed')).toContainText('旧入口')
  expect(await readFile(path, 'utf8')).toBe('# 新序\n\n新的门槛。\n\n' + original)
})

test('annotation reference badges do not become extra prose or false search occurrences', async () => {
  await open('# 原句\n\n正文门[^门槛]槛余句。\n\n[^门槛]: 独立旁注。')
  await search('门槛', 1)
  await expect(page.locator('.search-context-text')).toHaveText('正文门槛余句。')
  await page.getByRole('button', { name: '复制完整段落', exact: true }).click()
  expect(await readClipboard(app)).toBe('正文门槛余句。')
  await page.getByRole('button', { name: '从此处阅读', exact: true }).click()
  await highlightInViewport('.reader-scroll', '门槛')
  const parts = await page.evaluate(() =>
    [...(CSS.highlights.get('zhumo-search-match') ?? [])].map((part) => {
      const range = part as Range
      return {
        text: range.toString(),
        inBadge: Boolean(range.startContainer.parentElement?.closest('.zmu-ref'))
      }
    })
  )
  expect(parts).toEqual([
    { text: '门', inBadge: false },
    { text: '槛', inBadge: false }
  ])
  await expect(page.locator('.reader-scroll .zmu-ref')).toContainText('门槛')
})

test('dense long-book search mounts bounded results and its distribution reaches the far end', async () => {
  const source =
    '# 漫长的一日\n\n' +
    Array.from(
      { length: 3200 },
      (_, i) => '第' + (i + 1) + '段。' + '文字在这里展开，留给重读的空间。'.repeat(10) + '门槛。'
    ).join('\n\n') +
    '\n\n# 末尾\n\n最后的门槛。'
  await open(source)
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  const start = performance.now()
  await search('门槛', 3201)
  const elapsed = performance.now() - start
  await expect(page.locator('.search-result')).toHaveCount(24)
  const elements = await page.locator('.search-dialog *').count()
  expect(elements).toBeLessThan(850)
  await page.locator('.search-track[data-kind="section"] button.populated').last().click()
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  await page.getByRole('button', { name: '最后一页结果', exact: true }).click()
  await page.getByRole('button', { name: '查看第 3201 处上下文', exact: true }).click()
  await expect(page.locator('.search-context-text')).toContainText('最后的门槛')
  await page.getByRole('button', { name: '从此处阅读', exact: true }).click()
  await highlightInViewport('.reader-scroll', '门槛')
  await writeFile(
    metricPath('search-stress.json'),
    JSON.stringify(
      {
        executionMode,
        sourceChars: source.length,
        occurrences: 3201,
        firstQueryMs: elapsed,
        mountedResults: 24,
        dialogElements: elements,
        finalMatchReached: true
      },
      null,
      2
    )
  )
})
