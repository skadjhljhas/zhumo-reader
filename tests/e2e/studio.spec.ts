import { READING_THEMES } from './theme-catalog'
import { electron, readClipboard, metricPath, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, bookPath: string
const errors: string[] = []
const original =
  '\uFEFF# 原始题目\r\n\r\n这是一段原文。[^甲]\r\n\r\n第二段落。\r\n\r\n[^甲]: 注释正文，可以选中。\r\n'
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-e2e-'))
  bookPath = join(root, '原始文稿.md')
  await writeFile(bookPath, original)
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  errors.length = 0
  page.on('pageerror', (e) => errors.push(e.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
})
test.afterEach(async () => {
  if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function openFile(): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, bookPath)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.document-overture h1')).toContainText('原始题目')
}
async function editAppend(text: string): Promise<void> {
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(text)
}
test('mode controls wait for an atomic document load, then the first edit action takes effect', async () => {
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions
    ) {
      setTimeout(
        () => Reflect.apply(post, this, options === undefined ? [message] : [message, options]),
        900
      )
    }
  })
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  const edit = page.getByRole('button', { name: '开启编辑', exact: true })
  await expect(edit).toBeDisabled()
  await expect(page.getByRole('button', { name: '阅读', exact: true })).toBeDisabled()
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await edit.click()
  await expect(page.getByRole('textbox', { name: 'Markdown 源文编辑器' })).toBeVisible()
  await expect(edit).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('nine theme choices remain legible and reachable on the compact welcome screen', async () => {
  await mkdir('work/screens', { recursive: true })
  for (const [width, height] of [
    [960, 640],
    [1140, 760],
    [1500, 980]
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height]
    )
    for (const name of ['琉璃', '潮光']) {
      const swatches = page.locator('.space-swatches')
      await swatches.getByRole('button', { name, exact: true }).click()
      await swatches.scrollIntoViewIfNeeded()
      await expect(swatches.locator('button')).toHaveCount(READING_THEMES.length)
      expect(await swatches.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
        1
      )
      for (const [title] of READING_THEMES) {
        const button = swatches.getByRole('button', { name: title, exact: true })
        await expect(button).toBeInViewport({ ratio: 1 })
        expect(
          await button.evaluate((el) => {
            const label = el.querySelector('small')!.getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return label.left >= box.left && label.right <= box.right
          }),
          title + ' at ' + width
        ).toBe(true)
      }
      await expect(page.locator('.cm-editor')).toHaveCount(0)
      if (width === 960)
        await page.screenshot({ path: 'work/screens/welcome-nine-' + name + '.png', scale: 'css' })
    }
  }
})

