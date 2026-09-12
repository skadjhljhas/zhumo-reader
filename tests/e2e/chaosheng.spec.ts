import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import {
  electron,
  assertBackgroundWindow,
  readClipboard,
  metricPath,
  executionMode
} from './runtime'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-tidal-'))
  path = join(root, '潮光阅读.md')
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      ZHUMO_USER_DATA: join(root, 'profile')
    }
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
  await page.locator('.space-swatches').getByRole('button', { name: '潮光', exact: true }).click()
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-ready', 'webgl')
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  if (root) {
    const target = resolve(root)
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target)).toMatch(/^zhumo-tidal-/)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
  }
})
async function open(source: string): Promise<void> {
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}
async function wordPoint(text: string): Promise<{ x: number; y: number }> {
  const paragraph = page.locator('.reader-scroll .section-body p').filter({ hasText: text }).first()
  await paragraph.scrollIntoViewIfNeeded()
  return paragraph.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = (node.textContent ?? '').indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    throw Error('Missing actual text')
  }, text)
}
const pixels = (): Promise<string> =>
  page.locator('.tidal-field').evaluate((el) => (el as HTMLCanvasElement).toDataURL())
async function settle(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let n = 0
        function next(): void {
          if (++n === 8) resolve()
          else requestAnimationFrame(next)
        }
        requestAnimationFrame(next)
      })
  )
}

test('GPU ocean light animates with blue depth in the real hidden renderer', async () => {
  const before = await pixels()
  await settle()
  expect(await pixels()).not.toBe(before)
  const colors = await page.locator('.tidal-field').evaluate((el) => {
    const canvas = el as HTMLCanvasElement,
      gl = canvas.getContext('webgl')!
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const sum = [0, 0, 0]
    let minBlue = 255,
      maxBlue = 0
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) sum[c] += pixels[i + c]
      minBlue = Math.min(minBlue, pixels[i + 2])
      maxBlue = Math.max(maxBlue, pixels[i + 2])
    }
    return {
      average: sum.map((n) => n / (canvas.width * canvas.height)),
      minBlue,
      maxBlue,
      error: gl.getError()
    }
  })
  expect(colors.average[2]).toBeGreaterThan(colors.average[1])
  expect(colors.average[1]).toBeGreaterThan(colors.average[0])
  expect(colors.maxBlue - colors.minBlue).toBeGreaterThan(20)
  expect(colors.error).toBe(0)
  await assertBackgroundWindow(app)
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/潮光-欢迎-微光.png', scale: 'css' })
  expect(errors).toEqual([])
})

test('dwelling silently records the original occurrence without moving or editing the manuscript', async () => {
  const source =
    '# 潮光\n\n自由在此刻抵达。[^甲]\n\n## 远处\n\n自由在另一句中被怀疑。\n\n[^甲]: 自由，仍需具体的理由。'
  await open(source)
  const point = await wordPoint('自由')
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await page.mouse.move(point.x, point.y)
  await expect(page.locator('html')).toHaveAttribute('data-tide-cursor', 'text')
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(CSS.highlights.get('reading-echo-current') ?? [])].map((range) => range.toString())
      )
    )
    .toEqual(['自由'])
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  await page.mouse.move(60, 20)
  await page.getByRole('button', { name: '回声：停留的字句', exact: true }).click()
  await expect(page.locator('.tidal-place-context')).toContainText('自由在此刻抵达')
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('native selection and explicit editing take precedence over pointer ornament', async () => {
  const source = '# 读到这里\n\n读者仍然能够选择自己的文字。'
  await open(source)
  const point = await wordPoint('读者')
  await page.mouse.move(point.x, point.y)
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has('reading-echo-current')))
    .toBe(true)
  await page.mouse.down()
  await expect(page.locator('html')).toHaveAttribute('data-tide-cursor', 'native')
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  await page.mouse.up()
  await page.locator('.reader-scroll .section-body p').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('Control+c')
  expect(await readClipboard(app)).toBe('读者仍然能够选择自己的文字。')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => CSS.highlights.has('reading-echo-current') || CSS.highlights.has('reading-echo-after')
    )
  ).toBe(false)
  await expect(page.locator('html')).toHaveAttribute('data-tide-cursor', 'native')
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('actual annotation levels retain their material and return path', async () => {
  await open(
    '# 入口\n\n这里进入[^甲]。\n\n[^甲]: 第一层。[^乙]\n\n[^乙]: 第二层。[^丙]\n\n[^丙]: 第三层。'
  )
  const reference = page.locator('.reader-scroll .zmu-ref').first()
  await reference.locator('.zmu-ref-mark').hover()
  await expect(page.locator('.tidal-tether path')).toHaveCount(1, { timeout: 350 })
  await reference.focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '1')
  await page.locator('.note-peek .zmu-ref .zmu-ref-mark').click()
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '2')
  await expect(page.locator('.peek-shell')).toHaveCSS('--tide-sheet-tone', 'rgb(20, 44, 72)')
  const second = await page
    .locator('.peek-shell')
    .evaluate((el) => getComputedStyle(el).backgroundImage)
  await page.locator('.note-peek .zmu-ref .zmu-ref-mark').click()
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '3')
  await expect(page.locator('.peek-shell')).toHaveCSS('--tide-sheet-tone', 'rgb(27, 52, 84)')
  expect(
    await page.locator('.peek-shell').evaluate((el) => getComputedStyle(el).backgroundImage)
  ).not.toBe(second)
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '2')
  await expect(page.locator('.peek-shell')).toHaveCSS('--tide-sheet-tone', 'rgb(20, 44, 72)')
  expect(
    await page.locator('.peek-shell').evaluate((el) => getComputedStyle(el).backgroundImage)
  ).toBe(second)
  await expect(page.locator('.peek-reading')).toContainText('第二层')
  expect(errors).toEqual([])
})

