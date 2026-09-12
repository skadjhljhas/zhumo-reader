import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
let app: ElectronApplication,
  page: Page,
  root: string,
  file: string,
  server: Server,
  endpoint: string
let requests: Array<{
    model: string
    messages: Array<{ content: string }>
    [key: string]: unknown
  }> = [],
  replies: ServerResponse[] = []
const quote = '海风轻轻翻开书页，月光停在行间。'
const unit = (id: string, text: string, role: string): Record<string, unknown> => ({
  id,
  layer: 'syntax',
  role,
  label: role,
  anchors: [{ quote: text, occurrence: 1 }],
  explanation: '本句的结构成分。',
  evidence: '逐字依据原文。',
  status: 'supported'
})
const relation = (id: string, from: string, to: string[]): Record<string, unknown> => ({
  id,
  from,
  to,
  kind: 'dependency',
  label: '句法主干',
  explanation: '核心谓词连接它的论元。',
  evidence: '原文中的主谓宾关系。',
  status: 'supported'
})
const patch = {
  type: 'patch',
  units: [
    unit('s1', '海风', 'subject'),
    unit('v1', '翻开', 'predicate'),
    unit('o1', '书页', 'object')
  ],
  relations: [relation('r1', 'v1', ['s1', 'o1'])]
}
function send(res: ServerResponse, delta: Record<string, string>): void {
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n')
}
function content(res: ServerResponse, value: unknown): void {
  send(res, { content: JSON.stringify(value) + '\n' })
}
function finish(res: ServerResponse): void {
  content(res, { type: 'done', summary: '本句主干完成。' })
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.end('data: [DONE]\n\n')
}
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      replies.push(res)
      send(res, { reasoning_content: '固定思考流：先对应谓词与论元，再补充第二分句。' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1'
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})
async function launch(): Promise<void> {
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  // Simulate foreground reading in an offscreen window; no real desktop focus is taken.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll .section-body p').first()).toContainText(quote)
  await page.evaluate(() => document.fonts.ready)
}
test.beforeEach(async () => {
  requests = []
  replies = []
  root = await mkdtemp(join(tmpdir(), 'zhumo-stream16-'))
  file = join(root, '显影.md')
  await mkdir(join(root, 'profile'))
  await writeFile(file, '# 等待一道光\n\n' + quote + '\n')
  await writeFile(
    join(root, 'profile', 'ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'syntax-fixture',
        settings: {
          ...defaultAiProfile('syntax'),
          endpoint,
          model: 'syntax-fixture',
          context: 'full',
          thinkingMode: 'enabled',
          reasoningEffort: 'low'
        }
      },
      reading: {
        revision: 'reading-fixture',
        settings: {
          ...defaultAiProfile('reading'),
          endpoint,
          model: 'reading-fixture',
          thinkingMode: 'enabled',
          reasoningEffort: 'high'
        }
      }
    })
  )
  await mkdir('work/stream16', { recursive: true })
  await launch()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  server.closeAllConnections()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function select(): Promise<void> {
  const paragraph = page.locator('.reader-scroll .section-body p').first()
  // Capture/release the same native range as a real drag, keeping the native selection intact.
  await paragraph.dispatchEvent('pointerdown', { button: 0 })
  await paragraph.evaluate((el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  })
  await paragraph.dispatchEvent('pointerup', { button: 0 })
}
test('a real stream paints the first validated batch before done, preserves the native selection, and adds the next relation softly', async () => {
  await select()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    max_tokens: 32768,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low'
  })
  const user = JSON.parse(requests[0].messages.at(-1)!.content)
  expect(user.selectedText).toBe(quote)
  expect(user.markdownContext.before).toContain('# 等待一道光')
  content(replies[0], { type: 'begin', version: 3 })
  content(replies[0], patch)
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(quote)
  expect(replies[0].writableEnded).toBe(false)
  const opacity = await page
    .locator('.automatic-syntax-light .syntax-band-emergence')
    .first()
    .evaluate((e) => Number(getComputedStyle(e).opacity))
  expect(opacity).toBeLessThan(0.9)
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await page.getByRole('tab', { name: '句法之光', exact: true }).click()
  await expect(page.getByLabel('模型返回的思考内容')).toContainText('固定思考流')
  await page.getByRole('button', { name: '收起 AI 细读' }).click()
  content(replies[0], {
    type: 'patch',
    units: [
      unit('s2', '月光', 'subject'),
      unit('v2', '停', 'predicate'),
      unit('o2', '在行间', 'adverbial')
    ],
    relations: [relation('r2', 'v2', ['s2', 'o2'])]
  })
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(6)
  finish(replies[0])
  await expect(page.getByRole('button', { name: '查看自动句法进度' })).toHaveText('句法之光')
  await expect
    .poll(() =>
      page
        .locator('.automatic-syntax-light .syntax-band-emergence')
        .last()
        .evaluate((e) => Number(getComputedStyle(e).opacity))
    )
    .toBe(1)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.screenshot({ path: 'work/stream16/first-and-following-batches.png' })
  const paint = await page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>(
      '.automatic-syntax-light .syntax-veil-halo'
    )!
    const band = path.closest('g.syntax-relation-band')!
    const ink = document.createRange()
    ink.selectNodeContents(document.querySelector('.reader-scroll .section-body p')!)
    const box = ink.getBoundingClientRect()
    window.requestAnimationFrame = () => 0
    for (const canvas of document.querySelectorAll('canvas')) canvas.style.visibility = 'hidden'
    for (const a of document.getAnimations()) a.pause()
    return {
      fill: getComputedStyle(path).fill,
      path: getComputedStyle(path).d,
      bbox: {
        x: path.getBBox().x,
        y: path.getBBox().y,
        width: path.getBBox().width,
        height: path.getBBox().height
      },
      opacity: getComputedStyle(band).opacity,
      clip: {
        x: Math.floor(box.x - 24),
        y: Math.floor(box.y - 24),
        width: Math.ceil(box.width + 48),
        height: Math.ceil(box.height + 54)
      }
    }
  })
  await page.waitForTimeout(120)
  const lit = await page.screenshot({ path: 'work/stream16/paint-isolation.png' })
  await page.locator('.automatic-syntax-light').evaluate((el) => {
    ;(el as SVGElement).style.visibility = 'hidden'
  })
  const bare = await page.screenshot()
  const pixels = await page.evaluate(
    async ({ lit, bare, clip }) => {
      let width = 0
      const read = async (bytes: string): Promise<Uint8ClampedArray> => {
        const img = new Image()
        await new Promise<void>((done) => {
          img.onload = () => done()
          img.src = 'data:image/png;base64,' + bytes
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        width = img.width
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const a = await read(lit),
        b = await read(bare)
      let changed = 0,
        peak = 0
      for (let y = clip.y; y < clip.y + clip.height; y++)
        for (let x = clip.x; x < clip.x + clip.width; x++) {
          const i = (y * width + x) * 4
          const d = Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2])
          )
          if (d >= 2) changed++
          peak = Math.max(peak, d)
        }
      return { changed, peak }
    },
    { lit: lit.toString('base64'), bare: bare.toString('base64'), clip: paint.clip }
  )
  await writeFile('work/stream16/paint.json', JSON.stringify({ ...paint, pixels }, null, 2))
  expect(pixels.changed).toBeGreaterThan(300)
  expect(pixels.peak).toBeGreaterThan(4)
  await page.locator('.automatic-syntax-light').evaluate((el) => {
    ;(el as SVGElement).style.visibility = 'visible'
  })
  await app.evaluate(({ app }) => app.exit(0))
  await launch()
  await select()
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(6)
  expect(requests).toHaveLength(1)
})
test('five seconds of foreground visibility start analysis without selection; hidden time does not count', async () => {
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  )
  await page.waitForTimeout(6000)
  expect(requests).toHaveLength(0)
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  )
  await page.waitForTimeout(3000)
  expect(requests).toHaveLength(0)
  await expect.poll(() => requests.length, { timeout: 4000 }).toBe(1)
  content(replies[0], { type: 'begin', version: 3 })
  content(replies[0], patch)
  finish(replies[0])
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true)
})