test('nine distinct themes, reading first, notes and accessible formula inspection', async () => {
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  await expect(page.locator('.document-overture')).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await page.locator('.reader-scroll .zmu-math').first().click()
  await expect(page.getByText('公式细读', { exact: true })).toBeVisible()
  await expect(page.locator('.math-source')).not.toBeEmpty()
  await page.keyboard.press('Escape')
  await expect(page.locator('.math-dialog')).not.toBeVisible()
  await page.locator('.note-pin').first().click()
  await page.getByRole('button', { name: '固定 1', exact: true }).click()
  await expect(page.locator('.notes-scroll .note-card')).toHaveCount(1)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  const names = READING_THEMES.map(([name]) => name)
  const ids = READING_THEMES.map(([, id]) => id)
  await mkdir('work/screens', { recursive: true })
  for (let i = 0; i < names.length; i++) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: names[i] }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-skin', ids[i])
    await page.locator('.reader-scroll').evaluate((el) => {
      el.scrollTop = 0
    })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `work/screens/${ids[i]}.png` })
  }
  expect(errors).toEqual([])
})
test('edits require activation, save bytes faithfully, and survive returning to reading', async () => {
  await openFile()
  await expect(page.locator('[contenteditable=true]')).toHaveCount(0)
  await editAppend('追加内容。')
  await expect(page.locator('.unsaved-dot')).toBeVisible()
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  expect(await readFile(bookPath, 'utf8')).toBe(original + '追加内容。')
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await expect(page.locator('.reader-scroll')).toContainText('追加内容。')
  expect(errors).toEqual([])
})
test('switching files and closing the real window ask about unsaved edits', async () => {
  await openFile()
  await editAppend('未保存')
  await page.getByRole('button', { name: '打开书籍', exact: true }).click()
  await expect(page.getByText('还有未保存的修改', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect(page.getByText('还有未保存的修改', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('未保存')
  expect(await readFile(bookPath, 'utf8')).toBe(original)
})
test('external file changes are never overwritten', async () => {
  await openFile()
  await editAppend('我写的')
  await writeFile(bookPath, '另一个程序的修改')
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('其他程序修改')
  expect(await readFile(bookPath, 'utf8')).toBe('另一个程序的修改')
  await expect(page.locator('.unsaved-dot')).toBeVisible()
})

test('toolbars remain inside the window and reading stays usable at smaller sizes', async () => {
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  await expect(page.locator('.document-overture')).toBeVisible()
  for (const [width, height] of [
    [1500, 980],
    [1200, 780],
    [960, 640]
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height]
    )
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('.statusbar')!.getBoundingClientRect()
      const rail = document.querySelector('.rail-bottom')!.getBoundingClientRect()
      const reader = document.querySelector('.reader-scroll')!.getBoundingClientRect()
      return {
        footerBottom: footer.bottom,
        railBottom: rail.bottom,
        height: innerHeight,
        width: reader.width
      }
    })
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.height + 1)
    expect(layout.railBottom).toBeLessThanOrEqual(layout.height + 1)
    expect(layout.width).toBeGreaterThan(360)
  }
})
test('recovery survives a process restart and reopening begins in reading mode', async () => {
  await openFile()
  await editAppend('恢复这段文字')
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        return new Promise<number>((resolve, reject) => {
          const request = indexedDB.open('zhumo-recovery')
          request.onsuccess = () => {
            const tx = request.result.transaction('drafts-v2').objectStore('drafts-v2').count()
            tx.onsuccess = () => resolve(tx.result)
          }
          request.onerror = () => reject(request.error)
        })
      })
    )
    .toBe(1)
  await app.evaluate(({ app }) => app.exit(0))
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await expect(page.getByText('另有天地。')).toBeVisible()
  await openFile()
  await expect(page.locator('.recovery-banner')).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await page.getByRole('button', { name: '恢复编辑', exact: true }).click()
  await expect(page.locator('.cm-content')).toContainText('恢复这段文字')
  expect(await readFile(bookPath, 'utf8')).toBe(original)
})
test('editing can be discarded, and source preview never modifies the disk', async () => {
  await openFile()
  await editAppend('临时修改')
  await expect(page.locator('.draft-preview')).toContainText('临时修改')
  expect(await readFile(bookPath, 'utf8')).toBe(original)
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await expect(page.locator('.reader-scroll')).not.toContainText('临时修改')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.cm-content')).not.toContainText('临时修改')
})

test('search lands on the matched paragraph and opens a hidden note sidebar', async () => {
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  await expect(page.locator('.document-overture')).toBeVisible()
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('下一页')
  await page.locator('.search-result').first().click()
  await expect(page.locator('.search-landed')).toContainText('下一页')
  await expect
    .poll(() =>
      page.locator('.search-landed').evaluate((el) => {
        const root = document.querySelector('.reader-scroll')!.getBoundingClientRect()
        const rect = el.getBoundingClientRect()
        return rect.top >= root.top && rect.top < root.bottom
      })
    )
    .toBe(true)
  await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
  await expect(page.locator('.notes-sidebar')).toHaveCount(0)
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('一条旁注可以被多处引用')
  await page.locator('.search-result').click()
  await expect(page.locator('.notes-sidebar')).toBeVisible()
})
test('selecting a note does not move the reader; nested notes have a return path', async () => {
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  const reader = page.locator('.reader-scroll')
  const before = await reader.evaluate((el) => el.scrollTop)
  await page.locator('.notes-scroll .zmu-note-body').first().click()
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(before)
  await page.locator('.notes-scroll .zmu-ref-mark').first().click()
  await expect(page.getByRole('button', { name: '返回上一注' })).toBeVisible()
  await page.getByRole('button', { name: '返回上一注' }).click()
})
test('Save As creates a new file and leaves the original untouched', async () => {
  await openFile()
  await editAppend('另存内容')
  const copyPath = join(root, '副本.md')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, copyPath)
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  expect(await readFile(copyPath, 'utf8')).toBe(original + '另存内容')
  expect(await readFile(bookPath, 'utf8')).toBe(original)
})

