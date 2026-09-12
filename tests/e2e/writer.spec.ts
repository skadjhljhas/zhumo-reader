import { READING_THEMES } from './theme-catalog'
import { electron, metricPath, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-writing-'))
  path = join(root, '注释写作.md')
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
const body = (): Locator => page.getByRole('textbox', { name: '注释正文编辑器', exact: true })
async function edit(label: string, missing = false): Promise<void> {
  await page
    .getByRole('button', {
      name: `开启编辑并${missing ? '补写' : '修改'}注释 ${label}`,
      exact: true
    })
    .click()
  await expect(page.getByRole('region', { name: '注释写作台', exact: true })).toBeVisible()
}
async function save(): Promise<void> {
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
}

test('explicit note editing shares undo and byte-faithful save, and rename updates only real references', async () => {
  const source =
    '\uFEFF# 一句原文\r\n\r\n门还开着[^甲]，再读[^甲]。\n\n[^甲]： 原来的解释 `[^甲]`。\r\n\r\n\t第二段不能改动。\n\n[^乙]: 引用[^甲]。\r\n'
  await open(source)
  await expect(page.locator('[contenteditable=true]')).toHaveCount(0)
  await edit('甲')
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await expect(body()).toContainText('原来的解释')
  await body().focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText('新的想法。')
  await expect(page.locator('.writer-status')).toHaveText('正在排版…')
  await expect(page.locator('.writer-preview')).toContainText('新的想法。')
  await page.getByRole('textbox', { name: '注释标号', exact: true }).fill('回声')
  await page.getByRole('button', { name: '更新引用', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('回声')
  await page.getByRole('button', { name: '注释撤销', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('甲')
  await expect(body()).toContainText('新的想法。')
  await page.getByRole('button', { name: '注释重做', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('回声')
  await save()
  expect(await readFile(path, 'utf8')).toBe(
    source
      .replace('原来的解释', '新的想法。原来的解释')
      .replace('门还开着[^甲]，再读[^甲]', '门还开着[^回声]，再读[^回声]')
      .replace('[^甲]：', '[^回声]：')
      .replace('引用[^甲]', '引用[^回声]')
  )
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await expect(page.locator('.notes-scroll')).toContainText('新的想法。')
  expect(errors).toEqual([])
})

test('new anchored notes and three-level writing paths retain text and return to the source reference', async () => {
  await open('# 写作的来处\n\n门还开着，等待意味着什么。')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  const source = page.getByRole('textbox', { name: 'Markdown 源文编辑器' })
  await source.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Shift+Home')
  await page.getByRole('button', { name: '写注释', exact: true }).click()
  await expect(page.locator('.writer-context')).toContainText('门还开着')
  await expect(body()).toBeFocused()
  await page.keyboard.insertText('开放还有另一个意思。\n\n这句话需要再想。')
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: '写一条子注', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('2')
  await page.keyboard.insertText('另一个意思需要证据。')
  await page.getByRole('button', { name: '写一条子注', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('3')
  await page.keyboard.insertText('证据是一封未寄出的信。')
  await page.getByRole('button', { name: '写作返回', exact: true }).click()
  await expect(body()).toContainText('另一个意思需要证据。[^3]')
  await page.getByRole('button', { name: '写作返回', exact: true }).click()
  await expect(body()).toContainText('这句话需要再想。[^2]')
  await page.getByRole('button', { name: '写作前进', exact: true }).click()
  await expect(body()).toContainText('另一个意思需要证据。')
  await save()
  const written = await readFile(path, 'utf8')
  expect(written).toContain('门还开着，等待意味着什么。[^1]')
  expect(written).toContain('    这句话需要再想。[^2]')
  expect(written).toContain('[^3]: 证据是一封未寄出的信。')
  await page.getByRole('button', { name: '回到引用', exact: true }).click()
  await expect(source).toBeFocused()
  await page.keyboard.insertText('【回到此处】')
  await save()
  expect(await readFile(path, 'utf8')).toContain('这句话需要再想。[^2]【回到此处】')
  expect(errors).toEqual([])
})

test('inline conversion and its undo preserve the manuscript, while missing notes can be completed', async () => {
  const original = '# 行内思路\n\n一句^[原先的一条注。]，另见[^auto-1]，留待补写[^未写]。'
  await open(original)
  await edit('1')
  await page.getByRole('button', { name: '转为独立注释', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '注释标号' })).toHaveValue('auto-1')
  await expect(body()).toContainText('原先的一条注。')
  await page.getByRole('button', { name: '注释撤销', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 源文编辑器' })).toBeVisible()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await edit('未写', true)
  await expect(body()).toBeFocused()
  await page.keyboard.insertText('在后来补写的解释。')
  await save()
  expect(await readFile(path, 'utf8')).toBe(original + '\n\n[^未写]: 在后来补写的解释。')
  expect(errors).toEqual([])
})

test('writer changes participate in the real window-close guard and draft recovery', async () => {
  const original = '# 不丢文字\n\n这一句[^甲]。\n\n[^甲]: 原注。'
  await open(original)
  await edit('甲')
  await app.evaluate(({ ipcMain }) => ipcMain.removeAllListeners('document:dirty'))
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('需要恢复的想法。')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect(page.getByText('还有未保存的修改', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(body()).toContainText('需要恢复的想法。')
  expect(await readFile(path, 'utf8')).toBe(original)
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          new Promise<string[]>((resolve) => {
            const request = indexedDB.open('zhumo-recovery')
            request.onsuccess = () => {
              const query = request.result
                .transaction('drafts-v2')
                .objectStore('drafts-v2')
                .getAll()
              query.onsuccess = () => resolve(query.result.map((draft) => draft.source))
            }
          })
      )
    )
    .toEqual([original + '需要恢复的想法。'])
  expect(errors).toEqual([])
})

test('writing and reading panes remain usable in all nine themes at the minimum window size', async () => {
  await open(
    '# 玻璃上的文字\n\n一句话在后来改变[^痕迹]。\n\n[^痕迹]: 一封信并不是一种解释的终点。\n\n    我们沿着文字的来处，重新理解那扇仍然敞开的门。\n\n    $\\int_0^1 x^2\\,dx=\\frac13$。'
  )
  await edit('痕迹')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await mkdir('work/screens', { recursive: true })
  for (const [name, id] of READING_THEMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: name }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-skin', id)
    await expect(body()).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const layout = await page.evaluate(() => {
      const compose = document.querySelector('.writer-editor')!.getBoundingClientRect()
      const proof = document.querySelector('.writer-preview')!.getBoundingClientRect()
      const outside = [...document.querySelectorAll('.note-writing-desk button,.writer-colophon')]
        .filter((el) => {
          const box = el.getBoundingClientRect()
          return (
            box.width > 0 &&
            (box.right > innerWidth + 1 || box.bottom > innerHeight + 1 || box.left < -1)
          )
        })
        .map((el) => el.textContent)
      return {
        compose: { width: compose.width, height: compose.height },
        proof: { width: proof.width, height: proof.height },
        outside
      }
    })
    expect(layout.outside).toEqual([])
    expect(layout.compose.width).toBeGreaterThan(320)
    expect(layout.compose.height).toBeGreaterThan(170)
    expect(layout.proof.height).toBeGreaterThan(170)
    await page.screenshot({ path: `work/screens/writer-${id}-960.png` })
  }
  expect(errors).toEqual([])
})

test('formula and heading links from an unsaved note lead into the current draft, including a compact window', async () => {
  const original =
    '# 写作中的公式\n\n说明[^甲]。\n\n## 目标\n\n\\[\n\\begin{equation}\\label{writer-eq}x^2=1\\end{equation}\n\\]\n\n[^甲]: 一条解释。'
  await open(original)
  await edit('甲')
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' 再见 $\\eqref{writer-eq}$，以及[那一节](#目标)。')
  const formula = page.locator('.writer-preview .zmu-math').first()
  await expect(formula).toBeVisible()
  await formula.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: '公式细读' })).toBeVisible()
  await expect(page.locator('.math-source')).toContainText('eqref{writer-eq}')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.locator('.math-content a').click()
  await expect(page.getByRole('dialog', { name: '公式细读' })).not.toBeVisible()
  await expect(page.locator('.draft-preview')).toBeVisible()
  const target = page.locator('.draft-preview [id="mjx-eqn:writer-eq"]')
  await expect(target).toBeInViewport()
  await page.getByRole('button', { name: '修改注释 甲', exact: true }).click()
  await expect(body()).toContainText('eqref{writer-eq}')
  await page.locator('.writer-preview').getByRole('link', { name: '那一节' }).click()
  await expect(page.locator('.draft-preview [data-heading-hash="目标"]')).toBeInViewport()
  await page.getByRole('button', { name: '回到源文', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 源文编辑器' })).toBeFocused()
  await save()
  expect(await readFile(path, 'utf8')).toBe(
    original + ' 再见 $\\eqref{writer-eq}$，以及[那一节](#目标)。'
  )
  expect(errors).toEqual([])
})

test('Chinese IME composition commits once into the master document and survives undo and redo', async () => {
  const original = '# 中文写作\n\n一句[^甲]。\n\n[^甲]: 原注。'
  await open(original)
  await edit('甲')
  await body().focus()
  await page.keyboard.press('Control+End')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'hou', selectionStart: 3, selectionEnd: 3 })
  await cdp.send('Input.imeSetComposition', { text: '后来', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '后来' })
  await expect(body()).toHaveText('原注。后来')
  await page.keyboard.press('Control+z')
  await expect(body()).toHaveText('原注。')
  await page.keyboard.press('Control+Shift+Z')
  await expect(body()).toHaveText('原注。后来')
  await save()
  expect(await readFile(path, 'utf8')).toBe(original + '后来')
  await cdp.detach()
  expect(errors).toEqual([])
})

test('an annotation in a half-million-character manuscript opens and edits without mounting all notes', async () => {
  test.setTimeout(60000)
  const original = await readFile(resolve('src/renderer/public/demo/stress-50w.md'), 'utf8')
  await open(original)
  const start = Date.now()
  await page.locator('.notes-scroll .note-edit-link').first().click()
  await expect(body()).toBeVisible()
  const entryMs = Date.now() - start
  await body().focus()
  await page.keyboard.press('Control+End')
  const inputStart = Date.now()
  await page.keyboard.insertText('【长文注释写作验证】')
  await expect(body()).toContainText('【长文注释写作验证】')
  const inputMs = Date.now() - inputStart
  await expect(page.locator('.writer-status')).toHaveText('与文稿同步', { timeout: 15000 })
  await expect(page.locator('.writer-preview')).toContainText('【长文注释写作验证】')
  const mountedNotes = await page.locator('.note-writing-desk .note-card').count()
  expect(mountedNotes).toBe(1)
  expect(entryMs).toBeLessThan(10000)
  expect(inputMs).toBeLessThan(1500)
  await save()
  expect((await readFile(path, 'utf8')).split('【长文注释写作验证】')).toHaveLength(2)
  await writeFile(
    metricPath('writer-performance.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        chars: original.length,
        entryMs,
        inputMs,
        mountedNotes,
        errors
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
})

test('a clean reading window completes the close handshake without asking about changes', async () => {
  await open('# 只读完一页\n\n此页没有修改。')
  const closed = page.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
})

test('returning from a child restores both the writing caret and the long-note reading position', async () => {
  const paragraphs = Array.from(
    { length: 65 },
    (_, i) => `第 ${i + 1} 段。保留原句之后，理解才有能够回到的地方。${i === 28 ? '[^子]' : ''}`
  )
  await open(
    '# 一条长思路\n\n文字[^甲]。\n\n[^甲]: ' +
      paragraphs.join('\n\n    ') +
      '\n\n[^子]: 在这里继续。'
  )
  await edit('甲')
  await body().focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  // Real preview scrolling takes over from caret following before locating
  // the distant branch; a DOM-only scroll can race the queued caret update.
  await page.locator('.writer-preview').hover()
  await page.mouse.wheel(0, 1000)
  const link = page
    .locator('.writer-preview')
    .getByRole('button', { name: '阅读注释 子', exact: true })
    .locator('.zmu-ref-mark')
  await link.scrollIntoViewIfNeeded()
  const before = await page.locator('.writer-preview').evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(800)
  await link.click()
  await expect(body()).toContainText('在这里继续')
  await page.getByRole('button', { name: '写作返回', exact: true }).click()
  await expect
    .poll(async () =>
      Math.abs((await page.locator('.writer-preview').evaluate((el) => el.scrollTop)) - before)
    )
    .toBeLessThan(3)
  await expect(body()).toBeFocused()
  await page.keyboard.insertText('【光标仍在这里】')
  await save()
  expect(await readFile(path, 'utf8')).toContain('[^甲]: 第【光标仍在这里】 1 段。')
  expect(errors).toEqual([])
})