test('quiet, off and reduced motion keep a static material and a native pointer', async () => {
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-tide-motion', 'still')
  await settle()
  const still = await pixels()
  await settle()
  expect(await pixels()).toBe(still)
  await page.getByRole('button', { name: '光影：静谧', exact: true }).click()
  await expect(page.locator('.tidal-field')).toBeHidden()
  await expect(page.locator('.manuscript-light')).toHaveCSS('visibility', 'hidden')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '光影：关闭', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-tide-motion', 'still')
  await settle()
  const reduced = await pixels()
  await settle()
  expect(await pixels()).toBe(reduced)
  await expect(page.locator('html')).toHaveAttribute('data-tide-cursor', 'native')
  expect(errors).toEqual([])
})

test('lost graphics context preserves the static page and can recover', async () => {
  await page.locator('.tidal-field').evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext('webgl')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    ;(window as Window & { restoreTide?: () => void }).restoreTide = () =>
      extension.restoreContext()
    extension.loseContext()
  })
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-ready', 'fallback')
  expect(
    await page
      .locator('.chaosheng-atmosphere')
      .evaluate((el) => getComputedStyle(el).backgroundImage)
  ).not.toBe('none')
  await expect(page.locator('.manuscript-light-canvas')).toHaveAttribute('data-ready', 'webgl')
  await expect(page.getByText('另有天地。')).toBeVisible()
  await page.evaluate(() => (window as Window & { restoreTide?: () => void }).restoreTide!())
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-ready', 'webgl')
  await settle()
  const before = await pixels()
  await settle()
  expect(await pixels()).not.toBe(before)
  expect(errors).toEqual([])
})

test('small reading windows retain usable text and switching themes releases all tide effects', async () => {
  await open(await readFile('docs/chaosheng-reading.md', 'utf8'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  if (!(await page.getByRole('button', { name: '收起目录', exact: true }).isVisible()))
    await page.getByRole('button', { name: '切换目录', exact: true }).click()
  await page.getByRole('button', { name: '收起目录', exact: true }).click()
  const paragraph = page.locator('.reader-scroll .section-body p').first()
  await paragraph.scrollIntoViewIfNeeded()
  expect(await paragraph.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  const point = await wordPoint('后来')
  await page.mouse.move(point.x, point.y)
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has('reading-echo-current')))
    .toBe(true)
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/潮光-小窗口.png', scale: 'css' })
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page.locator('.theme-choice').filter({ hasText: '朱砂书院' }).click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
  await expect(page.locator('.tidal-field')).toHaveCount(0)
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => CSS.highlights.has('reading-echo-current') || CSS.highlights.has('reading-echo-after')
    )
  ).toBe(false)
  expect(await page.locator('html').getAttribute('data-tide-cursor')).toBeNull()
  expect(errors).toEqual([])
})