test('undo returns the document to exactly the saved state', async () => {
  await openFile()
  await editAppend('应当撤销')
  await page.keyboard.press('Control+z')
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await expect(page.locator('.leave-dialog')).not.toBeVisible()
  expect(await readFile(bookPath, 'utf8')).toBe(original)
})
test('two editing windows keep separate recoverable drafts', async () => {
  await openFile()
  await editAppend('甲窗口的草稿')
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(
    ({ app }, path) => app.emit('second-instance', {}, [app.getPath('exe'), path], '', {}),
    bookPath
  )
  const second = await nextWindow
  await expect(second.locator('.document-overture')).toBeVisible()
  await second.getByRole('button', { name: '开启编辑', exact: true }).click()
  await second.getByRole('textbox', { name: 'Markdown 源文编辑器' }).click()
  await second.keyboard.press('Control+End')
  await second.keyboard.insertText('乙窗口的草稿')
  await expect
    .poll(() =>
      second.evaluate(
        async () =>
          new Promise<number>((resolve, reject) => {
            const r = indexedDB.open('zhumo-recovery')
            r.onsuccess = () => {
              const req = r.result.transaction('drafts-v2').objectStore('drafts-v2').count()
              req.onsuccess = () => resolve(req.result)
            }
            r.onerror = () => reject(r.error)
          })
      )
    )
    .toBe(2)
  expect(await readFile(bookPath, 'utf8')).toBe(original)
})
test('virtual notes can locate a distant reference and reopen a pinned note', async () => {
  const definitions = Array.from({ length: 400 }, (_, i) => `[^${i + 1}]: 注释内容 ${i + 1}`).join(
    '\n\n'
  )
  const source =
    '# 大量注释\n\n' +
    Array.from({ length: 400 }, (_, i) => `段落 ${i + 1}[^${i + 1}]。\n\n`).join('') +
    definitions
  await writeFile(bookPath, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, bookPath)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.notes-meta')).toContainText('400')
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('注释内容 400')
  await page.locator('.search-result').click()
  const last = page.locator('.note-card[data-note-id="note-400"]')
  await expect(last).toBeVisible()
  await last.locator('.note-pin').click()
  await page.getByRole('button', { name: '固定 1', exact: true }).click()
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.locator('.note-card')).toContainText('注释内容 400')
})

