import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
test('dark theme PDF renders diagrams and wide mathematics, and preserves a long annotation', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-pdf-layout-')),
    file = join(root, '排版边界.md'),
    pdf = resolve('work/documents/潮光-排版边界.pdf')
  await mkdir('work/documents', { recursive: true })
  const wide = Array.from({ length: 28 }, (_, i) => 'x_{' + i + '}').join('+') + '=0'
  const source =
    '# 排版边界\n\n正文从此开始。[^long]\n\n' +
    (await readFile('docs/markdown-compatibility-sample.md', 'utf8')) +
    '\n\n```mermaid\nflowchart LR\n A[文字] --> B[关系] --> C[理解]\n```\n\n\\[\n' +
    wide +
    '\n\\]\n\n[^long]: ' +
    '注释也应跨过纸页，完整保留每个字句。'.repeat(65) +
    '长注终点。\n\n## 全文终点\n\n海与光都在此处。'
  await writeFile(file, source)
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(() => localStorage.setItem('zhumo.studio.theme', 'chaosheng'))
    await page.reload()
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.document-overture h1')).toHaveText('排版边界')
    await app.evaluate(({ dialog, app }, pdf) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdf })
      app.on('browser-window-created', (_event, window) => {
        const print = window.webContents.printToPDF.bind(window.webContents)
        window.webContents.printToPDF = async (options) => {
          const geometry = await window.webContents.executeJavaScript(
            `({viewport:innerWidth,body:document.body.scrollWidth,root:document.querySelector('.pdf-document').scrollWidth,items:[...document.querySelectorAll('.section-body,.pdf-columns,table,.zmu-diagram,.zmu-math-block')].map(el=>({tag:el.tagName,cls:el.className,width:el.clientWidth,scroll:el.scrollWidth,box:el.getBoundingClientRect().toJSON(),zoom:getComputedStyle(el).zoom,parent:el.parentElement.clientWidth,parentDisplay:getComputedStyle(el.parentElement).display}))})`
          )
          ;(globalThis as { pdfGeometry?: unknown }).pdfGeometry = geometry
          return print(options)
        }
      })
      app.on('browser-window-created', (_event, window) =>
        window.webContents.once('did-finish-load', () => {
          if (window.webContents.getURL().includes('zhumo-pdf-'))
            void window.webContents
              .executeJavaScript(
                `(async()=>{await document.fonts.ready;return {width:innerWidth,diagram:document.querySelectorAll('.zmu-diagram svg').length,background:getComputedStyle(document.querySelector('.pdf-background')).backgroundImage!=='none',text:document.body.textContent}})()`
              )
              .then((result) => {
                ;(globalThis as { pdfLayout?: unknown }).pdfLayout = result
              })
        })
      )
    }, pdf)
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '导出 PDF', exact: true })
    await panel.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect(panel).not.toBeVisible({ timeout: 60000 })
    const observed = await app.evaluate(
      () =>
        (
          globalThis as {
            pdfLayout?: { width: number; diagram: number; background: boolean; text: string }
          }
        ).pdfLayout
    )
    expect(observed?.width).toBe(688)
    expect(observed?.diagram).toBe(1)
    expect(observed?.background).toBe(true)
    expect(observed?.text).toContain('长注终点')
    expect(observed?.text).toContain('海与光都在此处')
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
    await writeFile('work/documents/layout-verification.json', JSON.stringify(observed, null, 2))
    const geometry = await app.evaluate(
      () =>
        (globalThis as { pdfGeometry?: { viewport: number; body: number; root: number } })
          .pdfGeometry
    )
    expect(geometry!.body).toBeLessThanOrEqual(geometry!.viewport + 1)
    expect(geometry!.root).toBeLessThanOrEqual(geometry!.viewport + 1)
    const paper = resolve('work/documents/纸面-排版边界.pdf')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, paper)
    await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await panel.locator('select').first().selectOption('paper')
    await panel.getByRole('button', { name: '导出 PDF', exact: true }).click()
    await expect(panel).not.toBeVisible({ timeout: 60000 })
    expect((await readFile(paper)).subarray(0, 5).toString()).toBe('%PDF-')
    await writeFile('work/documents/layout-geometry.json', JSON.stringify(geometry, null, 2))
  } finally {
    await app.close()
  }
})
