import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { SYNTAX_READING_EXAMPLES as examples } from '../../src/shared/syntax-reading-examples'
import { defaultAiProfile } from '../../src/shared/ai-types'
let app: ElectronApplication,
  page: Page,
  root: string,
  file: string,
  source: string,
  server: Server,
  endpoint: string
let requests: string[] = []
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()),
        user = JSON.parse(body.messages.at(-1).content)
      requests.push(user.selectedText)
      const analysis = examples.find((e) => e.analysis.text === user.selectedText)?.analysis
      if (!analysis) {
        res.writeHead(400)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const text = [
        { type: 'begin', version: 3 },
        {
          type: 'patch',
          units: analysis.spans,
          relations: analysis.relations,
          readings: analysis.readings
        },
        { type: 'done', summary: analysis.summary }
      ]
        .map((v) => JSON.stringify(v) + '\n')
        .join('')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
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
test.beforeEach(async () => {
  requests = []
  root = await mkdtemp(join(tmpdir(), 'zhumo-semantic17-'))
  file = join(root, '关系.md')
  await mkdir(join(root, 'profile'))
  source = '# 语言的光学\n\n' + examples.map((e) => e.analysis.text).join('\n\n')
  await writeFile(file, source)
  await writeFile(
    join(root, 'profile/ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'semantic-fixture',
        settings: { ...defaultAiProfile('syntax'), endpoint, model: 'semantic-fixture' }
      }
    })
  )
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await page.evaluate(() => document.fonts.ready)
  await mkdir('work/semantic17', { recursive: true })
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function select(index: number): Promise<void> {
  const p = page.locator('.reader-scroll .section-body p').nth(index)
  await p.scrollIntoViewIfNeeded()
  await p.dispatchEvent('pointerdown', { button: 0 })
  await p.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await p.dispatchEvent('pointerup', { button: 0 })
}
test('opposite scope orders have different persistent geometry before any hover, with no POS tooltip or source mutation', async () => {
  await select(0)
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="outer_not"]')
  ).toHaveAttribute('data-level', '1')
  await select(1)
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="outer_all"]')
  ).toHaveAttribute('data-level', '1')
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.locator('.reader-scroll .section-body p').first().hover()
  await expect(page.locator('.syntax-reading-tooltip')).toHaveCount(0)
  await page.mouse.move(10, 10)
  await expect(page.locator('[data-relation-id="outer_all"] .syntax-band-emergence')).toHaveCSS(
    'opacity',
    '1'
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.syntax-semantic-breath').first()).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: 'work/semantic17/scopes-in-reader.png' })
  const before = await page.locator('.reader-scroll .section-body').first().innerHTML()
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByLabel('随阅读自动分析句法').uncheck()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(page.locator('.automatic-syntax-light')).toHaveCount(0)
  expect(await page.locator('.reader-scroll .section-body').first().innerHTML()).toBe(before)
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('a mature visible short paragraph is analyzed together so reference crosses the sentence boundary', async () => {
  const p = page.locator('.reader-scroll .section-body p').nth(4)
  await p.scrollIntoViewIfNeeded()
  await expect
    .poll(() => requests.includes(examples[4].analysis.text), { timeout: 18000 })
    .toBe(true)
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="person_chain"]')
  ).toBeVisible()
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="letter_chain"]')
  ).toBeVisible()
  await expect(page.locator('[data-relation-id="letter_chain"] .syntax-band-emergence')).toHaveCSS(
    'opacity',
    '1'
  )
  expect(requests).not.toContain('后者随即拆开了它。')
  await page.screenshot({ path: 'work/semantic17/cross-sentence-reference.png' })
  expect(await readFile(file, 'utf8')).toBe(source)
})
