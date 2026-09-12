import { READING_THEME_NAMES } from './theme-catalog'
import { electron, readClipboard } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-comparison-'))
  path = join(root, '两次经过.md')
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
  await page.getByRole('button', { name: /^(打开文稿|打开书籍)$/ }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await expect(page.locator('.document-overture h1')).toHaveText(
    source
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)[0]
      .replace(/^#\s+/, '')
  )
  await page.evaluate(() => document.fonts.ready)
}
async function search(term: string, count: number): Promise<void> {
  if (!(await page.locator('.search-dialog').isVisible())) await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill(term)
  await expect(page.locator('.search-count strong')).toHaveText(count.toLocaleString() + ' 处')
  await expect(page.locator('.search-body')).toHaveAttribute('aria-busy', 'false')
}
async function hold(): Promise<void> {
  await page.getByRole('button', { name: '将当前段落留作左页', exact: true }).click()
  await expect(page.locator('.search-held')).toBeVisible()
}
async function compare(): Promise<void> {
  await page.getByRole('button', { name: '并置阅读', exact: true }).click()
  await expect(page.locator('.comparison-dialog')).toBeVisible()
  await expect(page.locator('.comparison-error')).toHaveCount(0)
}
async function visibleMatch(side: 'left' | 'right' | 'body' | 'note', text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ side, text }) => {
          const pane = document.querySelector(
            side === 'body'
              ? '.reader-scroll'
              : side === 'note'
                ? '.notes-scroll'
                : '.comparison-page[data-side="' + side + '"] .comparison-reading'
          )
          const ranges = [
            ...(CSS.highlights.get(
              side === 'body' || side === 'note' ? 'zhumo-search-match' : 'zhumo-comparison-' + side
            ) ?? [])
          ] as Range[]
          if (!pane || !ranges.length || ranges.map((range) => range.toString()).join('') !== text)
            return false
          const boundary = pane.getBoundingClientRect()
          return ranges.every((range) => {
            const rect = range.getBoundingClientRect()
            return (
              pane.contains(range.startContainer) &&
              pane.contains(range.endContainer) &&
              rect.top >= boundary.top &&
              rect.bottom <= boundary.bottom &&
              rect.left >= boundary.left &&
              rect.right <= boundary.right
            )
          })
        },
        { side, text }
      )
    )
    .toBe(true)
}

