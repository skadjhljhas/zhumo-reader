import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { electron } from './runtime'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAiProfile } from '../../src/shared/ai-types'

async function hoverWord(page: Page, text: string): Promise<void> {
  const paragraph = page.locator('.reader-scroll .section-body p').filter({ hasText: text }).first()
  await paragraph.scrollIntoViewIfNeeded()
  const p = await paragraph.evaluate((el, quote) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = node.textContent!.indexOf(quote)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + quote.length)
      const r = range.getClientRects()[0]
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    throw Error('Missing word')
  }, text)
  await page.mouse.move(p.x, p.y)
}

for (const theme of ['琉璃', '潮光'])
  test(`${theme}: echo and semantic ink coexist, actual climate/annotation inputs reach the field, and GPU loss restores visible still light`, async () => {
    test.setTimeout(65000)
    const root = await mkdtemp(join(tmpdir(), 'zhumo-echo-integration-')),
      profile = join(root, 'profile'),
      file = join(root, '让光留在字后.md')
    const source =
      '# 让光留在字后\n\n月光抵达原句，文字依旧清晰。[^光]\n\n星光留在另一句，阅读仍然继续。\n\n[^光]: 旁注让一个判断保留其背景，也让阅读能够回来。\n'
    let app: ElectronApplication | undefined
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()),
          input = JSON.parse(body.messages.at(-1).content)
        const textColor = input.readingAppearance.theme === 'chaosheng' ? '#bcdff5' : '#386491'
        const output = [
          { type: 'begin', version: 4 },
          {
            type: 'mark',
            quote: input.selectedText.slice(0, 2),
            occurrence: 1,
            textColor,
            glowColor: '#e7bd91'
          },
          { type: 'done' }
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
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
      await mkdir('work/echo30', { recursive: true })
      await writeFile(file, source)
      await writeFile(
        join(profile, 'ai-models.v1.json'),
        JSON.stringify({
          version: 1,
          syntax: {
            revision: 'echo-color-fixture',
            settings: {
              ...defaultAiProfile('syntax'),
              model: 'fixture-only',
              context: 'selection',
              endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
            }
          }
        })
      )
      app = await electron.launch({
        executablePath: process.env.ZHUMO_E2E_EXE,
        args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
        env: { ...process.env, ZHUMO_USER_DATA: profile }
      })
      const page = await app.firstWindow(),
        errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1560, 1080)
      )
      await page
        .locator('.space-swatches')
        .getByRole('button', { name: theme, exact: true })
        .click()
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true })
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      })
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, file)
      await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
      const compact = page.locator('.tidal-memory-rail .echo-field')
      await expect(compact).toHaveAttribute('data-ready', 'webgl')
      await expect
        .poll(() =>
          compact.locator('.echo-field-canvas').evaluate((canvas) => {
            const gl = (canvas as HTMLCanvasElement).getContext('webgl')!,
              program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
            return gl.getUniform(program, gl.getUniformLocation(program, 'annotation')!)
          })
        )
        .toBeGreaterThan(0)
      // Inspect actual linked uniforms, and render the real shader at midnight/noon in one task.
      const climate = await compact.locator('.echo-field-canvas').evaluate((canvas) => {
        const gl = (canvas as HTMLCanvasElement).getContext('webgl')!,
          program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
        const location = gl.getUniformLocation(program, 'climate')!
        const original = [...gl.getUniform(program, location)]
        const ratio = (cos: number): number => {
          gl.uniform4f(location, original[0], original[1], 0, cos)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
          gl.readPixels(
            0,
            0,
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bytes
          )
          let red = 0,
            blue = 0
          for (let i = 0; i < bytes.length; i += 4) {
            red += bytes[i]
            blue += bytes[i + 2]
          }
          return red / Math.max(1, blue)
        }
        const night = ratio(1),
          noon = ratio(-1)
        gl.uniform4f(location, original[0], original[1], original[2], original[3])
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        return {
          night,
          noon,
          annotation: gl.getUniform(program, gl.getUniformLocation(program, 'annotation')!)
        }
      })
      expect(climate.noon).toBeGreaterThan(climate.night)
      expect(climate.annotation).toBeGreaterThan(0)
      expect(climate.annotation).toBeLessThan(1)
      await expect(page.locator('.reading-color-mark')).toHaveCount(2, { timeout: 12000 })
      await hoverWord(page, '月光')
      await expect
        .poll(() => page.evaluate(() => CSS.highlights.has('reading-echo-current')), {
          timeout: 6000
        })
        .toBe(true)
      const priorities = await page.evaluate(() => {
        const semantic = [...CSS.highlights].find(
          ([name, h]) =>
            name.startsWith('zhumo-reading-color-') &&
            [...h].some((r) => (r as Range).toString() === '月光')
        )!
        return {
          semantic: semantic[1].priority,
          echo: CSS.highlights.get('reading-echo-current')!.priority
        }
      })
      expect(priorities.semantic).toBeGreaterThan(priorities.echo)
      await expect
        .poll(() =>
          page.locator('.reading-echo-light').evaluate((canvas) => {
            const c = canvas as HTMLCanvasElement,
              bytes = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
            return bytes.some((v, i) => i % 4 === 3 && v > 0)
          })
        )
        .toBe(true)
      await expect(page.locator('.reading-echo-light')).toHaveCSS('z-index', '0')
      await page.screenshot({ path: `work/echo30/${theme}-原文与回声.png` })
      await page.getByRole('button', { name: '展开回声', exact: true }).hover()
      await expect(page.getByRole('button', { name: '展开回声', exact: true })).toHaveCSS(
        'cursor',
        'none'
      )
      await page.mouse.move(60, 20)
      await expect(compact).toHaveAttribute('data-count', '1')
      await hoverWord(page, '星光')
      await page.waitForTimeout(3500)
      await page.mouse.move(60, 20)
      await expect(compact).toHaveAttribute('data-count', '2')
      await page.getByRole('button', { name: '展开回声', exact: true }).click()
      const field = page.locator('.tidal-memory-dialog .echo-field')
      await expect(field).toHaveAttribute('data-ready', 'webgl')
      await page.screenshot({ path: `work/echo30/${theme}-回声光场.png` })
      await field.locator('.echo-field-canvas').evaluate((canvas) => {
        const gl = (canvas as HTMLCanvasElement).getContext('webgl')!,
          extension = gl.getExtension('WEBGL_lose_context')!
        ;(canvas as HTMLCanvasElement & { restoreEcho?: () => void }).restoreEcho = () =>
          extension.restoreContext()
        extension.loseContext()
      })
      await expect(field).toHaveAttribute('data-ready', 'still')
      await expect
        .poll(() =>
          field.locator('.echo-field-still').evaluate((canvas) => {
            const c = canvas as HTMLCanvasElement,
              data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
            return data.some((v, i) => i % 4 === 3 && v > 0)
          })
        )
        .toBe(true)
      await field
        .locator('.echo-field-canvas')
        .evaluate((canvas) =>
          (canvas as HTMLCanvasElement & { restoreEcho: () => void }).restoreEcho()
        )
      await expect(field).toHaveAttribute('data-ready', 'webgl')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(120)
      const frozen = await field.getAttribute('data-frames')
      await page.waitForTimeout(250)
      expect(await field.getAttribute('data-frames')).toBe(frozen)
      await page.getByRole('button', { name: '关闭回声', exact: true }).click()
      expect(await readFile(file, 'utf8')).toBe(source)
      expect(errors).toEqual([])
    } finally {
      await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
