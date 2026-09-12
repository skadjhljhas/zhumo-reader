import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { electron, readClipboard } from './runtime'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile, type AiLane } from '../../src/shared/ai-types'

let app: ElectronApplication,
  page: Page,
  root: string,
  file: string,
  server: Server,
  endpoint: string
let requests: Array<{
  url: string
  model: string
  user: Record<string, string>
  system: string
  authorization: string
}>
let closedRequests = 0
const quote = '🌙海风轻轻翻开书页。'
const source =
  '\uFEFF# 句子的光\r\n\r\n' +
  quote +
  '\r\n\r\n' +
  quote +
  '\r\n\r\n书页[^甲]，每一次停留都是重新开始。\r\n\r\n' +
  '一段留给阅读的空隙。\r\n\r\n'.repeat(20) +
  '[^甲]: 旁注中的全文证据。\r\n'
const textResponse =
  '海风是动作的发出者，书页是动作的承受者。🌙\n\n<img src="https://invalid.test/tracker">只作为文字显示。'

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (value) => chunks.push(value))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const anthropic = req.url?.endsWith('/messages')
      const userText = body.messages.at(-1).content
      const user = userText.startsWith('{') ? JSON.parse(userText) : { task: userText }
      requests.push({
        url: req.url ?? '',
        model: body.model,
        user,
        system: anthropic ? body.system : body.messages[0].content,
        authorization: String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
      })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const selected = user.selectedText ?? ''
      const syntax = JSON.stringify({
        text: selected,
        summary: '海风—翻开—书页是句子的主干，轻轻修饰动作。',
        spans: [
          {
            quote: body.model === 'bad-syntax' ? '不存在的词' : '海风',
            role: 'subject',
            label: '主语',
            explanation: '动作的发出者。'
          },
          { quote: '轻轻', role: 'adverbial', label: '状语', explanation: '修饰动作方式。' },
          { quote: '翻开', role: 'predicate', label: '谓语', explanation: '核心动作。' },
          { quote: '书页', role: 'object', label: '宾语', explanation: '动作的承受者。' }
        ].map((span) => ({ ...span, occurrence: 1, confidence: 0.95 }))
      })
      const text = !selected ? 'OK' : body.model.includes('syntax') ? syntax : textResponse
      let at = 0
      const send = (data: unknown): void => {
        res.write('data: ' + JSON.stringify(data) + '\r\n\r\n')
      }
      const timer = setInterval(
        () => {
          if (at < text.length) {
            const part = text.slice(at, at + (body.model === 'slow-reader' ? 1 : 11))
            at += part.length
            send(
              anthropic
                ? { type: 'content_block_delta', delta: { type: 'text_delta', text: part } }
                : { choices: [{ delta: { content: part } }] }
            )
          } else {
            clearInterval(timer)
            if (anthropic) {
              send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
              send({ type: 'message_stop' })
            } else {
              send({ choices: [{ delta: {}, finish_reason: 'stop' }] })
              res.write('data: [DONE]\r\n\r\n')
            }
            res.end()
          }
        },
        body.model === 'slow-reader' ? 90 : 8
      )
      res.on('close', () => {
        clearInterval(timer)
        closedRequests++
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
test.beforeEach(async () => {
  requests = []
  closedRequests = 0
  root = await mkdtemp(join(tmpdir(), 'zhumo-ai-e2e-'))
  file = join(root, '句子的光.md')
  await writeFile(file, source)
  app = await electron.launch({
    ...(process.env.ZHUMO_AI_EXE
      ? { executablePath: process.env.ZHUMO_AI_EXE, args: [] }
      : { args: [resolve('out/main/index.js')] }),
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  if (process.env.ZHUMO_AI_EXE)
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe('2.0.0-preview.ai.1')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 980)
  })
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

async function select(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  await locator.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await expect(page.locator('.reading-selection')).toHaveCount(0)
}
async function configure(
  lane: AiLane,
  model: string,
  protocol: 'chat-completions' | 'anthropic' = 'chat-completions'
): Promise<void> {
  await page.evaluate(
    async ({ lane, model, endpoint, protocol, defaults }) => {
      await window.ai!.saveProfile(lane, {
        ...defaults,
        context: lane === 'syntax' ? 'selection' : 'full',
        protocol,
        endpoint,
        model,
        apiKey: lane + '-fixture-key'
      })
    },
    { lane, model, endpoint, protocol, defaults: defaultAiProfile(lane) }
  )
}
async function ask(lane: AiLane): Promise<void> {
  await select(page.locator('.reader-scroll .section-body p').nth(1))
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await page
    .getByRole('tab', { name: lane === 'reading' ? '细读' : '句法之光', exact: true })
    .click()
}
async function theme(name: string): Promise<void> {
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page
    .locator('.theme-choice')
    .filter({ has: page.locator('strong', { hasText: name }) })
    .click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
}

test('model settings persist without exposing keys; explicit reading sends full source and selected occurrence', async () => {
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await page.getByRole('button', { name: '连接我的模型', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI 模型与提示词' })
  await dialog.getByLabel('模型名', { exact: true }).fill('deep-reader')
  await dialog.getByLabel('API 地址', { exact: true }).fill(endpoint)
  await dialog.getByLabel('API 密钥', { exact: true }).fill('reading-fixture-key')
  await dialog.getByLabel('系统提示词', { exact: true }).fill('先判断语境，再解释。')
  await dialog.getByRole('button', { name: '保存并测试连接', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('连接成功')
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0])).not.toContain('全文证据')
  await dialog.getByRole('button', { name: '关闭模型设置', exact: true }).click()
  await page.getByRole('button', { name: '收起 AI 细读', exact: true }).click()
  await ask('reading')
  expect(requests).toHaveLength(1)
  await page.getByLabel('本次阅读要求').fill('说明动词的作用。')
  await page.getByRole('button', { name: '发送全文与选句', exact: true }).click()
  await expect(page.locator('.ai-answer')).toHaveText(textResponse)
  await expect(page.getByRole('button', { name: '发送全文与选句', exact: true })).toBeVisible()
  expect(requests[1].user).toEqual({
    task: '说明动词的作用。',
    selectedText: quote,
    markdown: source
  })
  expect(requests[1].system).toBe('先判断语境，再解释。')
  expect(requests[1].authorization).toBe('Bearer reading-fixture-key')
  await expect(page.locator('.ai-answer img')).toHaveCount(0)
  await page.getByRole('button', { name: '复制结果', exact: true }).click()
  expect(await readClipboard(app)).toBe(textResponse)
  expect(await readFile(file, 'utf8')).toBe(source)
  expect(await readFile(join(root, 'profile', 'ai-models.v1.json'), 'utf8')).not.toContain(
    'reading-fixture-key'
  )
  await page.reload()
  const profiles = await page.evaluate(() => window.ai!.getProfiles())
  expect(profiles.reading.hasKey).toBe(true)
  expect(profiles.reading.model).toBe('deep-reader')
  expect(JSON.stringify(profiles)).not.toContain('fixture-key')
})

test('second protocol paints exact selected words, supports three variants, reflow and complete removal', async () => {
  await configure('reading', 'unused-reader')
  await configure('syntax', 'small-syntax', 'anthropic')
  await theme('潮光')
  await ask('syntax')
  await page.getByRole('button', { name: '发送选句并分析句法', exact: true }).click()
  await expect(page.locator('.syntax-legend > button')).toHaveCount(4)
  expect(requests).toHaveLength(1)
  expect(requests[0].model).toBe('small-syntax')
  expect(requests[0].url).toBe('/v1/messages')
  expect(requests[0].authorization).toBe('syntax-fixture-key')
  expect(requests[0].user).not.toHaveProperty('markdown')
  expect(requests[0].system).toContain('应用输出契约')
  // Deselecting native blue selection must not erase the independent exact text ranges.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await expect(page.locator('.syntax-light-layer .syntax-relation-band')).toHaveCount(4)
  // Virtualized/reparsed surfaces replace text nodes. Identical source-inline text can be re-resolved.
  await page
    .locator('.reader-scroll .section-body p')
    .nth(1)
    .evaluate((element) => {
      element.replaceWith(element.cloneNode(true))
    })
  await expect(page.locator('.syntax-light-layer .syntax-relation-band')).toHaveCount(4)
  const geometry = await page.evaluate(() => {
    const paragraph = document
      .querySelectorAll('.reader-scroll .section-body p')[1]
      .getBoundingClientRect()
    const first = document.querySelector('.syntax-light-layer .syntax-relation-band') as SVGGElement
    const matrix = first.transform.baseVal.consolidate()!.matrix
    return {
      x: matrix.e,
      y: matrix.f,
      left: paragraph.left,
      top: paragraph.top,
      bottom: paragraph.bottom
    }
  })
  expect(geometry.y).toBeGreaterThan(geometry.top)
  expect(geometry.y).toBeLessThan(geometry.bottom + 10)
  for (const [label, style] of [
    ['折光', 'spectrum'],
    ['潮汐', 'tide'],
    ['共鸣', 'constellation']
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-light-style', style)
  }
  await mkdir('work/ai-reading', { recursive: true })
  await page.screenshot({ path: 'work/ai-reading/潮光-句法之光.png' })
  await theme('琉璃')
  await expect(page.locator('.syntax-light-layer .syntax-relation-band')).toHaveCount(4)
  await page.screenshot({ path: 'work/ai-reading/琉璃-句法之光.png' })
  await page.getByLabel('显示光效').uncheck()
  await expect(page.locator('.syntax-light-layer')).toHaveCount(0)
  await page.getByLabel('显示光效').check()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setMinimumSize(390, 600)
    BrowserWindow.getAllWindows()[0].setSize(600, 850)
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  await page.getByRole('button', { name: '收起 AI 细读', exact: true }).click()
  await page.getByRole('button', { name: '收起目录', exact: true }).click()
  await expect(page.locator('.toc-drawer')).toHaveCount(0)
  await page.getByRole('button', { name: '切换注释侧栏', exact: true }).click()
  await expect(page.locator('.notes-sidebar')).toHaveCount(0)
  await page.locator('.reader-scroll .section-body p').nth(1).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'work/ai-reading/窄窗口-句法之光.png' })
  await writeFile(
    'work/ai-reading/窄窗口-几何.json',
    JSON.stringify(
      await page.evaluate(() => {
        const element = document.querySelectorAll('.reader-scroll .section-body p')[1]
        const rect = element.getBoundingClientRect(),
          top = document.elementFromPoint(rect.left + 35, rect.top + 10)
        return {
          rect: rect.toJSON(),
          top: top?.outerHTML.slice(0, 300),
          lights: document.querySelector('.syntax-light-layer')?.outerHTML.slice(0, 500)
        }
      }),
      null,
      2
    )
  )
  await expect
    .poll(() => page.locator('.syntax-light-layer .syntax-relation-band').count())
    .toBeGreaterThan(0)
  const hover = await page.evaluate(() => {
    const band = document.querySelector('.syntax-light-layer .syntax-relation-band') as SVGGElement
    const matrix = band.transform.baseVal.consolidate()!.matrix
    return { x: matrix.e + 6, y: matrix.f - 12 }
  })
  await page.mouse.move(hover.x, hover.y)
  await expect(page.locator('.syntax-reading-tooltip')).toHaveCount(0)
  expect(await page.locator('.reader-scroll .section-body p').nth(1).textContent()).toBe(quote)
  expect(await readFile(file, 'utf8')).toBe(source)
})

test('invalid syntax is readable as an error and never paints guessed positions', async () => {
  await configure('syntax', 'bad-syntax')
  await ask('syntax')
  await page.getByRole('button', { name: '发送选句并分析句法', exact: true }).click()
  await expect(page.locator('.ai-error')).toContainText('逐字对应')
  await expect(page.locator('.syntax-light-layer')).toHaveCount(0)
  expect(await readFile(file, 'utf8')).toBe(source)
})

test('a changed model configuration cannot silently redirect an already prepared manuscript request', async () => {
  await configure('reading', 'first-reader')
  await ask('reading')
  await configure('reading', 'changed-reader')
  await page.getByRole('button', { name: '发送全文与选句', exact: true }).click()
  await expect(page.locator('.ai-error')).toContainText('另一处改变')
  expect(requests).toHaveLength(0)
  expect(await readFile(file, 'utf8')).toBe(source)
})

test('stop cancels the network stream; a new selection cannot accept late output', async () => {
  await configure('reading', 'slow-reader')
  await ask('reading')
  await page.getByRole('button', { name: '发送全文与选句', exact: true }).click()
  await expect(page.locator('.ai-answer')).not.toHaveText('')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  const stopped = await page.locator('.ai-answer').textContent()
  await expect.poll(() => closedRequests).toBe(1)
  await page.waitForTimeout(250)
  expect(await page.locator('.ai-answer').textContent()).toBe(stopped)
  await select(page.locator('.reader-scroll .section-body p').first())
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await expect(page.locator('.ai-answer')).toHaveCount(0)
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: '发送全文与选句', exact: true }).click()
  await expect(page.locator('.ai-answer')).toBeVisible()
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.ai-notice')).toContainText('文稿已改变或已进入编辑')
  await expect.poll(() => closedRequests).toBe(2)
  expect(await readFile(file, 'utf8')).toBe(source)
})