test('preview visual surfaces: welcome, theme gallery, editor and formula', async () => {
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/welcome.png', scale: 'css' })
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page.screenshot({ path: 'work/screens/theme-gallery.png', scale: 'css' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  await expect(page.locator('.document-overture')).toBeVisible()
  await page.locator('.reader-scroll .zmu-math-block').first().click()
  await page.screenshot({ path: 'work/screens/formula.png', scale: 'css' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  await page.screenshot({ path: 'work/screens/editor.png', scale: 'css' })
})

test('inline formulas stay clickable and keyboard note navigation opens the sidebar', async () => {
  await writeFile(
    bookPath,
    '# 行内交互\n\n' + '正文文字。'.repeat(28) + ' $x^2$ 后文[^甲]。\n\n[^甲]: 键盘定位的注释'
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, bookPath)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await page.locator('.reader-scroll .zmu-math').click()
  await expect(page.getByText('公式细读', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
  await page.locator('.reader-scroll .zmu-ref').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.notes-sidebar')).toBeVisible()
  await expect(page.locator('.notes-sidebar')).toContainText('键盘定位的注释')
  expect(errors).toEqual([])
})

test('half-million-character source editing limits preview DOM and keeps edits responsive', async () => {
  test.setTimeout(60000)
  const source = await readFile(resolve('src/renderer/public/demo/stress-50w.md'), 'utf8')
  await writeFile(bookPath, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, bookPath)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  const start = Date.now()
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  const entryMs = Date.now() - start
  const rows = await page.locator('.preview-row').count()
  expect(rows).toBeLessThan(15)
  await page.getByRole('textbox', { name: 'Markdown 源文编辑器' }).click()
  await page.keyboard.press('Control+End')
  const typed = Date.now()
  await page.keyboard.insertText('\n\n编辑测试标记')
  await expect(page.locator('.cm-content')).toContainText('编辑测试标记')
  const typingMs = Date.now() - typed
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  await page.locator('.preview-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.locator('.preview-note').last()).toBeVisible()
  expect(await page.locator('.preview-row').count()).toBeLessThan(25)
  expect(await readFile(bookPath, 'utf8')).toBe(source)
  expect(errors).toEqual([])
  await writeFile(
    metricPath('native-editor-performance.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        entryMs,
        typingMs,
        visibleRowsAtEntry: rows,
        errors
      },
      null,
      2
    )
  )
})

test('local images, heading fragments and relative Markdown links work in the native reader', async () => {
  const assets = join(root, '图 片')
  await mkdir(assets)
  await writeFile(
    join(assets, '插图 # 1.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="140"><rect width="400" height="140" fill="#9a4438"/><text x="24" y="76" fill="white" font-size="24">ZhuMo local image</text></svg>'
  )
  const source =
    '# 本地文稿\n\n![示意图](<图 片/插图 %23 1.svg>)\n\n[跳到第二章](#第二章)\n\n' +
    '这是一段间隔正文。\n\n'.repeat(70) +
    '## 第二章\n\n[打开另一篇](<另一篇.md#目标小节>)'
  await writeFile(bookPath, source)
  await writeFile(
    join(root, '另一篇.md'),
    '# 另一篇\n\n' + '这是一段前文。\n\n'.repeat(40) + '## 目标小节\n\n已经打开相邻 Markdown 文稿。'
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, bookPath)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  const img = page.locator('.reader-scroll img[alt="示意图"]')
  await img.scrollIntoViewIfNeeded()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(400)
  await page.getByRole('link', { name: '跳到第二章' }).click()
  await expect(page.locator('.search-landed')).toHaveText('第二章')
  await page.getByRole('link', { name: '打开另一篇' }).click()
  await expect(page.locator('.document-overture h1')).toHaveText('另一篇')
  await expect(page.locator('.search-landed')).toHaveText('目标小节')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.preview-label')).toContainText('与源文同步')
  expect(errors).toEqual([])
})

test('flagship materials render on the GPU, respond to text and preserve a quiet mode', async () => {
  await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(1200, 370)
  await page.screenshot({ path: 'work/screens/lucent-welcome.png', scale: 'css' })
  await page.getByRole('button', { name: '进入示范文稿' }).click()
  await expect(page.locator('.document-overture')).toBeVisible()
  const paragraph = page.locator('.reader-scroll .section-body p').first()
  const glyph = await paragraph.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode()!
    const range = document.createRange()
    range.setStart(node, 3)
    range.setEnd(node, 4)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.mouse.move(glyph.x, glyph.y)
  await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'text')
  const reader = await page.locator('.reader-scroll').boundingBox()
  await page.mouse.move(reader!.x + reader!.width - 22, glyph.y)
  await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'air')
  await expect(page.locator('.word-afterimage')).toHaveCount(0)
  await page.screenshot({ path: 'work/screens/lucent-reading.png', scale: 'css' })
  await page.locator('.reader-scroll .zmu-ref-mark').first().hover()
  await expect(page.locator('.thought-thread-line')).toBeVisible()
  await page.screenshot({ path: 'work/screens/lucent-thread.png', scale: 'css' })
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page.locator('.theme-choice').filter({ hasText: '星辰' }).click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'astral')
  const astralGlyph = await paragraph.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT),
      node = walker.nextNode()!,
      range = document.createRange()
    range.setStart(node, 3)
    range.setEnd(node, 4)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.mouse.move(astralGlyph.x, astralGlyph.y)
  await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'text')
  await page.mouse.move(reader!.x + reader!.width - 22, astralGlyph.y)
  await expect(page.locator('.word-afterimage').first()).toBeVisible()
  await page.screenshot({ path: 'work/screens/astral-reading.png', scale: 'css' })
  await page.getByRole('button', { name: '回到阅读室', exact: true }).click()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: 'work/screens/astral-welcome.png', scale: 'css' })
  const recovery = await page
    .locator('.optical-field')
    .evaluateHandle((el: HTMLCanvasElement) =>
      el.getContext('webgl')!.getExtension('WEBGL_lose_context')
    )
  await recovery.evaluate((extension) => extension!.loseContext())
  await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'fallback')
  await expect(page.locator('html')).toHaveAttribute('data-cursor-field', 'native')
  await recovery.evaluate((extension) => extension!.restoreContext())
  await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
  await recovery.dispose()
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-optics', 'quiet')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const frozen = await page
    .locator('.optical-field')
    .evaluate((el: HTMLCanvasElement) => el.toDataURL())
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let n = 0
        function frame(): void {
          if (++n === 6) resolve()
          else requestAnimationFrame(frame)
        }
        frame()
      })
  )
  expect(
    await page.locator('.optical-field').evaluate((el: HTMLCanvasElement) => el.toDataURL())
  ).toBe(frozen)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'astral')
  await expect(page.locator('html')).toHaveAttribute('data-optics', 'quiet')
  expect(errors).toEqual([])
})

