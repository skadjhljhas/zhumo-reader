import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron } from './runtime'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'
const text = '并非每位编辑都没有读过至少一篇来稿。'
const unit = (id: string, quote: string, role: string, extra?: string): unknown => ({
  id,
  role,
  layer: 'meaning',
  anchors: [{ quote, occurrence: 1 }, ...(extra ? [{ quote: extra, occurrence: 1 }] : [])],
  label: '固定四算子样例',
  explanation: '固定语言结构用于绘制检查。',
  evidence: '采用至少一篇在内层否定之内的读法。',
  status: 'supported'
})
const units = [
  unit('n0', '并非', 'negation'),
  unit('q0', '每位', 'quantifier', '都'),
  unit('n1', '没有', 'negation'),
  unit('q1', '至少一篇', 'quantifier'),
  unit('d0', '每位编辑都没有读过至少一篇来稿', 'clause'),
  unit('d1', '没有读过至少一篇来稿', 'clause'),
  unit('d2', '读过至少一篇来稿', 'clause'),
  unit('d3', '读过', 'predicate')
]
const relations = ['n0', 'q0', 'n1', 'q1'].map((from, i) => ({
  id: 'r' + i,
  kind: 'scope',
  from,
  to: ['d' + i],
  ...(i ? { within: 'r' + (i - 1) } : {}),
  label: '原文算子的明确环境',
  explanation: '固定组合次序。',
  evidence: '固定结构而非模型推断。',
  status: 'supported'
}))
test('four operators form separate 2D fields and a visible original-word hierarchy without scope underlines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-scope-fields-')),
    file = join(root, '多算子的阅读.md'),
    profile = join(root, 'profile')
  const source = '# 原词之间的次序\n\n' + text + '\n'
  let app: ElectronApplication | undefined,
    requests = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const output =
        JSON.stringify({ type: 'begin', version: 3 }) +
        JSON.stringify({ type: 'patch', units, relations }) +
        JSON.stringify({
          type: 'done',
          summary: '固定窄域读法：有编辑读过来稿，不推出每位都读过。'
        })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output } }] }) + '\n\n')
      res.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n'
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await mkdir(profile)
    await mkdir('work/scopes27', { recursive: true })
    await writeFile(file, source)
    await writeFile(
      join(profile, 'ai-models.v1.json'),
      JSON.stringify({
        version: 1,
        syntax: {
          revision: 'scope-fixture',
          settings: {
            ...defaultAiProfile('syntax'),
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            model: 'fixed-scope-fixture',
            context: 'selection'
          }
        }
      })
    )
    app = await electron.launch({
      executablePath: process.env.ZHUMO_E2E_EXE,
      args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
      env: { ...process.env, ZHUMO_USER_DATA: profile }
    })
    const page = await app.firstWindow()
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    const field = page.locator('.automatic-syntax-light .syntax-scope-fields')
    await expect(field.locator('.syntax-scope-field-branch')).toHaveCount(4, { timeout: 10000 })
    await expect(field.locator('.syntax-band-emergence').last()).toHaveCSS('opacity', '1')
    await expect(page.locator('.automatic-syntax-light .syntax-relation-band')).toHaveCount(0)
    await expect(
      field.locator(
        '[data-scope-id="r0"] > [data-scope-id="r1"] > [data-scope-id="r2"] > [data-scope-id="r3"]'
      )
    ).toHaveCount(1)
    for (const [i, quote] of ['并非', '每位…都', '没有', '至少一篇'].entries()) {
      const token = field.locator(`[data-spectrum-operator="r${i}"]`)
      await expect(token).toHaveText(quote)
      await expect(token).toHaveAttribute('data-scope-depth', String(i))
      await expect(token).toBeVisible()
    }
    const paragraph = page.locator('.reader-scroll .section-body p')
    await expect(paragraph).toHaveText(text)
    await expect(paragraph).toHaveCSS('opacity', '1')
    await page.screenshot({ path: 'work/scopes27/lucent-four-operators.png' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('.automatic-syntax-light').evaluate((el) => {
      ;(el as SVGElement).style.filter = 'grayscale(1)'
    })
    await page.screenshot({ path: 'work/scopes27/grayscale-four-operators.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 800))
    // Below 1120px the previously open desktop TOC becomes a modal drawer. Its backdrop
    // actually covers this paragraph; cached light must not paint through the navigation UI.
    await expect(page.locator('.toc-backdrop')).toBeVisible()
    await expect(field).toHaveCount(0)
    await page.getByRole('button', { name: '收起目录', exact: true }).click()
    await expect(page.locator('.toc-backdrop')).toHaveCount(0)
    await expect(field.locator('.syntax-scope-field-branch')).toHaveCount(4)
    await expect(field.locator('[data-spectrum-operator]')).toHaveCount(4)
    await expect(field.locator('.syntax-band-emergence').last()).toHaveCSS('opacity', '1')
    for (const [i, quote] of ['并非', '每位…都', '没有', '至少一篇'].entries()) {
      const token = field.locator(`[data-spectrum-operator="r${i}"]`)
      await expect(token).toHaveText(quote)
      await expect(token).toHaveAttribute('data-scope-depth', String(i))
      await expect(token).toBeVisible()
    }
    await expect(
      field.locator(
        '[data-scope-id="r0"] > [data-scope-id="r1"] > [data-scope-id="r2"] > [data-scope-id="r3"]'
      )
    ).toHaveCount(1)
    await writeFile(
      'work/scopes27/narrow-reading-verification.json',
      JSON.stringify(
        await page.evaluate(() => ({
          fieldPresent: Boolean(
            document.querySelector('.automatic-syntax-light .syntax-scope-fields')
          ),
          placement: document
            .querySelector('.automatic-syntax-light [data-scope-spectrum]')
            ?.getAttribute('data-placement'),
          operators: [
            ...document.querySelectorAll('.automatic-syntax-light [data-spectrum-operator]')
          ].map((el) => ({ text: el.textContent, depth: el.getAttribute('data-scope-depth') })),
          reader: document.querySelector('.reader-scroll')?.getBoundingClientRect().toJSON(),
          paragraph: document
            .querySelector('.reader-scroll .section-body p')
            ?.getBoundingClientRect()
            .toJSON(),
          scrollTop: document.querySelector('.reader-scroll')?.scrollTop,
          viewport: [innerWidth, innerHeight],
          rows: (() => {
            const p = document.querySelector('.reader-scroll .section-body p')
            if (!p) return []
            const range = document.createRange()
            range.selectNodeContents(p)
            return [...range.getClientRects()].map((rect) => ({
              ...rect.toJSON(),
              hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.className
            }))
          })()
        })),
        null,
        2
      )
    )
    expect(requests).toBe(1)
    await page.screenshot({ path: 'work/scopes27/reflow-four-operators.png' })
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const relativeRoot = relative(await realpath(tmpdir()), await realpath(root))
    expect(relativeRoot.startsWith('zhumo-scope-fields-') && !relativeRoot.includes('..')).toBe(
      true
    )
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
