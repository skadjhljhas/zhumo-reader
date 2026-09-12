import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { electron, readClipboard } from './runtime'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { defaultAiProfile } from '../../src/shared/ai-types'
import { READING_THEME_NAMES } from './theme-catalog'
let app: ElectronApplication,
  page: Page,
  root: string,
  file: string,
  source: string,
  server: Server,
  endpoint: string,
  requests: Record<string, unknown>[]
const original =
  '\uFEFF# 从字句开始\r\n\r\n门槛，门槛。\r\n\r\n前往**远方**[^甲]，再回来。\r\n\r\n[^甲]: 旁注里的门槛。\r\n'
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()),
        user = JSON.parse(body.messages.at(-1).content)
      requests.push(user)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: '**解释**：这是一段固定接口响应。' } }]
          }) +
          '\n\n'
      )
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
      )
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1'
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
})
async function launch(): Promise<void> {
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}
test.beforeEach(async () => {
  requests = []
  root = await mkdtemp(join(tmpdir(), 'zhumo-selection15-'))
  file = join(root, '从字句开始.md')
  source = original
  await writeFile(file, source)
  await launch()
  await mkdir('work/selection15', { recursive: true })
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function preferences(note: boolean, explain: boolean, copy: boolean): Promise<void> {
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '阅读设置', exact: true })
  await panel.getByLabel('写用户注释', { exact: true }).setChecked(note)
  await panel.getByLabel('自动解释', { exact: true }).setChecked(explain)
  await panel.getByLabel('自动复制', { exact: true }).setChecked(copy)
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
}
async function select(locator: Locator, text = ''): Promise<void> {
  const outside = await page.evaluate(() => ({ x: innerWidth - 5, y: innerHeight - 5 }))
  await page.mouse.click(outside.x, outside.y)
  await locator.scrollIntoViewIfNeeded()
  await locator.evaluate((el, text) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    if (text) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const at = node.textContent!.lastIndexOf(text)
        if (at >= 0) {
          r.setStart(node, at)
          r.setEnd(node, at + text.length)
          break
        }
      }
    }
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  }, text)
}
async function configure(): Promise<void> {
  await page.evaluate(
    async ({ endpoint, profile }) => {
      await window.ai!.saveProfile('reading', {
        ...profile,
        endpoint,
        model: 'selection-fixture',
        apiKey: 'fixture-not-a-real-key'
      })
    },
    { endpoint, profile: defaultAiProfile('reading') }
  )
}
const paragraph = (): Locator => page.locator('.reader-scroll .section-body p').first()
test('all eight global combinations control one surface and silent copying, and zero keeps native selection', async () => {
  await configure()
  for (let mask = 0; mask < 8; mask++) {
    await preferences(!!(mask & 1), !!(mask & 2), !!(mask & 4))
    await select(paragraph(), '门槛')
    await page.waitForTimeout(420)
    await expect(page.locator('.reading-selection')).toHaveCount(mask & 3 ? 1 : 0)
    await expect(page.getByRole('textbox', { name: '用户注释', exact: true })).toHaveCount(
      mask & 1 ? 1 : 0
    )
    await expect(page.locator('.automatic-explanation')).toHaveCount(mask & 2 ? 1 : 0)
    if (mask & 1)
      await expect(page.getByRole('textbox', { name: '用户注释', exact: true })).toBeFocused()
    if (mask & 4) expect(await readClipboard(app)).toBe('门槛')
    if (mask === 0)
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('门槛')
  }
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('Enter saves a user note at the exact repeated occurrence, and hover restores the full range after reopening', async () => {
  await preferences(true, false, false)
  await select(paragraph(), '门槛')
  const input = page.getByRole('textbox', { name: '用户注释', exact: true })
  await expect(input).toBeFocused()
  await input.fill('这一处的注释。')
  await input.press('Enter')
  await expect(page.locator('.reading-selection')).toHaveCount(0)
  const saved = await readFile(file, 'utf8')
  expect(saved).toContain('门槛，门槛[^用户注释:1]。\r\n')
  expect(saved).toContain('[^用户注释:1]: 这一处的注释。')
  expect(saved.startsWith('\uFEFF')).toBe(true)
  const previousReader = await page.locator('.reader-scroll').elementHandle()
  await page.getByRole('button', { name: '打开书籍', exact: true }).click()
  await expect.poll(() => previousReader!.evaluate((el) => el.isConnected)).toBe(false)
  const reference = page.locator('.reader-scroll .zmu-ref-mark').first()
  await reference.hover()
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(CSS.highlights.get('zhumo-note-range') ?? [])].map((r) => r.toString())
      )
    )
    .toEqual(['门槛'])
  await page.locator('.reader-scroll').evaluate((el) => el.dispatchEvent(new Event('scroll')))
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(CSS.highlights.get('zhumo-note-range') ?? [])].map((r) => r.toString())
      )
    )
    .toEqual(['门槛'])
  await page.mouse.move(2, 2)
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('zhumo-note-range') ?? [])].length))
    .toBe(0)
  await expect(page.locator('.notes-scroll')).toContainText('用户注释')
  await expect(page.locator('.cm-editor')).toHaveCount(0)
})
test('IME Enter does not save, Shift Enter makes a newline, and closing preserves an unfinished draft', async () => {
  await preferences(true, false, false)
  await select(paragraph(), '门槛')
  const input = page.getByRole('textbox', { name: '用户注释', exact: true })
  await expect(input).toBeFocused()
  await input.fill('输入法')
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  expect(await readFile(file, 'utf8')).toBe(source)
  await input.dispatchEvent('compositionend')
  await input.fill('第一行')
  await input.press('Shift+Enter')
  await page.keyboard.insertText('第二行')
  await page.keyboard.press('Escape')
  await select(paragraph(), '门槛')
  await expect(input).toHaveValue('第一行\n第二行')
  await input.press('Enter')
  await expect.poll(() => readFile(file, 'utf8')).toContain('[^用户注释:1]: 第一行\r\n    第二行')
})
test('annotation and explanation share a compact surface; reselecting hits the persistent result cache', async () => {
  await configure()
  await preferences(true, true, true)
  await select(paragraph(), '门槛')
  await expect(page.locator('.auto-explanation-content')).toContainText('固定接口响应')
  await expect(page.locator('.reading-selection')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '问 AI', exact: true })).toHaveCount(0)
  await expect(page.locator('.selection-quote')).toHaveCount(0)
  expect(requests).toHaveLength(1)
  await page.screenshot({ path: 'work/selection15/注释与解释.png' })
  await page.keyboard.press('Escape')
  await select(paragraph(), '门槛')
  await expect(page.locator('.auto-explanation-content')).toContainText('固定接口响应')
  expect(requests).toHaveLength(1)
  await app.close()
  await launch()
  await select(paragraph(), '门槛')
  await expect(page.locator('.auto-explanation-content')).toContainText('固定接口响应')
  expect(requests).toHaveLength(1)
})
test('automatic explanation sends the exact selection and intact Markdown with model-default context', async () => {
  source =
    '# 上文\n\n' +
    ('前'.repeat(150) + '\n\n').repeat(700) +
    '\n\n# 目标\n\n选择这句话。\n\n# 后文\n\n' +
    ('后'.repeat(150) + '\n\n').repeat(700)
  await writeFile(file, source)
  await page.getByRole('button', { name: '打开书籍', exact: true }).click()
  await configure()
  await preferences(false, true, false)
  if (!(await page.locator('.toc-drawer').isVisible()))
    await page.getByRole('button', { name: '切换目录', exact: true }).click()
  await page.locator('.toc-item').filter({ hasText: '目标' }).first().click()
  if (await page.getByRole('button', { name: '收起目录', exact: true }).isVisible())
    await page.getByRole('button', { name: '收起目录', exact: true }).click()
  await page.evaluate(() => document.fonts.ready)
  let previousTop = -1,
    stable = 0
  await expect
    .poll(
      async () => {
        const top = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
        stable = Math.abs(top - previousTop) < 0.5 ? stable + 1 : 0
        previousTop = top
        return stable
      },
      { intervals: [100], timeout: 5000 }
    )
    .toBeGreaterThanOrEqual(3)
  await select(
    page.locator('.reader-scroll .section-body p').filter({ hasText: '选择这句话。' }),
    '选择这句话'
  )
  await expect(page.locator('.auto-explanation-content')).toContainText('固定接口响应')
  const request = requests[0] as {
    selectedText: string
    markdown: string
  }
  expect(request.selectedText).toBe('选择这句话')
  expect(request.markdown).toBe(source)
  expect(request.markdown.length).toBeGreaterThan(200000)
  expect(request).not.toHaveProperty('markdownContext')
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('formatted selections and nested notes keep their original markup and receive user identity', async () => {
  await preferences(true, false, false)
  await select(page.locator('.reader-scroll .section-body p').nth(1))
  const input = page.getByRole('textbox', { name: '用户注释', exact: true })
  await input.fill('整段的想法。')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  const first = await readFile(file, 'utf8')
  expect(first).toContain('前往**远方**[^甲]，再回来。[^用户注释:1]')
  await select(
    page.locator('.notes-scroll .zmu-note-body p').filter({ hasText: '旁注里的门槛。' }),
    '门槛'
  )
  await expect(input).toBeFocused()
  await input.fill('给旁注的注释。')
  await input.press('Enter')
  await expect.poll(() => readFile(file, 'utf8')).toContain('[^甲]: 旁注里的门槛[^用户注释:2]。')
})
test('all nine themes keep the simple note input and save hint inside a compact viewport', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await preferences(true, false, false)
  for (const name of READING_THEME_NAMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: name }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await select(paragraph(), '门槛')
    await expect(page.getByRole('textbox', { name: '用户注释', exact: true })).toBeInViewport({
      ratio: 1
    })
    expect(
      await page.locator('.reading-selection').evaluate((el) => el.scrollWidth - el.clientWidth)
    ).toBeLessThanOrEqual(1)
  }
})
test('external file changes fail safely and leave the typed note recoverable', async () => {
  await preferences(true, false, false)
  await select(paragraph(), '门槛')
  const input = page.getByRole('textbox', { name: '用户注释', exact: true })
  await input.fill('不要丢失。')
  await writeFile(file, source + '\r\n外部新内容。')
  await input.press('Enter')
  await expect(page.locator('.selection-error')).toBeVisible()
  await expect(input).toHaveValue('不要丢失。')
  expect(await readFile(file, 'utf8')).toBe(source + '\r\n外部新内容。')
})