test('annotation protocol copies the complete instructions and opens a structurally valid example', async () => {
  await page.getByRole('button', { name: 'AI 注释写作协议', exact: true }).click()
  await expect(page.locator('.annotation-dialog')).toBeVisible()
  await page.getByRole('button', { name: '复制写作协议', exact: true }).click()
  await expect(page.locator('.annotation-footer [role=status]')).toHaveText('已复制，可以粘贴给 AI')
  const copied = await readClipboard(app)
  expect(copied.replace(/\r\n/g, '\n')).toBe(
    (await readFile(resolve('docs/ai-annotation-protocol.md'), 'utf8')).replace(/\r\n/g, '\n')
  )
  await page.getByRole('button', { name: '纯渲染约定', exact: true }).click()
  await expect(page.locator('.annotation-content')).toContainText('不规定写作风格')
  await page.getByRole('button', { name: '复制渲染约定', exact: true }).click()
  await expect(page.locator('.annotation-footer [role=status]')).toHaveText('已复制，可以粘贴给 AI')
  expect((await readClipboard(app)).replace(/\r\n/g, '\n')).toBe(
    (await readFile(resolve('docs/renderer-contract.md'), 'utf8')).replace(/\r\n/g, '\n')
  )
  await page.screenshot({ path: 'work/screens/annotation-guide.png', scale: 'css' })
  await page.getByRole('button', { name: '在朱墨中读范例', exact: true }).click()
  await expect(page.locator('.document-overture h1')).toHaveText('一扇门的两种开放')
  await expect(page.locator('.notes-meta')).toContainText('6')
  expect(errors).toEqual([])
})

