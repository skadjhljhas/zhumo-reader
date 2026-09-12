import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { defaultAiProfile } from '../../src/shared/ai-types'
let app: ElectronApplication, page: Page, root: string, server: Server, endpoint: string
const requests: Array<{ selectedText: string; thinking: unknown; incompatible: unknown }> = []
test.beforeAll(async () => {
  // Captured from one Qwen fixed-format echo, not from a user's manuscript or a capability evaluation.
  const echoed = await readFile('tests/fixtures/qwen38-format-echo.jsonl', 'utf8')
  server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (p) => parts.push(p))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()),
        user = JSON.parse(body.messages.at(-1).content)
      requests.push({
        selectedText: user.selectedText,
        thinking: body.enable_thinking,
        incompatible: body.thinking
      })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const output =
        user.selectedText === '错误句段。'
          ? '{"type":"begin","version":3}\n{"type":"patch","units":[{"id":"bad"}],"relations":[]}\n'
          : echoed
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output } }] }) + '\n\n')
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
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
test('native window focus admits reading without DOM focus; a bad paragraph does not block a real Qwen-format response from painting', async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-runtime19-'))
  await mkdir(join(root, 'profile'))
  await mkdir('work/runtime19', { recursive: true })
  const file = join(root, '格式链路.md'),
    source = '# 格式链路\n\n错误句段。\n\n光经过文字。\n'
  await writeFile(file, source)
  await writeFile(
    join(root, 'profile/ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'runtime-fixture',
        settings: {
          ...defaultAiProfile('syntax'),
          model: 'qwen3.8-flash',
          endpoint,
          thinkingMode: 'disabled'
        }
      }
    })
  )
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await app.evaluate(({ ipcMain, dialog }, file) => {
    ipcMain.removeHandler('ai:window-activity')
    // Simulate the native title-bar focus case in an isolated, always-hidden test window.
    ipcMain.handle('ai:window-activity', () => ({
      focused: true,
      visible: true,
      backgroundTest: false
    }))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.getByRole('button', { name: '查看自动句法进度' })).toBeVisible()
  await expect.poll(() => requests.length, { timeout: 18000 }).toBe(2)
  expect(requests.map((r) => r.selectedText)).toEqual(['错误句段。', '光经过文字。'])
  expect(requests.every((r) => r.thinking === false && r.incompatible === undefined)).toBe(true)
  await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(2)
  await expect(page.locator('.automatic-syntax-light .syntax-band-emergence').last()).toHaveCSS(
    'opacity',
    '1'
  )
  await page.screenshot({ path: 'work/runtime19/qwen-format-painted.png' })
  await page.getByRole('button', { name: '查看自动句法进度' }).click()
  await expect(page.getByLabel('句法运行状态')).toContainText('1 个句段暂未完成标注')
  await expect(page.getByLabel('句法运行状态')).toContainText('qwen3.8-flash')
  await page.screenshot({ path: 'work/runtime19/runtime-diagnostics.png' })
  expect(await readFile(file, 'utf8')).toBe(source)
})
