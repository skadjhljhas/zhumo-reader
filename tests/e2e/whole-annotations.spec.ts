import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-types'
import { defaultAiProfile } from '../../src/shared/ai-types'
const send = (res: ServerResponse, record: unknown): void => {
  res.write(
    'data: ' +
      JSON.stringify({ choices: [{ delta: { content: JSON.stringify(record) } }] }) +
      '\n\n'
  )
}
test('whole Markdown marks unseen paragraphs, renders independent ink and radiance, excludes follow jobs and restores cache', async () => {
  test.setTimeout(100000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-whole-annotations-')),
    profile = join(root, 'profile'),
    file = join(root, '完整文稿.md')
  const firstText = '自由从来不是孤立的概念，它在相遇中获得新的意义。'
  const lastText = '理解把前文的自由带回同一个问题，也让这一页成为光源。'
  const source =
    '# 整篇光的结构\n\n' +
    firstText +
    '\n\n' +
    Array.from(
      { length: 60 },
      (_, i) => `第${i + 1}段。一个判断如何获得条件，仍需要沿着上下文缓缓阅读。\n\n`
    ).join('') +
    '## 尾声\n\n' +
    lastText +
    '[^n]\n\n[^n]: 边注中的光也参与全文的理解。\n'
  const calls: Array<{
    input: Record<string, unknown>
    body: { messages: Array<{ content: string }>; [key: string]: unknown }
    res: ServerResponse
  }> = []
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (part) => parts.push(part))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()),
        input = JSON.parse(body.messages.at(-1).content)
      calls.push({ input, body, res })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { reasoning_content: '先通读全文，再交付相互呼应的词句。' } }]
          }) +
          '\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  await mkdir(profile)
  await mkdir('work/whole52', { recursive: true })
  await writeFile(file, source)
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      automaticSyntax: false,
      automaticSyntaxWaitSeconds: 1,
      lightRange: 'hdr'
    })
  )
  await writeFile(
    join(profile, 'ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'whole-fixture',
        settings: {
          ...defaultAiProfile('syntax'),
          model: 'fixture-no-real-model',
          systemPrompt: 'FOLLOW-FIXTURE',
          documentSystemPrompt: 'DOCUMENT-FIXTURE',
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
        }
      }
    })
  )
  let app: ElectronApplication | undefined
  const launch = async (): Promise<Page> => {
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
      env: { ...process.env, ZHUMO_USER_DATA: profile }
    })
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      localStorage.setItem('zhumo.studio.theme', 'lucent')
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const media = original(query)
        if (query === '(dynamic-range: high)')
          Object.defineProperty(media, 'matches', { get: () => true })
        return media
      }
    })
    await page.reload()
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.getByText(firstText, { exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    await page.getByRole('button', { name: '文本标注方式', exact: true }).click()
    await page.getByRole('radio', { name: /全文标注/ }).check()
    await expect.poll(() => calls.length).toBe(1)
    const whole = calls[0]
    expect(whole.input.markdown).toBe(source)
    expect(whole.body.messages[0].content).toContain('DOCUMENT-FIXTURE')
    expect(whole.body.messages[0].content).not.toContain('FOLLOW-FIXTURE')
    expect(whole.body).not.toHaveProperty('max_tokens')
    expect(whole.body).not.toHaveProperty('thinking')
    const blocks = whole.input.blocks as Array<{ id: string; text: string }>
    const first = blocks.find((b) => b.text === firstText)!,
      last = blocks.find((b) => b.text === lastText)!
    expect(first).toBeTruthy()
    expect(last).toBeTruthy()
    expect(blocks.some((b) => b.text.includes('边注中的光'))).toBe(true)
    send(whole.res, { type: 'begin', version: 4 })
    send(whole.res, {
      type: 'mark',
      blockId: blocks.find((b) => b.text === '整篇光的结构')!.id,
      quote: '光的结构',
      occurrence: 1,
      textColor: '#486ea1',
      glowColor: '#d8c49b'
    })
    send(whole.res, {
      type: 'mark',
      blockId: first.id,
      quote: '自由',
      occurrence: 1,
      textColor: '#ac2255',
      glowColor: '#aacedd',
      radiance: 0.7
    })
    send(whole.res, {
      type: 'mark',
      blockId: last.id,
      quote: '理解',
      occurrence: 1,
      textColor: '#ac2255',
      glowColor: '#d8c49b',
      radiance: 0.55
    })
    await expect(page.locator('.reading-color-mark[data-quote="自由"]')).toHaveCount(1)
    await expect(
      page.locator('.reading-color-light [data-hdr-renderer="instanced-bands"]').first()
    ).toBeVisible()
    await page.getByRole('button', { name: '关闭标注选项' }).click()
    await page.waitForTimeout(3100)
    await page.screenshot({ path: 'work/whole52/whole-radiance.png' })
    const inkOnly = await page.addStyleTag({
      content: '.reading-color-light,.radiance-field{visibility:hidden!important}'
    })
    await page
      .getByText(firstText, { exact: true })
      .screenshot({ path: 'work/whole52/ink-only.png' })
    const nativeColors = await page.evaluate(() =>
      [...CSS.highlights]
        .filter(([name]) => name.startsWith('zhumo-reading-color-'))
        .flatMap(([name, value]) =>
          [...value].map((range) => ({
            text: range.toString(),
            color: getComputedStyle(
              (range as Range).startContainer.parentElement!,
              `::highlight(${name})`
            ).color
          }))
        )
    )
    expect(nativeColors).toContainEqual({ text: '自由', color: 'rgb(172, 34, 85)' })
    expect(nativeColors).toContainEqual({ text: '光的结构', color: 'rgb(72, 110, 161)' })
    await page.locator('.overture-copy h1').screenshot({ path: 'work/whole52/title-ink.png' })
    await inkOnly.evaluate((element) => element.parentNode?.removeChild(element))
    await expect(page.locator('[data-hdr-renderer="radiance-field"]')).toBeVisible()
    const emission = await page.evaluate(async () => {
      const surface = document.querySelector('.radiance-field') as HTMLCanvasElement
      const context = surface.getContext('webgpu')!,
        configuration = context.getConfiguration()!,
        device = configuration.device
      const range = [...CSS.highlights]
        .flatMap(([, value]) => [...value])
        .find((r) => r.toString() === '自由') as Range
      const box = range.getBoundingClientRect(),
        scale = surface.width / innerWidth
      const x = Math.max(0, Math.floor((box.x - 20) * scale)),
        y = Math.max(0, Math.floor((box.y - 30) * scale))
      const w = Math.min(surface.width - x, Math.ceil((box.width + 40) * scale)),
        h = Math.min(surface.height - y, Math.ceil((box.height + 60) * scale))
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
      const texture = context.getCurrentTexture(),
        stride = Math.ceil((w * 8) / 256) * 256
      const buffer = device.createBuffer({
        size: stride * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow: stride }, [
        w,
        h
      ])
      device.queue.submit([encoder.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const data = new Uint16Array(buffer.getMappedRange())
      const half = (v: number): number => {
        const exponent = (v >> 10) & 31,
          mantissa = v & 1023
        return (
          (v & 32768 ? -1 : 1) *
          (exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024)
        )
      }
      let overWhite = 0
      for (let row = 0; row < h; row++)
        for (let col = 0; col < w; col++) {
          const at = (row * stride) / 2 + col * 4,
            alpha = half(data[at + 3])
          if (alpha > 0.02)
            for (let channel = 0; channel < 3; channel++)
              overWhite = Math.max(overWhite, half(data[at + channel]) + 1 - alpha)
        }
      buffer.unmap()
      buffer.destroy()
      return {
        format: configuration.format,
        toneMapping: configuration.toneMapping?.mode,
        overWhite
      }
    })
    expect(emission.format).toBe('rgba16float')
    expect(emission.toneMapping).toBe('extended')
    expect(emission.overWhite).toBeGreaterThan(1.15)
    await writeFile('work/whole52/emission.json', JSON.stringify(emission, null, 2))
    send(whole.res, { type: 'done', summary: '自由与理解在首尾互相呼应。' })
    whole.res.end(
      'data: ' +
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        '\n\ndata: [DONE]\n\n'
    )
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(profile, 'selection-explanations.v1.json'), 'utf8').catch(
              () => '{"entries":[]}'
            )
          ).entries.length
      )
      .toBe(1)
    await page.getByRole('button', { name: '文本标注方式', exact: true }).click()
    await page.getByRole('radio', { name: /跟随阅读/ }).check()
    await page.getByRole('button', { name: '关闭标注选项' }).click()
    await expect
      .poll(() => calls.filter((call) => !call.input.blocks).length, { timeout: 7000 })
      .toBeGreaterThan(0)
    const following = calls.filter((call) => !call.input.blocks)
    expect(following[0].body.messages[0].content).toContain('FOLLOW-FIXTURE')
    await page.getByRole('button', { name: '文本标注方式', exact: true }).click()
    await page.getByRole('radio', { name: /全文标注/ }).check()
    await expect.poll(() => following.every((call) => call.res.destroyed)).toBe(true)
    await expect(page.locator('.annotation-phase')).toContainText('全文标注完成')
    expect(calls.filter((call) => call.input.blocks)).toHaveLength(1)
    await app!.close()
    app = undefined
    page = await launch()
    await expect(page.locator('.reading-color-mark[data-quote="自由"]')).toHaveCount(1)
    await page.evaluate(() => {
      const scroller = document.querySelector('.reader-scroll')!
      scroller.scrollTop = scroller.scrollHeight
    })
    await expect(page.locator('.reading-color-mark[data-quote="理解"]')).toHaveCount(1)
    await expect(
      page.locator('.reader-scroll .section-body p').filter({ hasText: lastText })
    ).toBeInViewport()
    expect(calls.filter((call) => call.input.blocks)).toHaveLength(1)
    expect(await readFile(file, 'utf8')).toBe(source)
    await page.getByRole('button', { name: '文本标注方式', exact: true }).click()
    await page.getByRole('button', { name: '模型与独立提示词', exact: true }).click()
    await expect(page.getByLabel('输出长度模式')).toHaveValue('default')
    await expect(page.getByLabel('句法上下文')).toHaveValue('default')
    await expect(page.getByLabel('思考强度')).toHaveValue('default')
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveValue('DOCUMENT-FIXTURE')
    await page.getByRole('tab', { name: '跟随阅读提示词', exact: true }).click()
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveValue('FOLLOW-FIXTURE')
    await page.getByLabel('系统提示词', { exact: true }).fill('FOLLOW-EDITED')
    await page.getByRole('tab', { name: '全文标注提示词', exact: true }).click()
    await expect(page.getByLabel('系统提示词', { exact: true })).toHaveValue('DOCUMENT-FIXTURE')
    await page.getByLabel('系统提示词', { exact: true }).fill('DOCUMENT-EDITED')
    await page.getByRole('button', { name: '保存这套配置', exact: true }).click()
    await expect
      .poll(async () => {
        const profiles = await page.evaluate(() => window.ai!.getProfiles())
        return [
          profiles.syntax.systemPrompt,
          profiles.syntax.documentSystemPrompt,
          profiles.syntax.model
        ]
      })
      .toEqual(['FOLLOW-EDITED', 'DOCUMENT-EDITED', 'fixture-no-real-model'])
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-whole-annotations-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