test('chapter annotations retain their nested branches', async () => {
  await writeFile(
    bookPath,
    '# 原始题目\n\n从这里进入旁注。[^母]\n\n' +
      '这段正文让下一章保持在阅读区域之外。\n\n'.repeat(35) +
      '## 另一章\n\n另一条支线。[^外]\n\n' +
      '[^母]: 母注中继续讨论。[^子]\n\n[^子]: 子注提出新的问题。[^孙]\n\n' +
      '[^孙]: 孙注展开独立理由。\n\n[^外]: 属于另一章的讨论。'
  )
  await openFile()
  await page.getByRole('button', { name: '本章', exact: true }).click()
  await expect(page.locator('.note-card')).toHaveCount(3)
  await expect(page.locator('.note-card[aria-label="子"]')).toBeVisible()
  await page.locator('.note-card[aria-label="母"] .zmu-ref-mark').click()
  await expect(page.getByRole('button', { name: '本章', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.note-card[aria-label="外"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('note journeys restore the departure paragraph and support forward navigation', async () => {
  const parent = Array.from(
    { length: 34 },
    (_, index) =>
      `    母注第 ${index} 段：${'这一段展开不同的判断，让长注拥有充分的阅读空间。'.repeat(3)}${index === 14 ? '离开位置。[^子]' : ''}`
  ).join('\n\n')
  const child = Array.from(
    { length: 18 },
    (_, index) =>
      `    子注第 ${index} 段：${'继续追问自己的问题，读完以后仍能回到来处。'.repeat(3)}`
  ).join('\n\n')
  await writeFile(
    bookPath,
    `# 原始题目\n\n正文引用母注。[^母]\n\n[^母]: 母注开头。\n\n${parent}\n\n[^子]: 子注开头。\n\n${child}`
  )
  await openFile()
  const paragraph = page.locator('.note-card[aria-label="母"] p').filter({ hasText: '离开位置' })
  await paragraph.evaluate((el) => {
    const root = el.closest('.notes-scroll')!
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 100
  })
  const offset = (): Promise<number> =>
    paragraph.evaluate(
      (el) =>
        el.getBoundingClientRect().top - el.closest('.notes-scroll')!.getBoundingClientRect().top
    )
  const before = await offset()
  await paragraph.locator('.zmu-ref-mark').click()
  await expect(page.locator('.note-card.is-reading')).toHaveAttribute('aria-label', '子')
  await expect(page.locator('.note-card[aria-label="子"] p').first()).toBeInViewport()
  await expect(page.getByRole('button', { name: '返回上一注', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '返回上一注', exact: true }).click()
  await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(4)
  await expect(page.getByRole('button', { name: '前进到下一注', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '前进到下一注', exact: true }).click()
  await expect(page.locator('.note-card.is-reading')).toHaveAttribute('aria-label', '子')
  expect(errors).toEqual([])
})

test('a pinned long note can visit a distant virtual child and return to its saved place', async () => {
  const branches = Array.from({ length: 120 }, (_, i) => `[^支线${i}]`).join(' ')
  const definitions = Array.from(
    { length: 120 },
    (_, i) => `[^支线${i}]: 这一条支线有独立内容 ${i}。`
  ).join('\n\n')
  const paragraphs = Array.from(
    { length: 30 },
    (_, i) =>
      `    长注第 ${i} 段。${'仔细展开这里的判断。'.repeat(6)}${i === 12 ? '从此处离开。[^远方]' : ''}`
  ).join('\n\n')
  await writeFile(
    bookPath,
    `# 原始题目\n\n正文。[^母]\n\n[^母]: 这些支线各有入口：${branches}\n\n${paragraphs}\n\n${definitions}\n\n[^远方]: 一百余条支线之后，这条注释确实可以抵达。`
  )
  await openFile()
  await page.getByRole('button', { name: '固定注释 母', exact: true }).click()
  await page.getByRole('button', { name: '固定 1', exact: true }).click()
  const paragraph = page.locator('.note-card[aria-label="母"] p').filter({ hasText: '从此处离开' })
  await paragraph.evaluate((el) => {
    const root = el.closest('.notes-scroll')!
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 90
  })
  const offset = (): Promise<number> =>
    paragraph.evaluate(
      (el) =>
        el.getBoundingClientRect().top - el.closest('.notes-scroll')!.getBoundingClientRect().top
    )
  const before = await offset()
  await paragraph.locator('.zmu-ref-mark').click()
  await expect(page.locator('.note-card[aria-label="远方"] .zmu-note-body')).toBeInViewport()
  expect(await page.locator('.note-card').count()).toBeLessThan(25)
  await page.getByRole('button', { name: '返回上一注', exact: true }).click()
  await expect(page.getByRole('button', { name: '固定 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect.poll(async () => Math.abs((await offset()) - before)).toBeLessThan(4)
  await page.getByRole('button', { name: '前进到下一注', exact: true }).click()
  await expect(page.locator('.note-card[aria-label="远方"] .zmu-note-body')).toBeInViewport()
  expect(errors).toEqual([])
})

test('identically named headings navigate to distinct locations and filter their own notes', async () => {
  await writeFile(
    bookPath,
    '# 原始题目\n\n## 同名小节\n\n第一处的内容[^一]。\n\n' +
      '隔开的正文段落，有足够距离判断跳转的目标。\n\n'.repeat(45) +
      '## 同名小节\n\n第二处的内容[^二]。\n\n' +
      '后面的正文。\n\n'.repeat(12) +
      '[^一]: 第一节的注释。\n\n[^二]: 第二节的注释。'
  )
  await openFile()
  await page.locator('.toc-item').filter({ hasText: '同名小节' }).nth(1).click()
  await expect(page.locator('.reader-scroll [data-toc-id="toc-3"]')).toBeInViewport()
  await expect(page.locator('.reader-scroll [data-toc-id="toc-2"]')).not.toBeInViewport()
  await page.getByRole('button', { name: '本章', exact: true }).click()
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.locator('.note-card')).toHaveAttribute('aria-label', '二')
  await page.locator('.toc-item').filter({ hasText: '原始题目' }).click()
  await expect
    .poll(() => page.locator('.reader-scroll').evaluate((el) => el.scrollTop))
    .toBeLessThan(2)
  expect(errors).toEqual([])
})
