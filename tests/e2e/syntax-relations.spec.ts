import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SYNTAX_EXAMPLES } from '../../src/shared/syntax-examples'
import { SYNTAX_READING_EXAMPLES } from '../../src/shared/syntax-reading-examples'
const allExamples = [...SYNTAX_EXAMPLES, SYNTAX_READING_EXAMPLES[4]]
import { defaultAiProfile } from '../../src/shared/ai-types'
let server: Server,
  endpoint: string,
  app: ElectronApplication,
  page: Page,
  root: string,
  file: string
const source =
  '# 语言关系的光\n\n' +
  allExamples.map((e) => e.analysis.text).join('\n\n') +
  '\n\n' +
  '阅读仍然属于文字。\n\n'.repeat(25)
test.beforeAll(async () => {
  // Fixed interface fixtures only: no language model is called or evaluated.
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString()),
        user = JSON.parse(request.messages.at(-1).content)
      const analysis = allExamples.find((e) => e.analysis.text === user.selectedText)?.analysis
      if (!analysis) {
        res.writeHead(400)
        res.end()
        return
      }
      const result = JSON.stringify({ ...analysis, units: analysis.spans })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: result } }] }) + '\n\n')
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
  root = await mkdtemp(join(tmpdir(), 'zhumo-syntax-graph-'))
  file = join(root, '语言关系的光.md')
  await writeFile(file, source)
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
  await expect(page.locator('.reader-scroll .section-body p').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    async ({ endpoint, profile }) => {
      await window.ai!.saveProfile('syntax', {
        ...profile,
        context: 'selection',
        endpoint,
        model: 'interface-fixture',
        apiKey: ''
      })
    },
    { endpoint, profile: defaultAiProfile('syntax') }
  )
  await mkdir('work/syntax-v2', { recursive: true })
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function analyze(index: number): Promise<void> {
  if (await page.getByRole('button', { name: '收起 AI 细读', exact: true }).isVisible())
    await page.getByRole('button', { name: '收起 AI 细读', exact: true }).click()
  const p = page.locator('.reader-scroll .section-body p').nth(index)
  await p.scrollIntoViewIfNeeded()
  await p.evaluate((el) => {
    const r = document.createRange()
    r.selectNodeContents(el)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  })
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await page.getByRole('tab', { name: '句法之光', exact: true }).click()
  await page.getByRole('button', { name: '发送选句并分析句法', exact: true }).click()
  await expect(page.locator('.syntax-relations')).toBeVisible()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await expect(page.locator('.syntax-light-layer')).toBeVisible()
}
async function theme(name: string): Promise<void> {
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page
    .locator('.theme-choice')
    .filter({ has: page.locator('strong', { hasText: name }) })
    .click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
}
test('scope illuminates native ranges in both themes without changing text or drawing solid edges', async () => {
  await analyze(0)
  for (const name of ['琉璃', '潮光']) {
    await theme(name)
    await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-relation', 'neg_scope')
    await expect(page.locator('.syntax-light-layer [data-scope-id="neg_scope"]')).toHaveCount(1)
    await expect(
      page.locator('.syntax-light-layer [data-spectrum-operator="neg_scope"]')
    ).toHaveText('并非')
    await expect(page.locator('.syntax-light-layer circle')).toHaveCount(0)
    await expect(page.locator('.syntax-light-layer path').first()).toHaveCSS('stroke', 'none')
    expect(
      await page
        .locator('.syntax-light-layer path')
        .first()
        .evaluate((el) => getComputedStyle(el).fill)
    ).not.toBe('none')
    await expect(page.locator('.syntax-sentence')).toHaveText(SYNTAX_EXAMPLES[0].analysis.text)
    await page.locator('.syntax-stage').scrollIntoViewIfNeeded()
    await page.waitForTimeout(1800)
    await page.screenshot({ path: 'work/syntax-v2/' + name + '-辖域.png' })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.syntax-preview-veil .syntax-veil-motion').first()).toHaveCSS(
    'animation-name',
    'none'
  )
  const on = await page.locator('.syntax-stage').screenshot()
  await page.getByLabel('显示光效', { exact: true }).uncheck()
  await expect(page.locator('.syntax-light-layer')).toHaveCount(0)
  const off = await page.locator('.syntax-stage').screenshot()
  expect(on.equals(off)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('candidate switching isolates focus associations and implicit units never become ghost words', async () => {
  await analyze(2)
  await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-relation', 'recipient')
  await page.getByRole('button', { name: '行为对比', exact: true }).click()
  await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-relation', 'activity')
  await expect(page.locator('[data-relation-id="recipient"]')).toHaveCount(0)
  await expect(page.locator('.syntax-sentence')).toHaveText(SYNTAX_EXAMPLES[2].analysis.text)
  await page.screenshot({ path: 'work/syntax-v2/候选-行为对比.png' })
  await analyze(3)
  await page.getByText('查看成分与依据', { exact: true }).click()
  await expect(page.locator('.syntax-legend')).toContainText('〔隐含〕')
  await expect(page.locator('.syntax-sentence')).toHaveText(SYNTAX_EXAMPLES[3].analysis.text)
  expect(await page.locator('.reader-scroll .section-body p').nth(3).textContent()).toBe(
    SYNTAX_EXAMPLES[3].analysis.text
  )
  expect(await page.locator('.syntax-light-layer [data-unit-index="5"]').count()).toBe(0)
  await page.getByRole('button', { name: /隐含关系的参与者/ }).click()
  await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-relation', 'participants')
  await expect(page.locator('.syntax-light-layer .is-active')).toHaveCount(2)
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('control links preserve repeated names, keyboard access and removal on editing', async () => {
  await analyze(1)
  await expect(page.locator('.syntax-light-layer')).toHaveAttribute(
    'data-relation',
    'leave_control'
  )
  const button = page.getByRole('button', { name: /留下者是谁/ })
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.syntax-light-layer')).toHaveAttribute('data-relation', 'stay_control')
  const indices = await page
    .locator('.syntax-light-layer .is-active')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-unit-index')))
  expect(new Set(indices)).toEqual(new Set(['6', '7']))
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.syntax-light-layer')).toHaveCount(0)
  expect(await readFile(file, 'utf8')).toBe(source)
})

test('two cross-line references keep separate visible corridors and fading shoulders with motion stopped', async () => {
  const index = allExamples.length - 1
  const paragraph = page.locator('.reader-scroll .section-body p').nth(index)
  await paragraph.evaluate((el) => {
    const p = el as HTMLElement
    p.style.width = '10em'
    p.style.textIndent = '0'
    p.style.lineHeight = '2.5'
  })
  await analyze(index)
  await page.getByRole('button', { name: '收起 AI 细读' }).click()
  const layer = page.locator('.syntax-light-layer:not(.automatic-syntax-light)')
  for (const name of ['琉璃', '潮光']) {
    await theme(name)
    await expect(layer.locator('.syntax-band-emergence').first()).toHaveCSS('opacity', '1')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(layer.locator('.syntax-semantic-breath').first()).toHaveCSS(
      'animation-name',
      'none'
    )
    const result = await layer.evaluate((el) =>
      ['person_chain', 'letter_chain'].map((id) => {
        const relation = el.querySelector(`[data-relation-id="${id}"]`)!
        const corridor = relation.querySelector('[data-part="corridor"] linearGradient')!
        if (!corridor) throw Error('Expected a printed cross-line corridor')
        return {
          id,
          x: Number(corridor.getAttribute('x1')),
          parts: ['entry', 'exit'].map((part) => {
            const node = relation.querySelector(`[data-part="${part}"]`)!
            const gradient = node.querySelector('linearGradient')!
            const surface = node.querySelector('.syntax-semantic-surface')!
            return {
              part,
              x1: Number(gradient.getAttribute('x1')),
              x2: Number(gradient.getAttribute('x2')),
              opacity: Number(getComputedStyle(surface).opacity),
              stops: [...gradient.querySelectorAll('stop')].map((s) =>
                Number(getComputedStyle(s).stopOpacity)
              )
            }
          })
        }
      })
    )
    expect(Math.abs(result[0].x - result[1].x)).toBeGreaterThanOrEqual(16)
    for (const relation of result)
      for (const part of relation.parts) {
        expect(part.x1).not.toBe(part.x2)
        expect(part.opacity).toBeGreaterThan(0)
        expect(part.stops[0]).toBe(0)
        expect(part.stops.at(-1)).toBe(0)
        expect(Math.max(...part.stops)).toBeGreaterThan(0.5)
      }
    await page.screenshot({ path: `work/syntax-v2/双照应-${name}.png` })
    await writeFile(`work/syntax-v2/双照应-${name}.json`, JSON.stringify(result, null, 2))
  }
  expect(await readFile(file, 'utf8')).toBe(source)
})
