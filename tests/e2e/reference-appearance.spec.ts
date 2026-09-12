import { READING_THEME_NAMES } from './theme-catalog'
import { electron, readClipboard, metricPath, executionMode } from './runtime'
import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, path: string
let errors: string[]
const source =
  '# 在页边辨认一个声音\n\n原句[^一]，还有另一种理解[^二]。\n\n' +
  '让原句拥有继续阅读的空间。'.repeat(80) +
  '\n\n[^一]: 第一条思路，仍然可以继续展开。[^二]\n\n[^二]: 再往里读。[^三]\n\n[^三]: 深处的声音。[^四]\n\n[^四]: 一条仍可辨认的支线。[^五]\n\n[^五]: 这里也有文字。'
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-reference-appearance-'))
  path = join(root, '注号的明暗.md')
  await writeFile(path, source)
  app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function appearance(
  marker: Locator
): Promise<{ ratio: number; opacity: number; backgroundAlpha: number }> {
  return marker.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    const rgba = (value: string): number[] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = value
      ctx.fillRect(0, 0, 1, 1)
      return [...ctx.getImageData(0, 0, 1, 1).data].map((x) => x / 255)
    }
    const over = (a: number[], b: number[]): number[] =>
      [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1)
    const luminance = (color: number[]): number =>
      color
        .slice(0, 3)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const style = getComputedStyle(element),
      sup = getComputedStyle(element.closest('.zmu-ref')!)
    const base = rgba(getComputedStyle(document.documentElement).getPropertyValue('--bg'))
    const paper = rgba(style.backgroundColor),
      background = over(paper, base)
    const ink = over(rgba(style.color), background),
      opacity = Number(sup.opacity)
    const a = luminance(over(ink.slice(0, 3).concat(opacity), base))
    const b = luminance(over(background.slice(0, 3).concat(opacity), base))
    return {
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      opacity,
      backgroundAlpha: paper[3]
    }
  })
}
const themes = READING_THEME_NAMES
async function theme(name: string): Promise<void> {
  await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
  await page.locator('.theme-choice').filter({ hasText: name }).click()
  await page.getByRole('button', { name: '回到阅读', exact: true }).click()
}

test('all nine themes keep active, hovered, focused and deep reference numbers readable', async () => {
  const measured: object[] = []
  for (const name of themes) {
    await theme(name)
    const reference = page.locator('.reader-scroll .zmu-ref').first()
    const active = reference.locator('.zmu-ref-mark')
    await reference
      .locator('xpath=ancestor::p')
      .evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await expect(reference, name + ': reading paragraph is active').toHaveClass(/is-active/)
    for (const state of ['active', 'hover', 'keyboard', 'peek']) {
      if (state === 'hover') await active.hover()
      if (state === 'keyboard') await reference.focus()
      if (state === 'peek') {
        await page.keyboard.press('Shift+Enter')
        await expect(page.locator('.note-peek:popover-open')).toBeVisible()
      }
      const sample = await appearance(active)
      expect(sample.ratio, name + ': ' + state).toBeGreaterThanOrEqual(4.5)
      expect(sample.backgroundAlpha).toBe(1)
      measured.push({ theme: name, state, ...sample })
    }
    await page.keyboard.press('Escape')
    await page.mouse.move(70, 20)
    const deep = page.locator('.notes-scroll .zmu-ref[data-level="4"] .zmu-ref-mark').first()
    await deep.scrollIntoViewIfNeeded()
    for (const state of ['deep', 'deep-hover']) {
      if (state === 'deep-hover') await deep.hover()
      const sample = await appearance(deep)
      expect(sample.ratio, name + ': ' + state).toBeGreaterThanOrEqual(4.5)
      measured.push({ theme: name, state, ...sample })
    }
  }
  await writeFile(
    metricPath('reference-appearance.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        executionMode,
        measured,
        scope:
          'Small reference glyphs; root theme background is used behind transparent idle marks. Active plates are opaque. This is not a whole-page contrast audit.',
        errors
      },
      null,
      2
    )
  )
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('keyboard reading focus uses a quiet edge while copying, selection and returning keep their meaning', async () => {
  await mkdir('work/screens', { recursive: true })
  for (const name of ['琉璃', '星辰', '潮光']) {
    await theme(name)
    const reference = page.locator('.reader-scroll .zmu-ref').first()
    const paragraph = reference.locator('xpath=ancestor::p')
    const before = await paragraph.boundingBox()
    await reference.focus()
    await page.keyboard.press('Shift+Enter')
    const reading = page.locator('.peek-reading')
    await expect(reading).toBeFocused()
    const focus = await reading.evaluate((el) => ({
      outline: getComputedStyle(el).outlineStyle,
      shadow: getComputedStyle(el).boxShadow,
      active: document.activeElement === el
    }))
    expect(focus.active).toBe(true)
    expect(focus.outline).toBe('none')
    expect(focus.shadow).not.toBe('none')
    await expect
      .poll(() =>
        page.locator('.peek-shell').evaluate((el) => Number(getComputedStyle(el).opacity))
      )
      .toBe(1)
    await page.screenshot({ path: 'work/screens/reference-focus-' + name + '.png', scale: 'css' })
    await reading
      .locator('p')
      .first()
      .evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
    await page.keyboard.press('Control+c')
    expect(await readClipboard(app)).toContain('第一条思路')
    await page.keyboard.press('Escape')
    await expect(reference).toBeFocused()
    const after = await paragraph.boundingBox()
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(0.5)
    expect(await reference.getAttribute('title')).toBeNull()
  }
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})
