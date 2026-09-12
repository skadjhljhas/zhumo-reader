import { electron, metricPath, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-position-'))
  path = join(root, '读与写的同一处.md')
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
}
function manuscript(count = 30): string {
  return (
    '# 读与写的同一处\n\n' +
    Array.from(
      { length: count },
      (_, i) =>
        '## 第 ' +
        (i + 1) +
        ' 节\n\n位置 ' +
        (i + 1) +
        '。' +
        '同一个句子，在阅读与书写之间保留来处。'.repeat(5) +
        '\n\n本节结尾 ' +
        (i + 1) +
        '。'
    ).join('\n\n')
  )
}
async function land(locator: Locator, container: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  await locator.evaluate((el, selector) => {
    const root = el.closest<HTMLElement>(selector)!
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 100
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
  }, container)
}
async function visibleEditor(selector = '.editor-panes .cm-scroller'): Promise<string> {
  return page.locator(selector).evaluate((root) => {
    const rect = root.getBoundingClientRect()
    return [...root.querySelectorAll('.cm-line')]
      .filter((line) => {
        const r = line.getBoundingClientRect()
        return r.bottom > rect.top + 10 && r.top < rect.bottom - 10
      })
      .map((line) => line.textContent)
      .join('\n')
  })
}
async function save(): Promise<void> {
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
}

test('entering editing preserves the reading paragraph, the caret drives preview, and reading resumes there', async () => {
  await open(manuscript())
  await land(page.locator('.reader-scroll h2').filter({ hasText: '第 18 节' }), '.reader-scroll')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect.poll(() => visibleEditor()).toContain('第 18 节')
  await expect(page.locator('.draft-preview h2').filter({ hasText: '第 18 节' })).toBeInViewport()
  const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器' })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('【此处继续】')
  await expect(
    page.locator('.draft-preview p').filter({ hasText: '【此处继续】' })
  ).toBeInViewport()
  await save()
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(
    page.locator('.reader-scroll p').filter({ hasText: '【此处继续】' })
  ).toBeInViewport()
  expect(errors).toEqual([])
})

test('preview scrolling follows into the source without stealing focus, and following can be paused', async () => {
  const source = manuscript()
  await open(source)
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  const preview = page.locator('.preview-scroll')
  await preview.focus()
  await land(page.locator('.draft-preview h2').filter({ hasText: '第 22 节' }), '.preview-scroll')
  await expect.poll(() => visibleEditor()).toContain('第 22 节')
  await expect(preview).toBeFocused()
  expect(await readFile(path, 'utf8')).toBe(source)
  await page.getByRole('button', { name: '同步编辑与阅读位置', exact: true }).click()
  const before = await page.locator('.editor-panes .cm-scroller').evaluate((el) => el.scrollTop)
  await land(page.locator('.draft-preview h2').filter({ hasText: '第 10 节' }), '.preview-scroll')
  await page.waitForTimeout(300)
  expect(await page.locator('.editor-panes .cm-scroller').evaluate((el) => el.scrollTop)).toBe(
    before
  )
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(page.locator('.reader-scroll h2').filter({ hasText: '第 10 节' })).toBeInViewport()
  expect(errors).toEqual([])
})

test('note writing follows its own paragraphs and returns to the matching place in the sidebar', async () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => '注释段落 ' + (i + 1) + '。' + '理解仍在这里展开。'.repeat(8)
  )
  await open('# 一条长注\n\n正文[^甲]。\n\n[^甲]: ' + paragraphs.join('\n\n    '))
  await page.getByRole('button', { name: '开启编辑并修改注释 甲', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '注释正文编辑器' })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('【注释的末段】')
  await expect(
    page.locator('.writer-preview p').filter({ hasText: '【注释的末段】' })
  ).toBeInViewport()
  await save()
  await land(
    page.locator('.writer-preview p').filter({ hasText: '注释段落 24。' }),
    '.writer-preview'
  )
  await expect.poll(() => visibleEditor('.writer-editor .cm-scroller')).toContain('注释段落 24。')
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(
    page.locator('.notes-scroll p').filter({ hasText: '注释段落 24。' })
  ).toBeInViewport()
  expect(errors).toEqual([])
})