test('the tidal space remains readable through a long manuscript with three thousand notes', async () => {
  test.setTimeout(60000)
  const source = await readFile('src/renderer/public/demo/stress-50w.md', 'utf8')
  const started = Date.now()
  await open(source)
  const loadAndFontMs = Date.now() - started
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const scroll = document.querySelector('.reader-scroll') as HTMLElement
        const started = performance.now()
        function step(now: number): void {
          const fraction = Math.min(1, (now - started) / 4000)
          scroll.scrollTop = fraction * (scroll.scrollHeight - scroll.clientHeight)
          if (fraction < 1) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
  )
  await expect(page.locator('.section-frame').last().locator('.section-body')).toBeVisible()
  await expect(page.locator('.notes-meta')).toContainText('3000')
  const result = await page.evaluate(() => ({
    sections: document.querySelectorAll('.section-frame').length,
    mountedNotes: document.querySelectorAll('.notes-scroll .note-card').length,
    memoryMarks:
      (CSS.highlights.get('reading-echo-current')?.size ?? 0) +
      (CSS.highlights.get('reading-echo-after')?.size ?? 0),
    elements: document.querySelectorAll('*').length
  }))
  expect(result.sections).toBeGreaterThan(40)
  expect(result.mountedNotes).toBeLessThan(80)
  expect(result.memoryMarks).toBeLessThanOrEqual(2)
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-ready', 'webgl')
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(await readFile(path, 'utf8')).toBe(source)
  await writeFile(
    metricPath('chaosheng-long-reading.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        chars: source.length,
        loadAndFontMs,
        ...result,
        errors,
        screenFpsBenchmark: false
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
})

test('the GPU water carries bounded impulses and loses their residue after the pointer leaves', async () => {
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-solver', 'float-wave')
  await page.evaluate(() => {
    const gl = (document.querySelector('.tidal-field') as HTMLCanvasElement).getContext('webgl')!
    const targets = new Map<WebGLFramebuffer, { width: number; height: number }>()
    const draw = gl.drawArrays
    gl.drawArrays = function (mode, first, count): void {
      draw.call(gl, mode, first, count)
      const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      if (framebuffer) {
        const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array
        targets.set(framebuffer, { width: viewport[2], height: viewport[3] })
      }
    }
    const target = window as Window & {
      tideState?: () => {
        targets: number
        maxHeight: number
        maxVelocity: number
        residue: number
        finite: boolean
        error: number
      }
    }
    target.tideState = () => {
      const before = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      let maxHeight = 0,
        maxVelocity = 0,
        residue = 0,
        finite = true,
        count = 0
      for (const [framebuffer, size] of targets) {
        if (!gl.isFramebuffer(framebuffer)) continue
        count++
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        const values = new Float32Array(size.width * size.height * 4)
        gl.readPixels(0, 0, size.width, size.height, gl.RGBA, gl.FLOAT, values)
        for (let i = 0; i < values.length; i += 4) {
          finite =
            finite &&
            Number.isFinite(values[i]) &&
            Number.isFinite(values[i + 1]) &&
            Number.isFinite(values[i + 2])
          maxHeight = Math.max(maxHeight, Math.abs(values[i]))
          maxVelocity = Math.max(maxVelocity, Math.abs(values[i + 1]))
          residue += values[i + 2]
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, before)
      return { targets: count, maxHeight, maxVelocity, residue, finite, error: gl.getError() }
    }
  })
  const air = page.locator('.welcome-art')
  await air.scrollIntoViewIfNeeded()
  await expect(air).toBeInViewport({ ratio: 1 })
  const surface = (await air.boundingBox())!
  for (let i = 0; i < 4; i++) {
    const y = surface.y + surface.height * (0.35 + i * 0.1)
    await page.mouse.move(surface.x + surface.width * 0.15, y)
    await page.mouse.move(surface.x + surface.width * 0.85, y, { steps: 24 })
  }
  await page.mouse.move(32, 20)
  await settle()
  const state = (): Promise<{
    targets: number
    maxHeight: number
    maxVelocity: number
    residue: number
    finite: boolean
    error: number
  }> =>
    page.evaluate(() =>
      (
        window as Window & {
          tideState?: () => {
            targets: number
            maxHeight: number
            maxVelocity: number
            residue: number
            finite: boolean
            error: number
          }
        }
      ).tideState!()
    )
  const before = await state()
  expect(before.targets).toBe(2)
  expect(before.finite).toBe(true)
  expect(before.error).toBe(0)
  expect(before.maxHeight).toBeGreaterThan(0.0001)
  expect(before.maxHeight).toBeLessThanOrEqual(0.151)
  expect(before.maxVelocity).toBeLessThanOrEqual(0.081)
  expect(before.residue).toBeGreaterThan(1)
  await page.waitForTimeout(1200)
  const after = await state()
  expect(after.finite).toBe(true)
  expect(after.residue).toBeLessThan(before.residue * 0.95)
  expect(after.error).toBe(0)
  await writeFile(
    metricPath('chaosheng-water.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        before,
        after,
        screenFpsBenchmark: false
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
})

test('punctuation is treated as printed text without offering a spurious word search', async () => {
  await open('# 一个逗号\n\n读到这里，稍作停留。')
  const point = await wordPoint('，')
  await page.mouse.move(point.x, point.y)
  await expect(page.locator('html')).toHaveAttribute('data-tide-cursor', 'text')
  await page.waitForTimeout(3500)
  expect(await page.evaluate(() => CSS.highlights.has('reading-echo-current'))).toBe(false)
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the shore retains its animated analytic material without floating-point render targets', async () => {
  await page
    .locator('.space-swatches')
    .getByRole('button', { name: '朱砂书院', exact: true })
    .click()
  await expect(page.locator('.tidal-field')).toHaveCount(0)
  await page.evaluate(() => {
    const original = WebGLRenderingContext.prototype.getExtension
    Object.defineProperty(WebGLRenderingContext.prototype, 'getExtension', {
      configurable: true,
      value: function (this: WebGLRenderingContext, name: string): unknown {
        return name === 'OES_texture_float' ? null : original.call(this, name)
      }
    })
  })
  await page.locator('.space-swatches').getByRole('button', { name: '潮光', exact: true }).click()
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-solver', 'analytic')
  await expect(page.locator('.tidal-field')).toHaveAttribute('data-ready', 'webgl')
  const before = await pixels()
  await settle()
  expect(await pixels()).not.toBe(before)
  expect(
    await page
      .locator('.tidal-field')
      .evaluate((el) => (el as HTMLCanvasElement).getContext('webgl')!.getError())
  ).toBe(0)
  expect(errors).toEqual([])
})

test('both manuscript lights keep their encounter through disk saves and renew it on reopening', async () => {
  test.setTimeout(60000)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1500, 980)
  )
  const initial = '# 光的来路\n\n这份文字属于同一次阅读。[^甲]\n\n[^甲]: 注释也保留它的来处。'
  await open(initial)
  async function uniform(name: string): Promise<number[]> {
    return page.locator('.manuscript-light-canvas').evaluate((element, name) => {
      const gl = (element as HTMLCanvasElement).getContext('webgl')!
      const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram
      const location = gl.getUniformLocation(program, name)
      if (!location) throw new Error('Missing live manuscript uniform: ' + name)
      return Array.from(gl.getUniform(program, location) as Float32Array)
    }, name)
  }
  let source = initial
  for (const theme of ['chaosheng', 'lucent']) {
    if (theme === 'lucent') {
      await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
      await page
        .locator('.theme-choice')
        .filter({ has: page.locator('.theme-mini.lucent') })
        .click()
      await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    }
    await expect(page.locator('.manuscript-light')).toHaveAttribute('data-measured', 'true')
    await expect(page.locator('.manuscript-light')).toHaveCSS('opacity', '1')
    const beforeSeed = await uniform('encounter'),
      beforeShape = await uniform('structure')
    await page.getByRole('button', { name: '开启编辑', exact: true }).click()
    await expect(page.locator('.preview-label')).toContainText('与源文同步')
    await page.locator('.cm-content').press('Control+End')
    const beforeInput = await page.evaluate(() => ({
      selection: window.getSelection()?.toString(),
      collapsed: window.getSelection()?.isCollapsed,
      format: document.querySelector('.editor-position')?.textContent,
      platform: navigator.platform
    }))
    const addition = '\n\n## 保存后继续\n\n' + '保存之后，仍然是同一次阅读。'.repeat(240) + '\n'
    // Multi-line content uses the editor's paste path. CDP Input.insertText is an
    // IME-style DOM operation and collapsed one terminal empty line in this case.
    await page.locator('.cm-content').evaluate((element, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
      )
    }, addition)
    source += addition
    await expect(page.locator('.unsaved-dot')).toBeVisible()
    await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
    try {
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
    } catch (error) {
      const actual = await readFile(path, 'utf8')
      let difference = 0
      while (
        difference < Math.min(actual.length, source.length) &&
        actual[difference] === source[difference]
      )
        difference++
      const diagnostic = {
        theme,
        beforeInput,
        expectedLength: source.length,
        actualLength: actual.length,
        difference,
        expectedAround: source.slice(Math.max(0, difference - 30), difference + 60),
        actualAround: actual.slice(Math.max(0, difference - 30), difference + 60),
        editorPosition: await page.locator('.editor-position').textContent(),
        expectedTail: source.slice(-30),
        actualTail: actual.slice(-30)
      }
      await writeFile(
        metricPath('manuscript-native-save-diagnostic.json'),
        JSON.stringify(diagnostic, null, 2)
      )
      console.info('Native save diagnostic:', JSON.stringify(diagnostic))
      throw error
    }
    await page.getByRole('button', { name: '阅读', exact: true }).click()
    await expect(page.locator('.cm-editor')).toHaveCount(0)
    // The reading scroller deliberately has no tabindex. Claim the reading
    // surface before a document shortcut; a focused toolbar owns its own keys.
    await page.locator('.reader-scroll').click({ position: { x: 12, y: 90 } })
    await page.keyboard.press('Control+Home')
    await expect(page.locator('.document-overture')).toBeInViewport({ ratio: 1 })
    await expect
      .poll(async () => (await uniform('structure'))[0])
      .toBeGreaterThan(beforeShape[0] + 0.01)
    expect(await uniform('encounter')).toEqual(beforeSeed)
    await page.getByRole('button', { name: '打开书籍', exact: true }).click()
    await expect(page.locator('.manuscript-light')).toHaveAttribute('data-measured', 'true')
    await expect(page.locator('.manuscript-light')).toHaveCSS('opacity', '1')
    await expect
      .poll(async () => {
        const seed = await uniform('encounter')
        return (
          seed.length === 4 &&
          seed.some((value) => value !== 0) &&
          seed.some((value, index) => value !== beforeSeed[index])
        )
      })
      .toBe(true)
    expect(await readFile(path, 'utf8')).toBe(source)
  }
  await assertBackgroundWindow(app)
  expect(errors).toEqual([])
})

test('the unfolding surfaces keep long annotation text and return coordinates stationary', async () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) =>
      '第' +
      (i + 1) +
      '段。' +
      '文字应当在自己的位置等待返回。'.repeat(7) +
      (i === 23 ? '[^乙]' : '')
  )
  await open(
    '# 回到岸边\n\n入口[^甲]。\n\n[^甲]: ' +
      paragraphs.join('\n\n    ') +
      '\n\n[^乙]: 深入之后，再回到原句。'
  )
  await page.locator('.reader-scroll .zmu-ref').focus()
  await page.keyboard.press('Shift+Enter')
  const link = page.locator('.note-peek .zmu-ref .zmu-ref-mark')
  await link.scrollIntoViewIfNeeded()
  const before = await page.locator('.peek-reading').evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(800)
  await page.locator('.peek-reading').evaluate((el) => {
    el.addEventListener(
      'click',
      () => {
        ;(window as Window & { tidalDeparture?: number }).tidalDeparture = el.scrollTop
      },
      { once: true, capture: true }
    )
  })
  await link.click()
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '2')
  await expect(page.locator('.peek-reading')).toBeFocused()
  const rect = await page.locator('.peek-reading p').boundingBox()
  await expect(page.locator('.peek-shell')).toHaveCSS('--tide-sheet-tone', 'rgb(20, 44, 72)')
  const later = await page.locator('.peek-reading p').boundingBox()
  expect(Math.abs(later!.x - rect!.x)).toBeLessThan(1)
  expect(Math.abs(later!.y - rect!.y)).toBeLessThan(1)
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.locator('.peek-shell')).toHaveAttribute('data-note-level', '1')
  const departure = await page.evaluate(
    () => (window as Window & { tidalDeparture?: number }).tidalDeparture!
  )
  await expect
    .poll(() => page.locator('.peek-reading').evaluate((el) => el.scrollTop))
    .toBeCloseTo(departure, 0)
  await expect(link).toBeInViewport()
  expect(errors).toEqual([])
})
