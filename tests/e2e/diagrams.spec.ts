import { READING_THEME_NAMES } from './theme-catalog'
import { electron, readClipboard } from './runtime'
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-diagrams-'))
  path = join(root, '图解阅读.md')
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
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
async function ready(figure: Locator): Promise<void> {
  await figure.scrollIntoViewIfNeeded()
  await expect(figure).toHaveAttribute('data-diagram-state', 'ready', { timeout: 15000 })
  await expect(figure.locator('.diagram-canvas > svg')).toBeVisible()
}
async function validIds(): Promise<void> {
  const faults = await page.evaluate(() => {
    const seen = new Set<string>(),
      faults: string[] = []
    document.querySelectorAll('.zmu-diagram svg,.diagram-dialog svg').forEach((svg) => {
      const own = new Set([svg.id, ...[...svg.querySelectorAll('[id]')].map((node) => node.id)])
      for (const id of own) {
        if (!id) continue
        if (seen.has(id)) faults.push(`duplicate:${id}`)
        seen.add(id)
      }
      for (const node of [svg, ...svg.querySelectorAll('*')]) {
        for (const attr of [...node.attributes]) {
          for (const match of attr.value.matchAll(/url\(#([^)]+)\)/g))
            if (!own.has(match[1])) faults.push(`missing:${match[1]}`)
          if (
            ['href', 'xlink:href'].includes(attr.name) &&
            attr.value.startsWith('#') &&
            !own.has(attr.value.slice(1))
          )
            faults.push(`href:${attr.value}`)
        }
      }
      const style = svg.querySelector('style')?.textContent ?? ''
      if (style.includes('#zhumo-layout-'))
        faults.push(`${svg.id}: ${style.match(/.{0,30}#zhumo-layout-.{0,80}/g)?.join(' | ')}`)
    })
    return faults
  })
  expect(faults).toEqual([])
}

test('flow, sequence, mindmap, state and chart diagrams render from the original manuscript', async () => {
  const source = await readFile('docs/diagram-reading-example.md', 'utf8')
  await open(source)
  const figures = page.locator('.reader-scroll .zmu-diagram')
  await expect(figures).toHaveCount(5)
  for (let i = 0; i < 5; i++) {
    await ready(figures.nth(i))
    expect(
      await figures
        .nth(i)
        .locator('svg')
        .evaluate((svg) => svg.getBoundingClientRect().height)
    ).toBeGreaterThan(100)
    expect(await figures.nth(i).locator('svg').textContent()).not.toContain('Syntax error')
  }
  await validIds()
  if (!(await page.getByRole('button', { name: '一座桥，几种走法', exact: true }).isVisible()))
    await page.getByRole('button', { name: '切换目录', exact: true }).click()
  await page.getByRole('button', { name: '一座桥，几种走法', exact: true }).click()
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/diagrams-reading.png', scale: 'css' })
  expect(await readFile(path, 'utf8')).toBe(source)
  await expect(page.locator('[contenteditable=true]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('wide diagrams fit, zoom, pan and navigate through the overview, with source and focus preserved', async () => {
  const diagram =
    'flowchart LR\n' +
    Array.from({ length: 25 }, (_, i) => `N${i}[第${i + 1}次重新出发] --> N${i + 1}`).join('\n') +
    '\n'
  const source =
    '\uFEFF# 一条长路\r\n\r\n```mermaid\r\n' +
    diagram.replace(/\n/g, '\r\n') +
    '```\r\n\r\n原文的位置。\r\n'
  await open(source)
  const figure = page.locator('.reader-scroll .zmu-diagram')
  await ready(figure)
  const origin = figure.locator('.diagram-canvas')
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await origin.focus()
  await page.keyboard.press('Enter')
  const area = page.locator('.diagram-viewport')
  await expect(area).toBeFocused()
  const fits = (): Promise<boolean> =>
    area.evaluate((el) => {
      const child = el.querySelector('.diagram-enlarged')?.getBoundingClientRect(),
        bounds = el.getBoundingClientRect()
      return (
        !!child &&
        child.left >= bounds.left - 1 &&
        child.right <= bounds.right + 1 &&
        child.top >= bounds.top - 1 &&
        child.bottom <= bounds.bottom + 1
      )
    })
  await expect.poll(fits).toBe(true)
  await validIds()
  await page.getByRole('button', { name: '实际大小', exact: true }).click()
  await expect(page.locator('.diagram-controls output')).toHaveText('100%')
  expect(await area.evaluate((el) => el.scrollWidth)).toBeGreaterThan(3000)
  await area.evaluate((el) => el.scrollTo(200, 0))
  await area.focus()
  const rect = (await area.boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width / 2 - 140, rect.y + rect.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  expect(await area.evaluate((el) => el.scrollLeft)).toBeGreaterThan(300)
  const map = page.locator('.diagram-map'),
    mapRect = (await map.boundingBox())!
  await map.click({ position: { x: mapRect.width * 0.85, y: mapRect.height / 2 } })
  expect(await area.evaluate((el) => el.scrollLeft / el.scrollWidth)).toBeGreaterThan(0.65)
  await map.focus()
  await page.keyboard.press('Enter')
  expect(
    await area.evaluate((el) => (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth)
  ).toBeCloseTo(0.5, 2)
  await area.focus()
  await page.keyboard.press('+')
  await expect(page.locator('.diagram-controls output')).toHaveText('125%')
  await page.keyboard.press('f')
  await expect.poll(fits).toBe(true)
  await page.getByRole('button', { name: '源文', exact: true }).click()
  await expect(page.locator('.diagram-source-panel pre')).toHaveText(diagram)
  await expect.poll(fits).toBe(true)
  await page.getByRole('button', { name: '复制源文', exact: true }).click()
  await expect(page.locator('.diagram-copy-status')).toHaveText('Mermaid 源文已复制')
  await expect
    .poll(() => readClipboard(app).then((text) => text.replace(/\r\n/g, '\n')))
    .toBe(diagram)
  await page.getByRole('button', { name: '复制 SVG', exact: true }).click()
  await expect(page.locator('.diagram-copy-status')).toHaveText('SVG 已复制')
  await expect.poll(() => readClipboard(app)).toContain('<svg')
  const svg = await readClipboard(app)
  expect(svg).toContain('<svg')
  expect(svg).toContain('第25次重新出发')
  expect(svg).not.toContain('#zhumo-layout-')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await expect.poll(fits).toBe(true)
  await expect(page.getByRole('button', { name: '适合图解', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expect(page.getByRole('button', { name: '复制 SVG', exact: true })).toBeInViewport({
    ratio: 1
  })
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/diagrams-small.png', scale: 'css' })
  await page.keyboard.press('Escape')
  await expect(origin).toBeFocused()
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('diagram detail stacks above nested annotation sheets and the book panorama without moving them', async () => {
  await open(await readFile('docs/diagram-reading-example.md', 'utf8'))
  const ref = page
    .locator('.reader-scroll')
    .getByRole('button', { name: '阅读注释 箭头', exact: true })
  await ref.focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.note-peek:popover-open.is-expanded')).toBeVisible()
  const noteFigure = page.locator('.peek-reading .zmu-diagram')
  await ready(noteFigure)
  const opener = noteFigure.getByRole('button', { name: '展开图解', exact: true })
  await opener.scrollIntoViewIfNeeded()
  const scroll = await page.locator('.peek-reading').evaluate((el) => el.scrollTop)
  await opener.click()
  await expect(page.locator('.note-peek:popover-open')).toBeVisible()
  await expect(page.locator('.diagram-head')).toContainText('旁注 · 箭头')
  await expect(page.locator('.diagram-enlarged svg')).toBeVisible()
  await validIds()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  await expect(page.locator('.note-peek:popover-open')).toBeVisible()
  expect(await page.locator('.peek-reading').evaluate((el) => el.scrollTop)).toBe(scroll)
  await page
    .locator('.peek-reading')
    .getByRole('button', { name: '阅读注释 条件', exact: true })
    .locator('.zmu-ref-mark')
    .click()
  await ready(page.locator('.peek-reading .zmu-diagram'))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全书长卷', exact: true }).click()
  const panorama = page.locator('.panorama-excerpt .zmu-diagram')
  await ready(panorama)
  const panelOpener = panorama.getByRole('button', { name: '展开图解', exact: true })
  await panelOpener.click()
  await expect(page.locator('.diagram-head')).toContainText('一座桥，几种走法')
  await expect(page.locator('.diagram-enlarged svg')).toBeVisible()
  await validIds()
  await page.keyboard.press('Escape')
  await expect(panelOpener).toBeFocused()
  await expect(page.locator('.panorama-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '全书长卷', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '查看注释脉络 箭头', exact: true }).click()
  const atlasFigure = page.locator('.atlas-reading .zmu-diagram')
  await ready(atlasFigure)
  const atlasOpener = atlasFigure.getByRole('button', { name: '展开图解', exact: true })
  await atlasOpener.click()
  await expect(page.locator('.diagram-enlarged svg')).toBeVisible()
  await validIds()
  await page.keyboard.press('Escape')
  await expect(atlasOpener).toBeFocused()
  await expect(page.locator('.atlas-dialog')).toBeVisible()
  expect(errors).toEqual([])
})

test('diagram math and technical relationships retain labels, markers and native MathML', async () => {
  const diagrams = [
    String.raw`flowchart LR
      A["$$E=mc^2$$"] --> B["$$\int_0^1 x^2 dx=\frac{1}{3}$$"]`,
    String.raw`sequenceDiagram
      Alice->>Bob: $$\sqrt{a^2+b^2}$$
      Bob-->>Alice: The response`,
    'classDiagram\n  Reader <|-- Writer\n  Reader : +read()\n  Writer : +save()',
    'erDiagram\n  BOOK ||--o{ NOTE : contains\n  NOTE {\n    string label\n    string source\n  }',
    'timeline\n  title 一座桥的时间\n  2020 : 眺望\n  2022 : 相遇\n  2024 : 回望'
  ]
  await open(
    '# 图中仍有公式\n\n' +
      diagrams.map((code, i) => `## 图式${i}\n\n` + '```mermaid\n' + code + '\n```').join('\n\n')
  )
  const figures = page.locator('.reader-scroll .zmu-diagram')
  for (let i = 0; i < diagrams.length; i++) await ready(figures.nth(i))
  for (let i = 0; i < 2; i++) {
    const math = figures.nth(i).locator('math').first()
    await expect(math).toHaveCount(1)
    expect(await math.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(10)
  }
  await validIds()
  await page.getByRole('button', { name: '图式0', exact: true }).click()
  await figures.first().getByRole('button', { name: '展开图解', exact: true }).click()
  await expect(page.locator('.diagram-enlarged math')).toHaveCount(2)
  await page.getByRole('button', { name: '复制 SVG', exact: true }).click()
  await expect(page.locator('.diagram-copy-status')).toHaveText('SVG 已复制')
  await expect.poll(() => readClipboard(app)).toContain('<math')
  const copied = await readClipboard(app)
  expect(
    await page.evaluate((source) => {
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
      return {
        errors: parsed.querySelectorAll('parsererror').length,
        formulas: parsed.querySelectorAll('math').length
      }
    }, copied)
  ).toEqual({ errors: 0, formulas: 2 })
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/diagrams-math.png', scale: 'css' })
  await validIds()
  expect(errors).toEqual([])
})

test('all nine themes repaint the same diagram and retain legible labels at small window sizes', async () => {
  await open(
    '# 主题中的结构\n\n```mermaid\nflowchart LR\n  A[经验] --> B{追问}\n  B --> C[新的理解]\n```'
  )
  const figure = page.locator('.reader-scroll .zmu-diagram')
  await ready(figure)
  const themes = READING_THEME_NAMES
  for (const theme of themes) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    const choices = await page.locator('.theme-choice').allTextContents()
    const choice = page.locator('.theme-choice').filter({ hasText: theme })
    expect(
      choices.some((text) => text.includes(theme)),
      choices.join(' / ')
    ).toBe(true)
    await choice.click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await ready(figure)
    const contrast = await figure.locator('svg').evaluate((svg) => {
      const node = svg.querySelector('.node')!,
        rect = node.querySelector('rect,polygon,path')!,
        label = node.querySelector('text')!
      return {
        fill: getComputedStyle(rect).fill,
        text: getComputedStyle(label).fill,
        textWidth: label.getBoundingClientRect().width
      }
    })
    expect(contrast.fill).not.toBe(contrast.text)
    expect(contrast.textWidth).toBeGreaterThan(10)
    if (theme === '琉璃' || theme === '星辰' || theme === '潮光') {
      await figure.getByRole('button', { name: '展开图解', exact: true }).click()
      await expect(page.locator('.diagram-enlarged svg')).toBeVisible()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
      await expect(page.getByRole('button', { name: '复制 SVG', exact: true })).toBeInViewport({
        ratio: 1
      })
      await mkdir('work/screens', { recursive: true })
      await page.screenshot({ path: `work/screens/diagrams-theme-${theme}.png`, scale: 'css' })
      await page.keyboard.press('Escape')
      if (await page.getByRole('button', { name: '收起目录', exact: true }).isVisible())
        await page.getByRole('button', { name: '收起目录', exact: true }).click()
    }
  }
  await validIds()
  expect(errors).toEqual([])
})

test('mindmap branches retain theme contrast and circular labels stay centered in all nine themes', async () => {
  await open(
    '# 圆与支线\n\n```mermaid\nmindmap\n  root((一座桥))\n    连接\n      circle((回到原处))\n    记忆\n      第一次经过\n```'
  )
  const figure = page.locator('.reader-scroll .zmu-diagram')
  for (const theme of READING_THEME_NAMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: theme }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await ready(figure)
    const reading = await figure.locator('svg').evaluate((svg) => {
      const luminance = (color: string): number => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const component = value / 255
            return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
          })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      return {
        nodes: [...svg.querySelectorAll('.mindmap-node')].map((node) => {
          const shape = node.querySelector(
            ':scope > circle,:scope > .node-bkg,:scope > .label-container'
          )!
          const text = node.querySelector('.label text')!
          const paper = luminance(getComputedStyle(shape).fill),
            ink = luminance(getComputedStyle(text).fill)
          const shapeRect = shape.getBoundingClientRect(),
            labelRect = text.getBoundingClientRect()
          return {
            label: text.textContent,
            contrast: (Math.max(paper, ink) + 0.05) / (Math.min(paper, ink) + 0.05),
            circle: shape.tagName === 'circle',
            centerError: Math.abs(
              shapeRect.x + shapeRect.width / 2 - labelRect.x - labelRect.width / 2
            ),
            fits: labelRect.left >= shapeRect.left - 1 && labelRect.right <= shapeRect.right + 1
          }
        }),
        connectors: [...svg.querySelectorAll('.edge[class*="section-edge-"]')].map(
          (edge) => getComputedStyle(edge).stroke
        )
      }
    })
    expect(reading.nodes, theme).toHaveLength(5)
    for (const node of reading.nodes) {
      expect(node.contrast, `${theme}: ${node.label}`).toBeGreaterThanOrEqual(4.5)
      if (node.circle) {
        expect(node.centerError, `${theme}: ${node.label}`).toBeLessThan(1)
        expect(node.fits, `${theme}: ${node.label}`).toBe(true)
      }
    }
    expect(reading.nodes.filter((node) => node.circle)).toHaveLength(2)
    expect(reading.connectors).toHaveLength(4)
    expect(reading.connectors).not.toContain('rgb(0, 0, 0)')
  }
  await validIds()
  expect(errors).toEqual([])
})

test('malformed diagrams retain source and recover through explicit editing and the annotation writer', async () => {
  const original =
    '\uFEFF# 图与改写\r\n\r\n```mermaid\r\nflowchart LR\r\n  A[尚未闭合\r\n```\r\n\r\n一处旁注[^圈]。\r\n\r\n[^圈]: 留下一个位置。\r\n'
  await open(original)
  const invalid = page.locator('.reader-scroll .zmu-diagram')
  await expect(invalid).toHaveAttribute('data-diagram-state', 'error', { timeout: 15000 })
  await expect(invalid.locator('.diagram-source')).toBeVisible()
  await invalid.getByRole('button', { name: '展开图解', exact: true }).click()
  await expect(page.locator('.diagram-error')).toContainText('Parse error')
  await expect(page.locator('.diagram-source-panel pre')).toContainText('尚未闭合')
  await page.keyboard.press('Escape')
  expect(await readFile(path, 'utf8')).toBe(original)
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(original.replace('A[尚未闭合', 'A[重新展开] --> B[抵达]'))
  const preview = page.locator('.draft-preview .zmu-diagram').first()
  await ready(preview)
  await expect(preview.locator('svg')).toContainText('重新展开')
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await page.getByRole('button', { name: '开启编辑并修改注释 圈', exact: true }).click()
  const note = page.getByRole('textbox', { name: '注释正文编辑器', exact: true })
  await note.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(
    '用图解释这一处。\n\n```mermaid\nflowchart LR\n  A[来处] --> B[去处]\n```'
  )
  const notePreview = page.locator('.writer-preview .zmu-diagram')
  await ready(notePreview)
  await notePreview.getByRole('button', { name: '展开图解', exact: true }).click()
  await expect(page.locator('.diagram-enlarged svg')).toContainText('来处')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '保存 Ctrl S', exact: true }).click()
  await expect(page.locator('.unsaved-dot')).toHaveCount(0)
  const written = await readFile(path, 'utf8')
  expect(written).toContain('    ```mermaid')
  expect(written).toContain('A[来处] --> B[去处]')
  expect(written.startsWith('\uFEFF# 图与改写')).toBe(true)
  await expect(page.locator('.diagram-layout-scratch')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('whole-book source search lands on a distant visible diagram while lazy layout stays bounded', async () => {
  const source =
    '# 从此出发\n\n每一页有自己的结构。\n\n' +
    Array.from(
      { length: 120 },
      (_, i) =>
        `# 图的第${i}页\n\n${'沿着文字读过这一段。'.repeat(90)}\n\n` +
        '```mermaid\nflowchart LR\n' +
        `  A[来处${i}] --> B[独有远处${i}终]\n` +
        '```\n\n'
    ).join('')
  await open(source)
  await ready(page.locator('.reader-scroll .zmu-diagram').first())
  const firstCount = await page
    .locator('.reader-scroll .zmu-diagram[data-diagram-state="ready"]')
    .count()
  expect(firstCount).toBeLessThan(12)
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '搜索正文与旁注' }).fill('独有远处119终')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  const landing = page.locator('.reader-scroll .zmu-diagram.search-landed')
  await expect(landing).toBeInViewport()
  await ready(landing)
  await expect(landing.locator('svg')).toContainText('独有远处119终')
  const height = await landing.evaluate((el) => el.getBoundingClientRect().height)
  await landing.getByRole('button', { name: '查看源文', exact: true }).click()
  await expect(landing.locator('.diagram-source')).toBeVisible()
  expect(await landing.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)
  await landing.getByRole('button', { name: '查看图解', exact: true }).click()
  expect(await landing.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)
  expect(await page.locator('.reader-scroll .zmu-diagram svg').count()).toBeLessThan(20)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('diagram directives cannot execute links or change the application theme and valid text remains', async () => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url())
  })
  await open(
    '# 文稿里的图\n\n```mermaid\n%%{init: {"securityLevel":"loose","theme":"dark","htmlLabels":true}}%%\nflowchart LR\n  A["保留的文字"] --> B["继续阅读"]\n  click A "https://example.invalid/diagram-target"\n```'
  )
  const figure = page.locator('.reader-scroll .zmu-diagram')
  await ready(figure)
  await expect(figure.locator('svg')).toContainText('保留的文字')
  await expect(figure.locator('svg a,svg script,svg iframe')).toHaveCount(0)
  const fill = await figure
    .locator('svg .node rect')
    .first()
    .evaluate((node) => getComputedStyle(node).fill)
  expect(fill).toBe('rgb(234, 245, 250)')
  expect(requests).toEqual([])
  await validIds()
  expect(errors).toEqual([])
})