test('simple and code modes remain distinct; saved request-body code starts automatic syntax without a special budget control', async () => {
  await page.getByRole('button', { name: '查看自动句法进度' }).click()
  await page.getByRole('button', { name: '句法模型设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI 模型与提示词' })
  await dialog.getByLabel('模型名', { exact: true }).fill('')
  await expect(dialog.getByText('限制思考长度，让正式结果更早抵达', { exact: true })).toHaveCount(0)
  await dialog.getByRole('tab', { name: '代码模式', exact: true }).click()
  await expect(dialog.getByLabel('模型名', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '填入代码模板' }).click()
  const bodyCode =
    'return { model: "qwen3.8-flash", messages: request.body.messages, stream: true, max_tokens: 32768, enable_thinking: true, reasoning_effort: "low", temperature: 0.6 };'
  await dialog.getByLabel('请求配置代码').fill(bodyCode)
  await dialog.getByRole('button', { name: '保存这套配置' }).click()
  await expect(dialog.getByRole('status')).toContainText('句法模型已保存')
  await dialog.getByRole('button', { name: '关闭模型设置' }).click()
  await page.getByRole('button', { name: '句法模型设置', exact: true }).click()
  await expect(dialog.getByLabel('请求配置代码')).toHaveValue(bodyCode)
  await expect(dialog.getByRole('tab', { name: '代码模式', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await dialog.getByRole('tab', { name: '简易模式', exact: true }).click()
  await expect(dialog.getByLabel('请求配置代码')).toHaveCount(0)
  await expect(dialog.getByLabel('模型名', { exact: true })).toHaveValue('')
  await dialog.getByRole('tab', { name: '代码模式', exact: true }).click()
  await expect(dialog.getByLabel('请求配置代码')).toHaveValue(bodyCode)
  await page.screenshot({ path: 'work/stream16/model-code-mode.png' })
  await dialog.getByRole('button', { name: '关闭模型设置' }).click()
  await page.getByRole('button', { name: '收起 AI 细读' }).click()
  // No selection: the real five-second admission path must use the saved code.
  await expect.poll(() => requests.length, { timeout: 18000 }).toBe(1)
  expect(requests[0]).toMatchObject({
    enable_thinking: true,
    reasoning_effort: 'low',
    temperature: 0.6
  })
  expect(requests[0]).not.toHaveProperty('thinking_budget')
  await page.getByRole('button', { name: '查看自动句法进度' }).click()
  await expect(page.getByLabel('句法运行状态')).toContainText('尚未交付正式结构')
  await expect(page.locator('.automatic-syntax-light')).toHaveCount(0)
  await page.screenshot({ path: 'work/stream16/code-thinking-wait.png' })
  // Receiving reasoning is not enough; a valid patch renders while the HTTP stream stays open.
  content(replies[0], { type: 'begin', version: 3 })
  content(replies[0], patch)
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
  expect(replies[0].writableEnded).toBe(false)
  await expect(page.locator('.automatic-syntax-light .syntax-band-emergence').last()).toHaveCSS(
    'opacity',
    '1'
  )
  await expect(page.getByLabel('句法运行状态')).toContainText('关系已显影')
  await page.screenshot({ path: 'work/stream16/code-first-batch.png' })
  finish(replies[0])
})
test('invalid later batches keep valid light and surface a recoverable error, never caching the partial graph', async () => {
  await select()
  await expect.poll(() => requests.length).toBe(1)
  content(replies[0], { type: 'begin', version: 3 })
  content(replies[0], patch)
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
  content(replies[0], { type: 'patch', units: [unit('bad', '错误锚点', 'object')], relations: [] })
  // The invalid batch no longer cancels the stream; later complete batches may still apply.
  await expect.poll(() => replies[0].destroyed).toBe(false)
  finish(replies[0])
  await expect(page.getByRole('button', { name: '查看自动句法进度' })).toHaveText('句法需要处理')
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
  await page.getByRole('button', { name: '查看自动句法进度' }).click()
  await expect(page.locator('.automatic-syntax-progress .ai-notice').first()).toContainText(
    '逐字对应'
  )
  await expect(page.locator('.automatic-syntax-progress [role="alert"]')).toContainText('异常批次')
  await app.evaluate(({ app }) => app.exit(0))
  await launch()
  await select()
  await expect.poll(() => requests.length).toBe(2)
})
test('automatic explanation shows thinking while the shared note input remains editable; each lane saves its thinking controls', async () => {
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '阅读设置', exact: true })
  await settings.getByLabel('随阅读自动分析句法').uncheck()
  await settings.getByLabel('写用户注释', { exact: true }).check()
  await settings.getByLabel('自动解释', { exact: true }).check()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await select()
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator('.selection-workflow .model-reasoning-text')).toContainText(
    '固定思考流'
  )
  await expect(page.getByRole('textbox', { name: '用户注释', exact: true })).toBeFocused()
  await page.getByRole('textbox', { name: '用户注释', exact: true }).fill('思考抵达时仍能书写')
  send(replies[0], { content: '解释的第一段已抵达。' })
  await expect(page.locator('.auto-explanation-content')).toContainText('第一段已抵达')
  expect(replies[0].writableEnded).toBe(false)
  await page.getByRole('button', { name: '收起选段操作' }).click()
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByRole('button', { name: '模型、密钥与系统提示词' }).click()
  const dialog = page.getByRole('dialog', { name: 'AI 模型与提示词' })
  await expect(dialog.getByLabel('最大输出 tokens')).toHaveValue('32768')
  await dialog.getByLabel('思考模式').selectOption('enabled')
  await dialog.getByLabel('思考强度').selectOption('max')
  await dialog.getByRole('button', { name: '保存这套配置' }).click()
  await expect(dialog.getByRole('status')).toContainText('已保存')
  const profiles = await page.evaluate(() => window.ai!.getProfiles())
  expect(profiles.reading.reasoningEffort).toBe('max')
  expect(profiles.syntax.reasoningEffort).toBe('low')
  await dialog.getByLabel('思考强度').selectOption('none')
  await expect(dialog.getByLabel('思考模式')).toHaveValue('disabled')
  await dialog.getByRole('button', { name: '保存这套配置' }).click()
  await expect(dialog.getByRole('status')).toContainText('已保存')
  expect((await page.evaluate(() => window.ai!.getProfiles())).reading.thinkingMode).toBe(
    'disabled'
  )
  await expect(dialog.getByLabel('思考强度')).toHaveValue('none')
  await dialog.getByLabel('思考强度').selectOption('low')
  await expect(dialog.getByLabel('思考模式')).toHaveValue('enabled')
  await page.screenshot({ path: 'work/stream16/thinking-settings.png' })
})