test('two occurrences in one paragraph retain their own marks, swap and return to the second original occurrence', async () => {
  const source =
    '\uFEFF# 同一句话，两次经过\r\n\r\n门槛是**开始**；等到返回，门**槛**已经有了另一种含义。[^a]\r\n\r\n[^a]: 每次经过，都留下空白。'
  await open(source)
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await search('门槛', 2)
  await hold()
  await expect(page.getByRole('button', { name: '并置阅读', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
  await compare()
  await visibleMatch('left', '门槛')
  await visibleMatch('right', '门槛')
  const positions = await page.evaluate(() =>
    ['left', 'right'].map((side) => {
      const root = document.querySelector(
        '.comparison-page[data-side="' + side + '"] [data-comparison-target]'
      )!
      const match = [...CSS.highlights.get('zhumo-comparison-' + side)!][0] as Range
      const preceding = document.createRange()
      preceding.selectNodeContents(root)
      preceding.setEnd(match.startContainer, match.startOffset)
      return preceding.toString()
    })
  )
  expect(positions[0]).toBe('')
  expect(positions[1]).toContain('等到返回')
  await expect(page.locator('.comparison-prose strong')).toHaveCount(4)
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  await expect(page.locator('[contenteditable=true]')).toHaveCount(0)
  await page.getByRole('button', { name: '交换左右', exact: true }).click()
  await visibleMatch('left', '门槛')
  await visibleMatch('right', '门槛')
  await page.getByRole('button', { name: '复制两段及出处', exact: true }).click()
  expect(await readClipboard(app)).toContain('左页 · 同一句话，两次经过')
  expect(await readClipboard(app)).not.toContain('**')
  await page.getByRole('button', { name: '回到左页原文', exact: true }).click()
  await expect(page.locator('.comparison-dialog')).toHaveCount(0)
  await expect(page.locator('.search-dialog')).toBeHidden()
  await visibleMatch('body', '门槛')
  expect(
    await page.evaluate(() => {
      const range = [...CSS.highlights.get('zhumo-search-match')!][0] as Range
      return range.startContainer.textContent
    })
  ).toContain('等到返回')
  expect(await readFile(path, 'utf8')).toBe(source)
})

test('holding a passage survives a different query and closing search, but clears when the manuscript changes', async () => {
  await open('# 两个时刻\n\n初光来到窗前。\n\n## 晚间\n\n余晖照着尚未读完的信。')
  await search('初光', 1)
  await hold()
  await page.keyboard.press('Escape')
  await search('余晖', 1)
  await expect(page.locator('.search-held')).toContainText('初光')
  await compare()
  await visibleMatch('left', '初光')
  await visibleMatch('right', '余晖')
  await page.getByRole('button', { name: '回到检索', exact: true }).click()
  await expect(page.getByRole('button', { name: '并置阅读', exact: true })).toBeFocused()
  await expect(page.getByRole('textbox', { name: '搜索正文与旁注' })).toHaveValue('余晖')
  await page.keyboard.press('Escape')
  await open('# 新的文稿\n\n初光与余晖，不再是昨天的句子。')
  await search('余晖', 1)
  await expect(page.locator('.search-held')).toHaveCount(0)
  await expect(page.locator('.comparison-dialog')).toHaveCount(0)
})

test('long rich passages stay bounded, scroll independently, recover the mark and copy the whole paragraph', async () => {
  const first =
    '初光从这里展开。' +
    '这条路一直向未完成的地方延伸。'.repeat(1050) +
    '门**槛**留在远处。' +
    '回信尚未寄出。'.repeat(700)
  const second = '余晖在另一页。' + '读者经过一段沉默的时间。'.repeat(700) + '星**火**重新亮起。'
  await open('# 长信\n\n' + first + '\n\n## 另一个傍晚\n\n' + second)
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await search('门槛', 1)
  await hold()
  await search('星火', 1)
  await compare()
  await visibleMatch('left', '门槛')
  await visibleMatch('right', '星火')
  for (const side of ['left', 'right']) {
    const text = await page
      .locator('.comparison-page[data-side="' + side + '"] [data-comparison-target]')
      .textContent()
    expect(text!.length).toBeLessThanOrEqual(6002)
  }
  await expect(page.locator('.comparison-thread')).toHaveCount(1)
  const right = page.locator('.comparison-page[data-side="right"] .comparison-reading')
  const rightTop = await right.evaluate((el) => el.scrollTop)
  const left = page.locator('.comparison-page[data-side="left"] .comparison-reading')
  await left.hover()
  await page.mouse.wheel(0, 1400)
  await expect(page.locator('.comparison-thread')).toHaveCount(0)
  expect(await right.evaluate((el) => el.scrollTop)).toBe(rightTop)
  await page.getByRole('button', { name: '左页回到标记', exact: true }).click()
  await visibleMatch('left', '门槛')
  await expect(page.locator('.comparison-thread')).toHaveCount(1)
  await page.getByRole('button', { name: '左页往后读', exact: true }).click()
  expect(await page.evaluate(() => CSS.highlights.has('zhumo-comparison-left'))).toBe(false)
  await expect(page.locator('.comparison-thread')).toHaveCount(0)
  await page.getByRole('button', { name: '复制左页完整段落', exact: true }).click()
  expect(await readClipboard(app)).toBe(first.replaceAll('**', ''))
  await page.getByRole('button', { name: '左页回到标记', exact: true }).click()
  await visibleMatch('left', '门槛')
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  await page.getByRole('button', { name: '回到左页原文', exact: true }).click()
  await visibleMatch('body', '门槛')
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(5000)
})

test('nested list and table passages preserve their original structure without repeating child text', async () => {
  await open(
    '# 结构的边缘\n\n7. 门槛在父项\n   - 门槛在子项\n     - 门槛在孙项\n\n| 表头 |\n| --- |\n| 门槛在表格，**仍有强调** |\n\n原文 &lt;script&gt; 保持文字。'
  )
  await search('门槛', 4)
  await hold()
  await page.getByRole('button', { name: '查看第 4 处上下文', exact: true }).click()
  await compare()
  const left = page.locator('.comparison-page[data-side="left"] .comparison-prose')
  const right = page.locator('.comparison-page[data-side="right"] .comparison-prose')
  await expect(left.locator('ol')).toHaveAttribute('start', '7')
  await expect(left.locator('li')).toHaveCount(1)
  await expect(left).not.toContainText('子项')
  await expect(right.locator('table td strong')).toHaveText('仍有强调')
  await visibleMatch('left', '门槛')
  await visibleMatch('right', '门槛')
  await expect(
    page.locator('.comparison-prose [data-source-block],.comparison-prose [data-toc-id]')
  ).toHaveCount(0)
})

test('formula and diagram passages retain their inspectors, isolated SVG ids and original equation links', async () => {
  const fence = '\u0060\u0060\u0060'
  const source =
    '# 记号与意义\n\n参见 $\\eqref{body}$。\n\n\\[\\begin{equation}a=b\\label{body}\\end{equation}\\]\n\n' +
    fence +
    'mermaid\nflowchart LR\nA[开始] --> B[抵达]\n' +
    fence
  await open(source)
  await search('\\label{body}', 1)
  await hold()
  await search('flowchart', 1)
  await compare()
  const formula = page.locator('.comparison-page[data-side="left"] .zmu-math')
  const diagram = page.locator('.comparison-page[data-side="right"] .zmu-diagram')
  await expect(formula).toHaveClass(/comparison-atomic-match/)
  await expect(diagram).toHaveClass(/comparison-atomic-match/)
  await expect(diagram).toHaveAttribute('data-diagram-state', 'ready', { timeout: 15000 })
  await expect(page.locator('[id="mjx-eqn:body"]')).toHaveCount(1)
  await formula.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.math-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(formula).toBeFocused()
  await diagram.locator('.diagram-canvas').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.diagram-dialog')).toBeVisible()
  const ids = await page
    .locator(
      '.zmu-diagram svg [id],.zmu-diagram svg[id],.diagram-dialog svg [id],.diagram-dialog svg[id]'
    )
    .evaluateAll((nodes) => nodes.map((node) => node.id))
  expect(new Set(ids).size).toBe(ids.length)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '回到检索', exact: true }).click()
  await search('\\eqref{body}', 1)
  await compare()
  await page.locator('.comparison-page[data-side="right"] a[href="#mjx-eqn%3Abody"]').click()
  await expect(page.locator('.comparison-dialog')).toHaveCount(0)
  await expect(page.locator('.search-dialog')).toBeHidden()
  await expect(page.locator('.reader-scroll [id="mjx-eqn:body"]')).toBeInViewport()
})

test('annotations can be read above the two passages and the exact original note occurrence remains reachable', async () => {
  const source =
    '# 来处\n\n门槛在正文，旁边有一个入口。[^a]\n\n[^a]: 门槛在旁注，还能向下。[^b]\n\n[^b]: 门槛之后，另一重解释。'
  await open(source)
  await search('门槛', 3)
  await hold()
  await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
  await compare()
  const reference = page.locator('.comparison-page[data-side="right"] .zmu-ref')
  await reference.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.atlas-dialog')).toBeVisible()
  await expect(page.locator('.atlas-detail')).toContainText('另一重解释')
  await page.getByRole('button', { name: '关闭注释脉络', exact: true }).click()
  await expect(reference).toBeFocused()
  await expect(page.locator('.comparison-dialog')).toBeVisible()
  await page.getByRole('button', { name: '回到右页原文', exact: true }).click()
  await visibleMatch('note', '门槛')
  expect(
    await page.evaluate(() => {
      const range = [...CSS.highlights.get('zhumo-search-match')!][0] as Range
      return range.startContainer.parentElement?.closest('.zmu-note-body')?.textContent
    })
  ).toContain('还能向下')
  await expect(page.locator('[contenteditable=true]')).toHaveCount(0)
})

for (const destination of ['body', 'note', 'heading']) {
  test(
    'leaving a nested annotation for ' +
      destination +
      ' closes both comparison and search before landing',
    async () => {
      const source =
        '# 来处\n\n门槛在正文。[^a]\n\n' +
        Array.from(
          { length: 35 },
          (_, i) => '第' + i + '段，' + '一封信仍在途中。'.repeat(12)
        ).join('\n\n') +
        '\n\n## 末尾\n\n正文的终点。\n\n[^a]: 门槛在旁注。[转到末尾](#末尾)'
      await open(source)
      await search('门槛', 2)
      await hold()
      await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
      await compare()
      await page.locator('.comparison-page[data-side="left"] .zmu-ref-mark').click()
      await expect(page.locator('.atlas-dialog')).toBeVisible()
      if (destination === 'body')
        await page.getByRole('button', { name: '定位正文 来处 第1处', exact: true }).click()
      else if (destination === 'note')
        await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
      else
        await page
          .locator('.atlas-detail')
          .getByRole('link', { name: '转到末尾', exact: true })
          .click()
      await expect(page.locator('.atlas-dialog')).toHaveCount(0)
      await expect(page.locator('.comparison-dialog')).toHaveCount(0)
      await expect(page.locator('.search-dialog')).toBeHidden()
      if (destination === 'body')
        await expect(page.locator('.reader-scroll .zmu-ref-mark').first()).toBeInViewport()
      if (destination === 'note')
        await expect(
          page.locator('.notes-scroll .zmu-note-body').filter({ hasText: '门槛在旁注' })
        ).toBeInViewport()
      if (destination === 'heading')
        await expect(page.locator('.reader-scroll h2').filter({ hasText: '末尾' })).toBeInViewport()
      expect(await readFile(path, 'utf8')).toBe(source)
    }
  )
}

test('comparison preserves an unsaved draft and rebuilds both selections only after an explicit save', async () => {
  const source = '# 原稿\n\n门槛在起始。\n\n门槛在后来。'
  const prefix = '# 新序\n\n新添的门槛。\n\n'
  await open(source)
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText(prefix)
  await page.getByRole('button', { name: '全文检索', exact: true }).click()
  await search('门槛', 2)
  await hold()
  await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
  await page.getByRole('button', { name: '并置阅读', exact: true }).click()
  await expect(page.locator('.leave-dialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.locator('.comparison-dialog')).toHaveCount(0)
  await expect(page.locator('.cm-editor')).toBeVisible()
  expect(await readFile(path, 'utf8')).toBe(source)
  await page.getByRole('button', { name: '并置阅读', exact: true }).click()
  await page.getByRole('button', { name: '保存并继续', exact: true }).click()
  await expect(page.locator('.search-notice')).toContainText('文稿已更新')
  await expect(page.locator('.search-count strong')).toHaveText('3 处')
  await expect(page.locator('.search-held')).toHaveCount(0)
  await expect(page.locator('.comparison-dialog')).toHaveCount(0)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(await readFile(path, 'utf8')).toBe(prefix + source)
  await hold()
  await page.getByRole('button', { name: '查看第 3 处上下文', exact: true }).click()
  await compare()
  await visibleMatch('left', '门槛')
  await visibleMatch('right', '门槛')
  await expect(page.locator('.comparison-page[data-side="right"] .comparison-prose')).toContainText(
    '在后来'
  )
})

test('all nine themes keep both reading panes and controls usable in a small reduced-motion window', async () => {
  await open(
    '# 在世界与思想之间\n\n门槛是一道留给到来的人的空白。[^a]\n\n## 回信\n\n同一个门槛，也容许不一样的经过。\n\n[^a]: 空白，让阅读有继续的余地。'
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mkdir('work/screens', { recursive: true })
  for (const theme of READING_THEME_NAMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: theme }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await search('门槛', 2)
    await page.getByRole('button', { name: '查看第 1 处上下文', exact: true }).click()
    await hold()
    await page.getByRole('button', { name: '查看第 2 处上下文', exact: true }).click()
    await compare()
    await visibleMatch('left', '门槛')
    await visibleMatch('right', '门槛')
    for (const side of ['左', '右']) {
      await expect(
        page.getByRole('button', { name: '回到' + side + '页原文', exact: true })
      ).toBeInViewport({ ratio: 1 })
      const size = await page.getByLabel(side + '页阅读区', { exact: true }).evaluate((el) => ({
        height: el.clientHeight,
        width: el.clientWidth,
        overflow: el.scrollWidth > el.clientWidth + 1
      }))
      expect(size.height).toBeGreaterThan(100)
      expect(size.width).toBeGreaterThan(250)
      expect(size.overflow).toBe(false)
    }
    if (theme === '琉璃' || theme === '星辰' || theme === '潮光')
      await page.screenshot({ path: 'work/screens/comparison-' + theme + '-960.png', scale: 'css' })
    await page.keyboard.press('Escape')
    await expect(page.locator('.comparison-dialog')).toHaveCount(0)
    await expect(page.locator('.search-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
  }
})