test('source definition editing locates its note rather than the body and the minimum window retains the position', async () => {
  await open(manuscript(8) + '\n\n[^末注]: 这一条旁注在源文末尾。')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器' })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await expect(
    page.locator('.preview-note').filter({ hasText: '这一条旁注在源文末尾' })
  ).toBeInViewport()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.getByRole('button', { name: '显示预览', exact: true }).click()
  await expect(
    page.locator('.preview-note').filter({ hasText: '这一条旁注在源文末尾' })
  ).toBeInViewport()
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(page.locator('.notes-scroll')).toContainText('这一条旁注在源文末尾')
  expect(errors).toEqual([])
})

test('explicit preview jumps win over source following in a long document', async () => {
  await open(
    '# 同步中的跳转\n\n## 目标位置\n\n原句[^甲]。\n\n' +
      manuscript(40) +
      '\n\n[^甲]: [回到目标](#目标位置)。'
  )
  await page.getByRole('button', { name: '开启编辑并修改注释 甲', exact: true }).click()
  await page.locator('.writer-preview').getByRole('link', { name: '回到目标', exact: true }).click()
  const target = page.locator('.draft-preview [data-heading-hash="目标位置"]')
  await expect(target).toBeInViewport()
  await page.waitForTimeout(500)
  await expect(target).toBeInViewport()
  expect(errors).toEqual([])
})

test('large manuscripts align distant virtual rows without mounting the entire preview', async () => {
  test.setTimeout(60000)
  const source = Array.from(
    { length: 120 },
    (_, i) =>
      '# 第 ' +
      (i + 1) +
      ' 章\n\n' +
      Array.from(
        { length: 16 },
        (_, j) => '本章 ' + (i + 1) + ' 段落 ' + j + '。' + '文字之间仍有可供停留的空间。'.repeat(4)
      ).join('\n\n')
  ).join('\n\n')
  await open(source)
  await page
    .locator('.toc-item')
    .filter({ hasText: /^第 80 章$/ })
    .click()
  await expect(
    page.locator('.reader-scroll [data-section-id="sec-80"] .section-body')
  ).toBeVisible()
  const started = Date.now()
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect.poll(() => visibleEditor()).toContain('第 80 章')
  await expect(page.locator('.preview-row[data-preview-id="sec-80"]')).toBeInViewport()
  const entryMs = Date.now() - started
  expect(await page.locator('.preview-row').count()).toBeLessThan(10)
  expect(entryMs).toBeLessThan(10000)
  await writeFile(
    metricPath('position-performance.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        chars: source.length,
        chapters: 120,
        entryMs,
        mountedRows: await page.locator('.preview-row').count(),
        errors
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
})

test('the literary tutorial holds shortcut guidance while references stay free of native reminders and the pointer stays open and light', async () => {
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  const reference = page.locator('.reader-scroll .zmu-ref').first()
  expect(await reference.getAttribute('title')).toBeNull()
  await expect(page.locator('.reader-scroll')).toContainText('Shift+Enter')
  await reference.focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.note-peek')).toBeVisible()
  await page.keyboard.press('Escape')
  await mkdir('work/screens', { recursive: true })
  for (const theme of ['琉璃', '星辰']) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: theme }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    const boundary = await page.locator('.reader-scroll').boundingBox()
    await page.mouse.move(boundary!.x + boundary!.width - 25, boundary!.y + 110)
    await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'air')
    const shape = await page.locator('.optical-cursor i').evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        border: parseFloat(style.borderTopWidth)
      }
    })
    expect(shape.width).toBeGreaterThan(shape.height * 4)
    expect(shape.border).toBe(0)
    await page.screenshot({ path: 'work/screens/position-cursor-' + theme + '.png', scale: 'css' })
  }
  expect(errors).toEqual([])
})
