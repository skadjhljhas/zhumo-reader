import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultAiProfile } from '../../src/shared/ai-types'
import type { SyntaxTarget } from '../../src/shared/syntax-passages'
let app: ElectronApplication,
  page: Page,
  root: string,
  file: string,
  source: string,
  server: Server,
  endpoint: string
const requests: Array<{
  selectedText: string
  syntaxTarget?: SyntaxTarget
  markdownContext?: { before: string; after: string }
}> = []
const longText = '并非每一种变化都意味着理解已经完成，'.repeat(100) + '所以我们仍需检查整个论证。'
const crossText =
  '林向陈承诺，在把信中的每一段推理与来信的时间逐一对照、' +
  '把旅途留下的记录与记忆中的次序重新核对，'.repeat(8) +
  '并把尚未说清的问题记在页边以后，于黎明前离开。'
const unit = (id: string, quote: string, role: string): Record<string, unknown> => ({
  id,
  layer: 'meaning',
  role,
  label: '固定关系单位',
  anchors: [{ quote, occurrence: 1 }],
  explanation: '固定接口检查。',
  evidence: '逐字引用本次目标。',
  status: 'supported'
})
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const bytes: Buffer[] = []
    req.on('data', (p) => bytes.push(p))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(bytes).toString()),
        user = JSON.parse(body.messages.at(-1).content)
      requests.push(user)
      const text = user.selectedText as string
      const math = user.syntaxTarget?.regions.find((r: { kind: string }) => r.kind === 'math')
      const code = user.syntaxTarget?.regions.find((r: { kind: string }) => r.kind === 'code')
      const a = math ? text.slice(math.start, math.end) : text.includes('价格') ? '价格' : '并非'
      const b = text.includes('成立')
        ? '成立'
        : text.includes('意味着')
          ? '意味着'
          : text.includes('价格')
            ? '是'
            : '检查'
      const units = text.startsWith('林向陈承诺')
        ? [unit('a', '林', 'referent'), unit('b', '离开', 'predicate')]
        : [
            unit('a', a, math ? 'referent' : 'negation'),
            unit('b', b, 'predicate'),
            ...(code ? [unit('c', text.slice(code.start, code.end), 'referent')] : [])
          ]
      const relations: Array<Record<string, unknown>> = [
        {
          id: text.startsWith('林向陈承诺')
            ? 'margin-control'
            : text.startsWith('并非')
              ? 'long-r'
              : 'r',
          kind: text.startsWith('林向陈承诺') ? 'control' : 'dependency',
          from: 'b',
          to: code ? ['a', 'c'] : ['a'],
          label: '固定的混排关系',
          explanation: '核对原文投影与显影。',
          evidence: '固定案例。',
          status: 'supported'
        }
      ]
      if (text.startsWith('并非') && text.includes('每一种变化都意味着理解已经完成')) {
        units.splice(
          0,
          units.length,
          unit('a', '并非', 'negation'),
          unit('b', '每一种变化都意味着理解已经完成', 'clause'),
          unit('q', '每一种变化', 'quantifier'),
          unit('c', '都意味着理解已经完成', 'clause')
        )
        relations.splice(
          0,
          relations.length,
          {
            id: 'long-r',
            kind: 'scope',
            from: 'a',
            to: ['b'],
            label: '否定覆盖全称判断',
            explanation: '固定的并非所有读法。',
            evidence: '固定关系检查。',
            status: 'supported'
          },
          {
            id: 'long-q',
            kind: 'scope',
            from: 'q',
            to: ['c'],
            within: 'long-r',
            label: '全称判断位于否定之内',
            explanation: '固定的嵌套范围。',
            evidence: '固定关系检查。',
            status: 'supported'
          }
        )
      }
      const lines = [
        { type: 'begin', version: 3 },
        { type: 'patch', units, relations },
        { type: 'done', summary: '混排与窗口格式检查完成。' }
      ]
        .map((x) => JSON.stringify(x) + '\n')
        .join('')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: lines } }] }) + '\n\n')
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
  requests.length = 0
  root = await mkdtemp(join(tmpdir(), 'zhumo-mixed-'))
  file = join(root, '混排.md')
  await mkdir(join(root, 'profile'))
  await mkdir('work/mixed', { recursive: true })
  source =
    '\uFEFF# 混排的阅读\r\n\r\n若 $x>0$ 成立，表达式 `f(x)` 才进入这个讨论；这里的条件不应被忽略。\r\n\r\n$\\frac{x}{y}$ 意味着一个比值，仍须结合上下文。\r\n\r\n' +
    longText +
    '\r\n\r\n这里 $ 价格 $ 是普通文字，不把它作为已排版公式。\r\n\r\n```js\r\nconst hidden = "代码块不作为语法目标";\r\n```\r\n\r\n' +
    crossText +
    '\r\n'
  await writeFile(file, source)
  await writeFile(
    join(root, 'profile/ai-models.v1.json'),
    JSON.stringify({
      version: 1,
      syntax: {
        revision: 'mixed-fixture',
        settings: { ...defaultAiProfile('syntax'), endpoint, model: 'mixed-fixture' }
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
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await page.evaluate(() => document.fonts.ready)
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
test('math and inline code no longer exclude surrounding language, and a formula maps to a single real visual region', async () => {
  const formula = page.locator('.reader-scroll .zmu-math').first()
  const original = await page.locator('.reader-scroll .section-body').first().innerHTML()
  await expect(
    page.locator('.reader-scroll .section-body p').nth(1).locator('.zmu-math')
  ).toHaveCount(1)
  await expect(
    page.locator('.reader-scroll .section-body p').nth(3).locator('.zmu-math')
  ).toHaveCount(0)
  await expect
    .poll(() => requests.some((r) => r.selectedText.includes('x>0')), { timeout: 20000 })
    .toBe(true)
  const request = requests.find((r) => r.selectedText.includes('x>0'))!
  expect(request.syntaxTarget?.regions.map((r) => r.kind)).toEqual(['math', 'code'])
  expect(
    request.syntaxTarget?.regions.map((r) => request.selectedText.slice(r.start, r.end))
  ).toEqual(['x>0', 'f(x)'])
  expect(request.markdownContext?.before).toContain('# 混排的阅读')
  await expect(
    page
      .locator('.automatic-syntax-light .syntax-meaning-field')
      .first()
      .locator('[data-unit-index="0"]')
  ).toHaveCount(1)
  const expected = await formula.boundingBox()
  const actual = await page
    .locator('.automatic-syntax-light .syntax-meaning-field')
    .first()
    .locator('[data-unit-index="0"]')
    .evaluate((el) => {
      const g = el as SVGGElement,
        m = g.transform.baseVal.consolidate()!.matrix
      return { x: m.e, y: m.f }
    })
  expect(Math.abs(actual.x - expected!.x)).toBeLessThan(2)
  expect(Math.abs(actual.y - (expected!.y + expected!.height + 2))).toBeLessThan(2)
  await expect
    .poll(() => requests.some((r) => r.selectedText.includes('\\frac')), { timeout: 18000 })
    .toBe(true)
  const beginning = requests.find((r) => r.selectedText.includes('\\frac'))!
  expect(beginning.syntaxTarget?.regions[0].start).toBe(0)
  await expect(page.locator('.automatic-syntax-light .syntax-band-emergence').first()).toHaveCSS(
    'opacity',
    '1'
  )
  expect(await page.locator('.reader-scroll .section-body').first().innerHTML()).toBe(original)
  expect(requests.some((r) => r.selectedText.includes('const hidden'))).toBe(false)
  await page.screenshot({ path: 'work/mixed/math-and-code.png' })
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('a whole rendered formula can be captured as source text without selecting hidden KaTeX text', async () => {
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByLabel('随阅读自动分析句法').uncheck()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await page
    .locator('.reader-scroll .zmu-math')
    .nth(1)
    .evaluate((el) => {
      const r = document.createRange()
      r.selectNode(el)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
  await page.getByRole('button', { name: 'AI 细读与句法之光', exact: true }).click()
  await expect(page.locator('.ai-context blockquote')).toHaveText('\\frac{x}{y}')
  expect(requests.length).toBe(0)
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('a long sentence creates bounded reading windows with context instead of being silently skipped', async () => {
  const p = page.locator('.reader-scroll .section-body p').nth(2)
  await p.evaluate((el) => {
    const root = el.closest('.reader-scroll')!
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 28
  })
  await expect
    .poll(() => requests.some((r) => r.selectedText.startsWith('并非')), { timeout: 22000 })
    .toBe(true)
  const first = requests.find((r) => r.selectedText.startsWith('并非'))!
  expect(first.selectedText.length).toBeLessThanOrEqual(480)
  expect(first.syntaxTarget?.endsMidSentence).toBe(true)
  expect(first.markdownContext?.after).toContain('所以我们仍需检查整个论证')
  const light = page
    .locator('.automatic-syntax-light .syntax-meaning-field')
    .filter({ has: page.locator('[data-relation-id="long-r"]') })
    .first()
  await expect(light.locator('[data-unit-index="0"]')).toBeVisible()
  await expect(light.locator('.syntax-band-emergence').first()).toHaveCSS('opacity', '1')
  const sourceRect = await p.evaluate((el) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) if (node.textContent?.startsWith('并非')) break
    if (!node) throw Error('Missing exact long-sentence text')
    range.setStart(node, 0)
    range.setEnd(node, 2)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, bottom: rect.bottom }
  })
  const lightRect = await light.locator('[data-unit-index="0"]').evaluate((el) => {
    const matrix = (el as SVGGElement).transform.baseVal.consolidate()!.matrix
    return { x: matrix.e, y: matrix.f }
  })
  expect(Math.abs(lightRect.x - sourceRect.x)).toBeLessThan(2)
  expect(Math.abs(lightRect.y - sourceRect.bottom - 2)).toBeLessThan(2)
  await page.screenshot({ path: 'work/mixed/long-sentence.png' })
  expect(await readFile(file, 'utf8')).toBe(source)
})
async function narrowLargeText(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByLabel('正文字号', { exact: true }).evaluate((el) => {
    const input = el as HTMLInputElement
    input.value = '24'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(page.locator('.reader-scroll .section-body p').nth(2)).toHaveCSS('font-size', '24px')
}
async function startOfLongSentence(): Promise<void> {
  await page
    .locator('.reader-scroll .section-body p')
    .nth(2)
    .evaluate((el) => {
      const root = el.closest('.reader-scroll')!
      root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 28
    })
}
test('a narrow viewport with large text admits a readable subwindow without requiring selection or cutting the sentence context', async () => {
  await narrowLargeText()
  await startOfLongSentence()
  const geometry = await page
    .locator('.reader-scroll .section-body p')
    .nth(2)
    .evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT),
        text = walker.nextNode()!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 480)
      return {
        wholeHeight: range.getBoundingClientRect().height,
        viewport: el.closest('.reader-scroll')!.getBoundingClientRect().height
      }
    })
  expect(geometry.wholeHeight).toBeGreaterThan(geometry.viewport / 0.7)
  await expect
    .poll(() => requests.some((r) => r.selectedText.startsWith('并非')), { timeout: 22000 })
    .toBe(true)
  const request = requests.find((r) => r.selectedText.startsWith('并非'))!
  expect(request.selectedText.length).toBeLessThan(480)
  expect(request.selectedText.length).toBeGreaterThan(30)
  expect(request.syntaxTarget?.endsMidSentence).toBe(true)
  expect(request.markdownContext?.after).toContain('所以我们仍需检查整个论证')
  const light = page
    .locator('.automatic-syntax-light .syntax-meaning-field')
    .filter({ has: page.locator('[data-relation-id="long-r"]') })
    .first()
  await expect(light.locator('[data-unit-index="0"]')).toBeVisible()
  await expect(light.locator('.syntax-band-emergence').first()).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'work/mixed/large-type-window.png' })
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('an already analyzed parent window supplies resized reading without requesting its smaller children again', async () => {
  test.setTimeout(60000)
  await startOfLongSentence()
  await expect
    .poll(() => requests.some((r) => r.selectedText.startsWith('并非')), { timeout: 22000 })
    .toBe(true)
  const parent = requests.find((r) => r.selectedText.startsWith('并非'))!
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="long-r"]').first()
  ).toBeVisible()
  await narrowLargeText()
  await startOfLongSentence()
  await page.waitForTimeout(11500)
  const start = parent.markdownContext!.before.length,
    end = start + parent.selectedText.length
  const children = requests.filter(
    (r) =>
      r.selectedText.length < parent.selectedText.length &&
      r.markdownContext &&
      r.markdownContext.before.length >= start &&
      r.markdownContext.before.length + r.selectedText.length <= end
  )
  expect(children).toEqual([])
  await expect(
    page.locator('.automatic-syntax-light [data-relation-id="long-r"]').first()
  ).toBeVisible()
  expect(await readFile(file, 'utf8')).toBe(source)
})
test('a cross-line control relation uses the real empty margin in both themes, including with animation paused', async () => {
  const paragraph = page.locator('.reader-scroll .section-body p').filter({ hasText: '林向陈承诺' })
  await paragraph.scrollIntoViewIfNeeded()
  await expect
    .poll(() => requests.some((r) => r.selectedText === crossText), { timeout: 22000 })
    .toBe(true)
  const relation = page.locator('.automatic-syntax-light [data-relation-id="margin-control"]')
  await expect(relation.locator('[data-route="margin"]')).toHaveCount(1)
  await expect(relation.locator('.syntax-band-emergence')).toHaveCSS('opacity', '1')
  for (const name of ['琉璃', '潮光']) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: name }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await expect(page.getByRole('button', { name: '回到阅读', exact: true })).toHaveCount(0)
    await expect(relation.locator('[data-route="margin"]')).toHaveCount(1)
    await expect(relation.locator('.syntax-band-emergence')).toHaveCSS('opacity', '1', {
      timeout: 10000
    })
    await writeFile(
      `work/mixed/margin-${name}-paint.json`,
      JSON.stringify(
        await relation.evaluate((el) => {
          const layer = el.closest('svg')!,
            p = el.querySelector('.syntax-semantic-surface')!
          return {
            layer: {
              visibility: getComputedStyle(layer).visibility,
              opacity: getComputedStyle(layer).opacity,
              strength: getComputedStyle(layer).getPropertyValue('--syntax-strength')
            },
            relation: {
              opacity: getComputedStyle(el).opacity,
              color: getComputedStyle(el).getPropertyValue('--grammar-color')
            },
            surface: { opacity: getComputedStyle(p).opacity, fill: getComputedStyle(p).fill },
            geometry: p.getAttribute('d')
          }
        }),
        null,
        2
      )
    )
    const rects = await paragraph.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return [...range.getClientRects()]
        .filter((r) => r.width > 3 && r.height > 3)
        .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }))
    })
    const points = await relation.locator('.syntax-semantic-surface').evaluateAll((elements) =>
      elements.flatMap((el) =>
        [...el.getAttribute('d')!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({
          x: Number(m[1]),
          y: Number(m[2])
        }))
      )
    )
    const top = Math.min(...rects.map((r) => r.top)),
      bottom = Math.max(...rects.map((r) => r.bottom))
    const middle = points.filter((p) => p.y > top + 40 && p.y < bottom - 40)
    expect(middle.length).toBeGreaterThan(0)
    expect(
      middle.every(
        (p) =>
          !rects.some((r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom)
      )
    ).toBe(true)
    const gradient = await relation
      .locator('[data-part="corridor"] linearGradient')
      .evaluate((el) => ({
        x1: el.getAttribute('x1'),
        x2: el.getAttribute('x2'),
        y1: el.getAttribute('y1'),
        y2: el.getAttribute('y2')
      }))
    expect(gradient.x1).toBe(gradient.x2)
    expect(gradient.y1).not.toBe(gradient.y2)
    await page.screenshot({ path: `work/mixed/margin-${name}.png` })
  }
  const full = page.getByRole('button', { name: '光影：丰沛', exact: true })
  if (await full.count()) await full.click()
  await expect(page.locator('.automatic-syntax-light')).toHaveAttribute('data-motion', 'quiet')
  await expect(relation.locator('.syntax-semantic-breath')).toHaveCSS('animation-name', 'none')
  await expect(relation.locator('[data-route="margin"]')).toBeVisible()
  expect(await readFile(file, 'utf8')).toBe(source)
})
