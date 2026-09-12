import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
import type { SyntaxTarget } from '../../src/shared/syntax-passages'

test('color ranges survive cross-line mixed text and remounts, preserve formula glyphs, and a live theme switch selects a new cached palette', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-color-mixed-')),
    profile = join(root, 'profile'),
    file = join(root, '光不改写原句.md')
  const phrase =
    '判断一个概念是否已经改变，需要同时辨明说话者所承担的承诺、转述中保留的距离以及推理真正依赖的限制条件'
  const source = `# 光不改写原句\n\n自由并不是任意。${phrase}。若 $x>0$ 成立，表达式 \`f(x)\` 才进入这个讨论；**自由**与[自由](https://example.com)在不同结构中仍保持自己的字形。\n`
  const requests: string[] = []
  let app: ElectronApplication | undefined
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()),
        input = JSON.parse(body.messages.at(-1).content)
      const dark = input.readingAppearance.theme === 'chaosheng'
      requests.push(input.readingAppearance.theme)
      const mark = (quote: string, occurrence = 1): unknown => ({
        type: 'mark',
        quote,
        occurrence,
        textColor: dark ? '#bcdff5' : '#386491',
        glowColor: '#e7bd91'
      })
      const math = (input.syntaxTarget as SyntaxTarget).regions.find((r) => r.kind === 'math')!
      const records = [
        { type: 'begin', version: 4 },
        mark(phrase),
        mark('转述'),
        mark('f(x)'),
        mark(input.selectedText.slice(math.start, math.end)),
        mark('自由', 2),
        mark('自由', 3),
        { type: 'done' }
      ]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: records.map((r) => JSON.stringify(r)).join('\n') } }]
          }) +
          '\n\n'
      )
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await mkdir(profile)
    await writeFile(file, source)
    await writeFile(
      join(profile, 'ai-models.v1.json'),
      JSON.stringify({
        version: 1,
        syntax: {
          revision: 'mixed-color-fixture',
          settings: {
            ...defaultAiProfile('syntax'),
            model: 'fixed-color-response',
            context: 'selection',
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
          }
        }
      })
    )
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
      env: { ...process.env, ZHUMO_USER_DATA: profile }
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 1050))
    await page.locator('.space-swatches').getByRole('button', { name: '琉璃', exact: true }).click()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    const paragraph = page.locator('.reader-scroll .section-body p')
    await expect(paragraph.locator('.zmu-math')).toHaveCount(1)
    await page.evaluate(() => document.fonts.ready)
    const original = await paragraph.locator('[data-source-inline]').first().innerHTML()
    await expect.poll(() => requests.length, { timeout: 11000 }).toBe(1)
    await expect.poll(() => page.locator('.reading-color-mark').count()).toBeGreaterThan(7)
    const formula = page.locator('.reading-color-mark[data-quote="x>0"]')
    await expect(formula).toHaveCount(1)
    const ranges = async (): Promise<
      Array<{ text: string; color: string; math: boolean; lines: number }>
    > =>
      page.evaluate(() =>
        [...CSS.highlights]
          .filter(([name]) => name.startsWith('zhumo-reading-color-'))
          .flatMap(([name, highlight]) =>
            [...highlight].map((r) => {
              const range = r as Range,
                parent = range.startContainer.parentElement!
              return {
                text: range.toString(),
                color: getComputedStyle(parent, `::highlight(${name})`).color,
                math: Boolean(parent.closest('.zmu-math')),
                lines: range.getClientRects().length
              }
            })
          )
      )
    await expect.poll(async () => (await ranges()).filter((r) => r.text === '自由').length).toBe(2)
    await expect.poll(async () => (await ranges()).filter((r) => r.text === 'f(x)').length).toBe(1)
    await expect.poll(async () => (await ranges()).some((r) => r.lines > 1)).toBe(true)
    expect((await ranges()).some((r) => r.math)).toBe(false)
    // The decorative surface is a sibling of the exact original source subtree.
    expect(await paragraph.locator('[data-source-inline]').first().innerHTML()).toBe(original)
    const before = (await ranges()).map((r) => r.text).sort()
    await paragraph.evaluate((p) => p.replaceWith(p.cloneNode(true)))
    await expect.poll(async () => (await ranges()).map((r) => r.text).sort()).toEqual(before)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 1050))
    await expect.poll(async () => (await ranges()).map((r) => r.text).sort()).toEqual(before)
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: '潮光' }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.locator('.reading-color-mark')).toHaveCount(0)
    await expect.poll(() => requests, { timeout: 11000 }).toEqual(['lucent', 'chaosheng'])
    await expect.poll(async () => (await ranges()).map((r) => r.text).sort()).toEqual(before)
    await expect
      .poll(async () => (await ranges()).every((r) => r.color === 'rgb(188, 223, 245)'))
      .toBe(true)
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: '琉璃' }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect
      .poll(async () => (await ranges()).map((r) => r.text).sort(), { timeout: 11000 })
      .toEqual(before)
    expect(requests).toEqual(['lucent', 'chaosheng'])
    await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
    await page.getByRole('button', { name: '光影：静谧', exact: true }).click()
    await expect(page.locator('.reading-color-mark')).toHaveCount(0)
    await expect.poll(ranges).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(source)
    expect(errors).toEqual([])
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
