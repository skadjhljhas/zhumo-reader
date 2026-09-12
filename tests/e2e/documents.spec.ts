import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, assertBackgroundWindow } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { epubFiles, zipFixture } from '../epub-fixture'
import { createServer } from 'node:http'
import { defaultAiProfile } from '../../src/shared/ai-types'
test.beforeEach(async () => {
  await mkdir('work/documents', { recursive: true })
})
async function start(profile: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: profile }
  })
}
test('new Markdown starts focused, saves in the default manuscript folder, and recovers an unsaved new draft after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-new-md-')),
    profile = join(root, 'profile'),
    saved = join(root, '新文稿.md')
  let app = await start(profile)
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '新建 Markdown', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
    await expect(editor).toBeFocused()
    await page.keyboard.insertText('# 第一份新文稿\n\n直接开始写作。')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.SaveDialogOptions
        if (!options?.defaultPath?.endsWith('.md')) throw Error('Missing default Markdown location')
        return { canceled: false, filePath: file }
      }
    }, saved)
    await page.keyboard.press('Control+s')
    await expect
      .poll(async () => readFile(saved, 'utf8').catch(() => ''))
      .toContain('直接开始写作。')
    await page.keyboard.press('Control+n')
    await expect(editor).toHaveText('')
    await expect(editor).toBeFocused()
    await page.keyboard.insertText('# 尚未落盘的文字\n\n这段新文稿应能恢复。')
    await page.waitForTimeout(900)
    await app.evaluate(({ app }) => app.exit(0))
    app = await start(profile)
    page = await app.firstWindow()
    await page.locator('.untitled-drafts .recent-book').first().click()
    await expect(
      page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
    ).toContainText('这段新文稿应能恢复。')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  }
})
test('EPUB opens with spine navigation, illustration, shared footnotes and no executable publication content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-epub-ui-')),
    file = join(root, '有光的书.epub')
  await zipFixture(file, epubFiles())
  const before = await readFile(file)
  const calls: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (part) => chunks.push(part))
    req.on('end', () => {
      const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content)
      calls.push(input)
      const records: unknown[] = [{ type: 'begin', version: 4 }]
      if (input.selectedText.includes('文字'))
        records.push({
          type: 'mark',
          quote: '文字',
          occurrence: 1,
          textColor: '#27468f',
          glowColor: '#e7bd91'
        })
      records.push({ type: 'done' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: { content: records.map((record) => JSON.stringify(record)).join('\n') },
                finish_reason: 'stop'
              }
            ]
          }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const app = await start(join(root, 'profile'))
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.evaluate((profile) => window.ai!.saveProfile('syntax', profile), {
      ...defaultAiProfile('syntax'),
      model: 'epub-fixture',
      context: 'full' as const,
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    })
    await page.reload()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.document-overture h1')).toHaveText('来自书页的光')
    await expect(page.locator('.reader-scroll .zmu-ref')).toHaveCount(2)
    await expect(page.locator('.note-card')).toHaveCount(1)
    await expect(page.locator('.note-card .zmu-note-body')).toContainText(
      '这是来自 EPUB 的第一条注释。'
    )
    expect(await page.evaluate(() => Object.hasOwn(window, 'epubInjected'))).toBe(false)
    expect(
      await page
        .locator('.reader-scroll img')
        .first()
        .evaluate((img) => (img as HTMLImageElement).naturalWidth)
    ).toBe(360)
    await expect(
      page.locator('.reading-color-light:has(.reading-color-mark[data-quote="文字"])').first()
    ).toBeVisible({
      timeout: 15000
    })
    expect(JSON.stringify(calls)).toContain('这是来自 EPUB 的第一条注释。')
    await page.locator('.reader-scroll a').filter({ hasText: '去第二章' }).click()
    await expect(page.locator('.reader-scroll h1').filter({ hasText: '再读一遍' })).toBeInViewport()
    await page.getByRole('button', { name: '再读一遍', exact: true }).click()
    await page.keyboard.press('Control+s')
    expect(await readFile(file)).toEqual(before)
    expect(errors).toEqual([])
    const epubPdf = resolve('work/documents/EPUB-导出.pdf')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, epubPdf)
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
    const exportPanel = page.getByRole('dialog', { name: '导出 PDF', exact: true })
    await exportPanel.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect(exportPanel).not.toBeVisible({ timeout: 60000 })
    expect((await readFile(epubPdf)).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await readFile(file)).toEqual(before)
    await page.screenshot({ path: 'work/documents/epub-reading.png' })
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
test('theme PDF export contains the whole manuscript and notes, and uses an invisible print window', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-pdf-ui-')),
    file = join(root, '光与文字.md'),
    pdf = resolve('output/pdf/朱墨-琉璃主题导出.pdf')
  await mkdir('output/pdf', { recursive: true })
  const source =
    '# 光与文字\n\n文字留在原处，光从字缝间经过。[^a]\n\nLucent · Reading as a form of attention.\n\n' +
    Array.from(
      { length: 8 },
      (_, i) =>
        '## 第' +
        (i + 1) +
        '章\n\n' +
        '阅读不是将一页文字据为己有，而是允许它在我们之中改变形状。光照亮纸张，也照亮那些尚未说出的关联。\n\n'.repeat(
          5
        )
    ).join('\n') +
    '\n\n[^a]: 这是一条必须完整出现在 PDF 里的注释。\n\n## 终点\n\n这里是全文最终标记：仍有余光。\n'
  await writeFile(file, source)
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const input = JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content)
      const records: unknown[] = [{ type: 'begin', version: 4 }]
      if (input.selectedText.includes('文字留在原处'))
        records.push({
          type: 'mark',
          quote: '文字',
          occurrence: 1,
          textColor: '#27468f',
          glowColor: '#e7bd91'
        })
      records.push({ type: 'done' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: { content: records.map((x) => JSON.stringify(x)).join('\n') },
                finish_reason: 'stop'
              }
            ]
          }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const app = await start(join(root, 'profile'))
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1030))
    await page.evaluate(() => localStorage.setItem('zhumo.studio.theme', 'lucent'))
    await page.evaluate((profile) => window.ai!.saveProfile('syntax', profile), {
      ...defaultAiProfile('syntax'),
      model: 'pdf-fixture',
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    })
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ['C:/Windows/Fonts/times.ttf']
      })
    })
    const fontId = await page.evaluate(async () => {
      const font = await window.api.importFont()
      if (!font) throw Error('font')
      await window.api.saveSettings({ ...(await window.api.getSettings()), bodyFont: font.font.id })
      return font.font.id
    })
    await page.reload()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.document-overture h1')).toHaveText('光与文字')
    await expect(
      page.locator('.reading-color-light:has(.reading-color-mark[data-quote="文字"])')
    ).toBeVisible({
      timeout: 16000
    })
    await app.evaluate(({ app }) => {
      app.on('browser-window-created', (_event, window) => {
        window.webContents.once('did-finish-load', () => {
          if (window.webContents.getURL().includes('zhumo-pdf-'))
            void window.webContents
              .executeJavaScript(
                `(async()=>{await document.fonts.ready;return {inkCount:document.querySelectorAll('.pdf-ink').length,font:getComputedStyle(document.querySelector('.section-body')).fontFamily}})()`
              )
              .then((result) => {
                ;(globalThis as { pdfObservation?: unknown }).pdfObservation = result
              })
        })
      })
    })
    await app.evaluate(({ dialog }, pdf) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf })
    }, pdf)
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '导出 PDF', exact: true })
    await expect(panel.locator('select').first()).toHaveValue('theme')
    await panel.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect(panel).not.toBeVisible({ timeout: 60000 })
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await readFile(file, 'utf8')).toBe(source)
    const observed = await app.evaluate(
      () => (globalThis as { pdfObservation?: { inkCount: number; font: string } }).pdfObservation
    )
    expect(observed?.inkCount).toBeGreaterThan(0)
    expect(observed?.font).toContain('ZhuMoFont_' + fontId)
    await assertBackgroundWindow(app)
    await writeFile('work/documents/pdf-source.txt', source)
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
