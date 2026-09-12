import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron, assertBackgroundWindow } from './runtime'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
const texts = [
  '自由并不是任意。自由是一种能够回应他人的能力。',
  '但这并不意味着，每一次选择都已经获得了正当性。',
  '所谓理解，不仅是重复一个概念，更是看见它在论证中的变化。',
  '他说这是一种必然；然而，这个判断仍然属于被转述的声音。'
]
const words = [
  ['自由', '回应他人'],
  ['并不意味着', '每一次选择'],
  ['理解', '概念'],
  ['必然', '被转述']
]
const send = (res: ServerResponse, record: unknown): void => {
  res.write(
    'data: ' +
      JSON.stringify({
        choices: [
          { delta: { content: typeof record === 'string' ? record : JSON.stringify(record) } }
        ]
      }) +
      '\n\n'
  )
}
const done = (res: ServerResponse): void => {
  send(res, { type: 'done', summary: '固定着色接口响应；不检验模型能力。' })
  res.end(
    'data: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n'
  )
}
test('real body receives independently colored words while four streams run, survives a bad record and restores cache after restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-reading-colors-')),
    profile = join(root, 'profile'),
    file = join(root, '在概念的转折处.md')
  const source = '# 在概念的转折处\n\n' + texts.join('\n\n') + '\n'
  const calls: Array<{ text: string; appearance: { theme: string }; res: ServerResponse }> = []
  const errors: string[] = []
  let app: ElectronApplication | undefined
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (p) => parts.push(p))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()),
        input = JSON.parse(body.messages.at(-1).content)
      calls.push({ text: input.selectedText, appearance: input.readingAppearance, res })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { reasoning_content: '固定思考输出，等待颜色记录。' } }]
          }) +
          '\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await mkdir(profile)
    await mkdir('work/colors29', { recursive: true })
    await writeFile(file, source)
    await writeFile(
      join(profile, 'ai-models.v1.json'),
      JSON.stringify({
        version: 1,
        syntax: {
          revision: 'colors-fixture',
          settings: {
            ...defaultAiProfile('syntax'),
            model: 'fixture-no-real-model',
            context: 'selection',
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
          }
        }
      })
    )
    const launch = async (theme = 'lucent'): Promise<Page> => {
      app = await electron.launch({
        executablePath: process.env.ZHUMO_E2E_EXE,
        args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
        env: { ...process.env, ZHUMO_USER_DATA: profile }
      })
      const page = await app.firstWindow()
      await assertBackgroundWindow(app)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1480, 1030)
      )
      await page.evaluate((theme) => localStorage.setItem('zhumo.studio.theme', theme), theme)
      await page.reload()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      })
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, file)
      await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
      await expect(page.locator('.reader-scroll .section-body p')).toHaveCount(4)
      return page
    }
    let page = await launch()
    await page.waitForTimeout(2800)
    expect(calls).toHaveLength(0)
    await expect.poll(() => calls.length, { timeout: 8000 }).toBe(4)
    expect(calls.every((c) => c.appearance.theme === 'lucent')).toBe(true)
    expect(await page.locator('.reading-color-mark').count()).toBe(0)
    const first = calls[0],
      firstIndex = texts.indexOf(first.text)
    const mark = (quote: string, occurrence = 1, dark = false): unknown => ({
      type: 'mark',
      quote,
      occurrence,
      textColor: dark ? '#bcdff5' : '#386491',
      glowColor: '#e7bd91',
      note: '字色关联概念，荧光提示此处的论证姿态。'
    })
    send(first.res, { type: 'begin', version: 4 })
    send(first.res, mark(words[firstIndex][0]))
    await expect(page.locator('.reading-color-mark')).toHaveCount(1)
    await expect(page.locator('.reading-color-mark')).toHaveCSS('opacity', '0.95', {
      timeout: 6000
    })
    expect(first.res.destroyed).toBe(false)
    const highlights = async (): Promise<Array<{ text: string; color: string; source: boolean }>> =>
      page.evaluate(() => {
        return [...CSS.highlights]
          .filter(([name]) => name.startsWith('zhumo-reading-color-'))
          .flatMap(([name, h]) =>
            [...h].map((r) => {
              const range = r as Range,
                element = range.startContainer.parentElement!
              return {
                text: range.toString(),
                color: getComputedStyle(element, `::highlight(${name})`).color,
                source: Boolean(element.closest('.section-body'))
              }
            })
          )
      })
    await expect
      .poll(highlights)
      .toEqual([{ text: words[firstIndex][0], color: 'rgb(56, 100, 145)', source: true }])
    send(first.res, { ...(mark('原文并不存在') as object) })
    send(first.res, mark(words[firstIndex][1]))
    await expect(page.locator('.reading-color-mark')).toHaveCount(2)
    for (const call of calls.slice(1)) {
      const i = texts.indexOf(call.text)
      send(call.res, { type: 'begin', version: 4 })
      send(call.res, mark(words[i][0]))
      send(call.res, {
        ...(mark(words[i][1]) as object),
        textColor: '#855578',
        glowColor: '#9ccfcb'
      })
      if (i === 0)
        send(call.res, {
          ...(mark('自由', 2) as object),
          textColor: '#386491',
          glowColor: '#9ccfcb'
        })
    }
    const count = firstIndex === 0 ? 8 : 9
    await expect(page.locator('.reading-color-mark')).toHaveCount(count)
    await page.waitForTimeout(2800)
    await page.screenshot({ path: 'work/colors29/lucent-body.png' })
    // Rendering never wraps, duplicates or edits the source text, and a native selection remains exact.
    expect(await page.locator('.reader-scroll .section-body p').allTextContents()).toEqual(texts)
    await page
      .locator('.reader-scroll .section-body p')
      .first()
      .evaluate((p) => {
        const range = document.createRange()
        range.selectNodeContents(p)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
      })
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(texts[0])
    await page.evaluate(() => getSelection()?.removeAllRanges())
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 820))
    await expect.poll(async () => (await highlights()).every((h) => h.source)).toBe(true)
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 1030))
    for (const call of calls) done(call.res)
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(profile, 'selection-explanations.v1.json'), 'utf8').catch(
              () => '{"entries":[]}'
            )
          ).entries.length
      )
      .toBe(3)
    await app!.evaluate(({ app }) => app.exit(0))
    page = await launch()
    await expect.poll(() => calls.length, { timeout: 12000 }).toBe(5)
    expect(calls[4].text).toBe(first.text)
    await expect
      .poll(async () => (await highlights()).length, { timeout: 8000 })
      .toBeGreaterThanOrEqual(6)
    send(calls[4].res, { type: 'begin', version: 4 })
    send(calls[4].res, mark(words[firstIndex][0]))
    done(calls[4].res)
    await app!.evaluate(({ app }) => app.exit(0))
    page = await launch('chaosheng')
    await expect.poll(() => calls.length, { timeout: 12000 }).toBe(9)
    for (const call of calls.slice(5)) {
      expect(call.appearance.theme).toBe('chaosheng')
      send(call.res, { type: 'begin', version: 4 })
      send(call.res, mark(words[texts.indexOf(call.text)][0], 1, true))
      done(call.res)
    }
    await expect(page.locator('.reading-color-mark')).toHaveCount(4)
    await expect
      .poll(async () =>
        (await highlights()).every((h) => h.color === 'rgb(188, 223, 245)' && h.source)
      )
      .toBe(true)
    await page.screenshot({ path: 'work/colors29/chaoguang-body.png' })
    expect(await readFile(file, 'utf8')).toBe(source)
    expect(errors).toEqual([])
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
