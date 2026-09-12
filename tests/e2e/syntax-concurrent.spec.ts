import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
const sentences = [
  '海风轻轻翻开书页。',
  '月光慢慢照亮山径。',
  '晨雾悄悄越过江面。',
  '潮声远远唤醒村落。',
  '星光静静映着窗棂。',
  '细雨缓缓洗净石阶。',
  '晚霞徐徐染红天际。',
  '灯火柔柔守着归人。',
  '云影悠悠掠过田野。',
  '雪花纷纷落满庭院。',
  '溪水潺潺绕过青石。'
]
function patch(text: string, extra = false): unknown {
  const word = (id: string, quote: string, role: string): unknown => ({
    id,
    role,
    layer: 'syntax',
    label: '固定句段成分',
    anchors: [{ quote, occurrence: 1 }],
    explanation: '固定接口响应。',
    evidence: '逐字引用。',
    status: 'supported'
  })
  return {
    type: 'patch',
    units: extra
      ? [word('s', text.slice(0, 2), 'subject')]
      : [word('v', text.slice(4, 6), 'predicate'), word('o', text.slice(-3, -1), 'object')],
    relations: [
      {
        id: extra ? 'r2' : 'r',
        kind: 'dependency',
        from: 'v',
        to: [extra ? 's' : 'o'],
        label: '固定依赖关系',
        explanation: '固定接口响应。',
        evidence: '逐字引用。',
        status: 'supported'
      }
    ]
  }
}
const send = (res: ServerResponse, text: string): void => {
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
}
const finish = (res: ServerResponse): void => {
  send(res, JSON.stringify({ type: 'done', summary: '固定响应完成。' }))
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.end('data: [DONE]\n\n')
}
test('five-second reading runs ten streams independently, queues the eleventh and reuses completed cache', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-parallel-syntax-'))
  const file = join(root, '并行阅读.md'),
    profile = join(root, 'profile')
  const source = '# 同时阅读的句子\n\n' + sentences.join('\n\n') + '\n'
  const calls: Array<{ text: string; res: ServerResponse }> = []
  let app: ElectronApplication | undefined
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (part) => parts.push(part))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString())
      const text = JSON.parse(body.messages.at(-1).content).selectedText
      calls.push({ text, res })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { reasoning_content: '固定思考，等待交付。' } }] }) +
          '\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await mkdir(profile)
    await mkdir('work/parallel27', { recursive: true })
    await writeFile(file, source)
    await writeFile(
      join(profile, 'ai-models.v1.json'),
      JSON.stringify({
        version: 1,
        syntax: {
          revision: 'parallel-fixture',
          settings: {
            ...defaultAiProfile('syntax'),
            model: 'fixture-never-real',
            context: 'selection',
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
          }
        }
      })
    )
    const launch = async (): Promise<import('@playwright/test').Page> => {
      app = await electron.launch({
        executablePath: process.env.ZHUMO_E2E_EXE,
        args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
        env: { ...process.env, ZHUMO_USER_DATA: profile }
      })
      const page = await app.firstWindow()
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1480, 1600)
      )
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      })
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, file)
      await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
      await expect(page.locator('.reader-scroll .section-body p')).toHaveCount(11)
      return page
    }
    let page = await launch()
    await page.waitForTimeout(3000)
    expect(calls).toHaveLength(0)
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(10)
    expect(new Set(calls.map((call) => call.text)).size).toBe(10)
    expect(calls.every((call) => !call.res.destroyed)).toBe(true)
    // Keep every slot occupied beyond another admission tick: the eleventh must wait.
    await page.waitForTimeout(1100)
    expect(calls).toHaveLength(10)
    const first = calls[0]
    send(
      first.res,
      JSON.stringify({ type: 'begin', version: 3 }) + JSON.stringify(patch(first.text))
    )
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(2)
    // Balanced but invalid JSON is isolated; the next object arrives in the same network chunk.
    send(
      first.res,
      '{"type":"patch","units":[],"relations":[,]}' + JSON.stringify(patch(first.text, true))
    )
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(3)
    expect(first.res.destroyed).toBe(false)
    for (const call of calls.slice(1))
      send(
        call.res,
        JSON.stringify({ type: 'begin', version: 3 }) + JSON.stringify(patch(call.text))
      )
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(21)
    finish(first.res)
    await expect.poll(() => calls.length, { timeout: 4000 }).toBe(11)
    const eleventh = calls[10]
    send(
      eleventh.res,
      JSON.stringify({ type: 'begin', version: 3 }) + JSON.stringify(patch(eleventh.text))
    )
    finish(eleventh.res)
    for (const call of calls.slice(1, 10)) finish(call.res)
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(23)
    await expect(page.locator('.automatic-syntax-light .syntax-band-emergence').last()).toHaveCSS(
      'opacity',
      '1'
    )
    await page.screenshot({ path: 'work/parallel27/eleven-passages.png' })
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(profile, 'selection-explanations.v1.json'), 'utf8'))
            .entries.length
      )
      .toBe(10)
    await app!.evaluate(({ app }) => app.exit(0))
    page = await launch()
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(20, {
      timeout: 10000
    })
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(12)
    expect(calls[11].text).toBe(first.text)
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
