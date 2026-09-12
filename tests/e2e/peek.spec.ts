import { READING_THEMES } from './theme-catalog'
import { electron, readClipboard } from './runtime'
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-peek-'))
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
  if (test.info().status !== test.info().expectedStatus && page) {
    await mkdir('work/hover-guide', { recursive: true })
    await writeFile(
      `work/hover-guide/failure-${test.info().title.includes('240') ? '240' : 'small'}.json`,
      JSON.stringify(
        await page.evaluate(() => {
          const selectors = [
            '.reader-scroll .zmu-ref-mark',
            '.notes-scroll',
            '.notes-virtual-space',
            '.notes-scroll .note-card .note-mark',
            '.note-hover-guide'
          ]
          return {
            hidden: document.hidden,
            rows: selectors.map((selector) => {
              const el = document.querySelector(selector)
              if (!el) return { selector }
              const s = getComputedStyle(el)
              return {
                selector,
                rect: el.getBoundingClientRect().toJSON(),
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                paddingTop: s.paddingTop,
                paddingBottom: s.paddingBottom,
                html: el.outerHTML.slice(0, 600)
              }
            })
          }
        }),
        null,
        2
      )
    )
    await page.screenshot({ path: 'work/hover-guide/failure.png' })
  }
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function openSource(source: string): Promise<string> {
  const hasReader = !!(await page.locator('.reader-scroll').count())
  const path = join(root, hasReader ? '下一本文稿.md' : '就地阅读.md')
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  const reader = page.locator('.reader-scroll')
  if (hasReader) await page.getByRole('button', { name: '打开书籍', exact: true }).click()
  else await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(reader).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return path
}
const bodyRef = (label: string): Locator =>
  page
    .locator('.reader-scroll')
    .getByRole('button', { name: `阅读注释 ${label}`, exact: true })
    .first()

test('the themed cursor stays on note marks through hover preview and primary click', async () => {
  const source = '# 光标的入口\n\n正文中的注释入口[^甲]。\n\n[^甲]: 在此处继续阅读。'
  const path = await openSource(source)
  for (const [title, cursor, field] of [
    ['琉璃', '.optical-cursor', 'data-cursor-field'],
    ['潮光', '.tidal-cursor', 'data-tide-cursor'],
    ['星辰', '.optical-cursor', 'data-cursor-field']
  ]) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page
      .locator('.theme-choice')
      .filter({ has: page.locator('strong', { hasText: title }) })
      .click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    const mark = bodyRef('甲').locator('.zmu-ref-mark')
    await mark.hover()
    await expect(page.locator('html')).toHaveAttribute(field, 'control')
    await expect(mark).toHaveCSS('cursor', 'none')
    await expect(page.locator('.note-peek:popover-open')).toBeVisible()
    await expect(page.locator(cursor)).toHaveCSS('opacity', '1')
    await expect(page.locator('html')).toHaveAttribute(field, 'control')
    const bounds = await mark.boundingBox()
    if (!bounds) throw new Error('Missing note mark geometry')
    await page.mouse.move(bounds.x + bounds.width / 2 + 1, bounds.y + bounds.height / 2)
    await expect(page.locator('html')).toHaveAttribute(field, 'control')
    await mark.click()
    await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
    await expect(page.locator(cursor)).toHaveCSS('opacity', '1')
    await expect(page.locator('html')).toHaveAttribute(field, 'control')
    await expect(page.locator('.notes-scroll .note-card.is-reading')).toBeVisible()
    const returnLink = page.locator('.notes-scroll .note-card.is-reading .note-spot').first()
    await returnLink.hover()
    await expect(page.locator('html')).toHaveAttribute(field, 'control')
    await expect(returnLink).toHaveCSS('cursor', 'none')
    await expect(page.locator(cursor)).toHaveCSS('opacity', '1')
  }
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

async function expand(label: string): Promise<void> {
  await bodyRef(label).focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.note-peek:popover-open.is-expanded')).toBeVisible()
  await expect(page.locator('.peek-reading')).toBeFocused()
  await page
    .locator('.peek-shell')
    .evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
}

test('the first hover event after the reader appears is handled before any lazy dialog loading', async () => {
  await page.route('**/NotePeek-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.continue()
  })
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const reference = document.querySelector('.reader-scroll .zmu-ref')
      if (!reference) return
      observer.disconnect()
      reference.dispatchEvent(
        new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
      )
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await openSource('# 初次读到\n\n这里已经可以停留[^甲]。\n\n[^甲]: 第一次悬停就应该有回应。')
  await expect(page.locator('.note-peek:popover-open')).toBeVisible({ timeout: 1200 })
  await expect(page.locator('.peek-reading')).toContainText('第一次悬停就应该有回应')
  expect(errors).toEqual([])
})

test('hover previews without changing focus or manuscript, selection and primary clicks keep their meaning', async () => {
  const source =
    '# 原句\n\n文字附近有一个入口[^甲]，也有第二个入口[^乙]。\n\n[^甲]: 悬停只为预读，原文的位置不应改变。\n\n[^乙]: 第二种解释。'
  const path = await openSource(source)
  const reader = page.locator('.reader-scroll'),
    peek = page.locator('.note-peek:popover-open')
  await reader.focus()
  const before = await reader.evaluate((el) => el.scrollTop)
  await bodyRef('甲').locator('.zmu-ref-mark').hover()
  await expect(peek).toBeVisible()
  await expect(page.locator('.peek-reading')).toContainText('悬停只为预读')
  await expect(reader).toBeFocused()
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(before)
  await page.mouse.move(60, 20)
  await expect(peek).toHaveCount(0)
  await bodyRef('甲').locator('.zmu-ref-mark').hover()
  await page.waitForTimeout(140)
  await bodyRef('乙').locator('.zmu-ref-mark').hover()
  await expect(page.locator('.peek-reading')).toContainText('第二种解释')
  await bodyRef('乙').locator('.zmu-ref-mark').click()
  await expect(peek).toHaveCount(0)
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '乙'
  )
  await expand('甲')
  await page.locator('.peek-reading p').evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('Control+c')
  await expect.poll(() => readClipboard(app)).toContain('悬停只为预读')
  await expect(page.locator('.reading-selection')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(bodyRef('甲')).toBeFocused()
  expect(await reader.evaluate((el) => el.scrollTop)).toBe(before)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('long notes retain their departure paragraph through branches, resizing and explicit sidebar handoff', async () => {
  const paragraphs = Array.from(
    { length: 26 },
    (_, i) => `    第${i + 1}段。${'解释需要保留自己的展开空间。'.repeat(10)}`
  ).join('\n\n')
  await openSource(
    '# 继续阅读\n\n正文仍在这里[^根]。\n\n[^根]: 论述开始。\n\n' +
      paragraphs +
      '\n\n    进入第一支线[^旧]，或第二支线[^新]。\n\n[^旧]: 第一种解释，接着细读[^深]。\n\n[^新]: 新的解释。\n\n[^深]: 第三层给出理由。'
  )
  await expand('根')
  const reading = page.locator('.peek-reading')
  const bodyTop = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await reading.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await reading
    .getByRole('button', { name: '阅读注释 旧', exact: true })
    .locator('.zmu-ref-mark')
    .scrollIntoViewIfNeeded()
  const departure = await reading.evaluate((el) => el.scrollTop)
  await reading
    .getByRole('button', { name: '阅读注释 旧', exact: true })
    .locator('.zmu-ref-mark')
    .click()
  await expect(reading).toContainText('第一种解释')
  await reading.getByRole('button', { name: '阅读注释 深', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(reading).toContainText('第三层给出理由')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(reading).toContainText('第一种解释')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => reading.evaluate((el) => el.scrollTop)).toBeCloseTo(departure, 0)
  const oldBranch = reading.getByRole('button', { name: '阅读注释 旧', exact: true })
  await expect(oldBranch).toBeInViewport()
  const visibleParagraph = (): Promise<string | null | undefined> =>
    reading.evaluate(
      (el) =>
        [...el.querySelectorAll('p')].find(
          (p) => p.getBoundingClientRect().bottom > el.getBoundingClientRect().top + 12
        )?.textContent
    )
  const paragraph = await visibleParagraph()
  await page.getByRole('button', { name: '收回悬浮注页', exact: true }).click()
  await expect.poll(visibleParagraph).toBe(paragraph)
  await page.getByRole('button', { name: '展开为注页', exact: true }).click()
  await expect.poll(visibleParagraph).toBe(paragraph)
  await expect(oldBranch).toBeInViewport()
  await reading
    .getByRole('button', { name: '阅读注释 新', exact: true })
    .locator('.zmu-ref-mark')
    .click()
  await expect(page.getByRole('button', { name: '注页前进', exact: true })).toBeDisabled()
  await expect(page.locator('.peek-trail li')).toHaveCount(2)
  await page.locator('.peek-head').getByRole('button', { name: '固定注释 新', exact: true }).click()
  await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '新'
  )
  await expect(page.getByRole('button', { name: '取消固定注释 新', exact: true })).toBeVisible()
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(bodyTop)
  expect(errors).toEqual([])
})

test('formula detail stacks above the sheet and equation links return to the real manuscript', async () => {
  await openSource(String.raw`# 推导

从旁注进入公式[^式]。

\[\begin{equation}E=mc^2\label{body}\end{equation}\]

[^式]: 先看 $\eqref{body}$，再展开注中的公式。

    \[\begin{equation}a=b\label{note}\end{equation}\]
`)
  await expand('式')
  expect(await page.locator('[id="mjx-eqn:note"]').count()).toBe(1)
  const original = page.locator('.peek-reading .zmu-math-block')
  await original.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.math-dialog')).toBeVisible()
  await expect(page.locator('.note-peek:popover-open')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(original).toBeFocused()
  await page.locator('.peek-reading a[href="#mjx-eqn%3Abody"]').click()
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await expect(page.locator('.reader-scroll [id="mjx-eqn:body"]')).toBeInViewport()
  expect(errors).toEqual([])
})

test('inline-note switch persists and disables popovers while page-side guidance and editing remain available', async () => {
  await openSource('# 开关\n\n可以手动展开[^手动]。\n\n[^手动]: 关闭悬停之后，键盘仍能进入全文。')
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  const toggle = page.getByRole('switch', { name: '就地注释开关' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('button', { name: '就地阅读', exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  await bodyRef('手动').locator('.zmu-ref-mark').hover()
  await page.waitForTimeout(600)
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await expect(page.locator('.note-hover-guide')).toBeVisible()
  await bodyRef('手动').focus()
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await expand('手动')
  await page.getByRole('button', { name: '开启编辑', exact: true }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()
  await expect(page.locator('.note-peek')).toHaveCount(0)
  expect(errors).toEqual([])
})

for (const count of [3, 240]) {
  test(`hover guidance smoothly aligns first and last notes in a ${count}-note list without clicking`, async () => {
    const middle = Math.ceil(count / 2)
    const source =
      '# 页边相遇\n\n第一个入口[^N1]，中间入口[^N' +
      middle +
      ']，最后入口[^N' +
      count +
      ']。\n\n再一次[^N1]。\n\n' +
      '继续读正文。\n\n'.repeat(30) +
      Array.from(
        { length: count },
        (_, i) => `[^N${i + 1}]: 第${i + 1}条注释。${'段落仍保留自己的长度。'.repeat(i % 4)}\n`
      ).join('\n')
    const path = await openSource(source)
    if (count === 240) {
      await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
      await page
        .locator('.theme-choice')
        .filter({ has: page.locator('strong', { hasText: '潮光' }) })
        .click()
      await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    }
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page.getByRole('switch', { name: '就地注释开关', exact: true }).click()
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    const reader = page.locator('.reader-scroll')
    await bodyRef('N1').locator('.zmu-ref-mark').scrollIntoViewIfNeeded()
    await reader.focus()
    const before = await reader.evaluate((el) => el.scrollTop)
    async function hoverWithoutScrolling(mark: Locator): Promise<void> {
      const rect = await mark.boundingBox()
      if (!rect) throw new Error('Missing visible reference mark')
      await expect(mark).toBeInViewport()
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    }
    await page.locator('.notes-scroll').evaluate((el) => {
      const target = window as Window & { __hoverScrollSamples?: number[] }
      target.__hoverScrollSamples = []
      el.addEventListener('scroll', () => target.__hoverScrollSamples!.push(el.scrollTop))
    })
    for (const label of ['N1', 'N' + count]) {
      const mark = bodyRef(label).locator('.zmu-ref-mark')
      await hoverWithoutScrolling(mark)
      await expect(page.locator('.note-hover-guide')).toBeVisible()
      await expect(page.locator('.note-guide-line')).toHaveCSS(
        'animation-name',
        count === 240 ? 'tide-reference-light' : 'lucent-reference-light'
      )
      await expect(page.locator('.note-guide-line')).toHaveCSS(
        'stroke-dasharray',
        count === 240 ? '32px, 220px' : '18px, 180px'
      )
      await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
      await expect
        .poll(
          async () =>
            mark.evaluate((el) => {
              const id = el.closest<HTMLElement>('.zmu-ref')!.dataset.noteId!
              const target = document.querySelector(
                `.notes-scroll .note-card[data-note-id="${CSS.escape(id)}"] .note-mark`
              )
              if (!target) return 99999
              const a = el.getBoundingClientRect(),
                b = target.getBoundingClientRect()
              return Math.abs(a.top + a.height / 2 - b.top - b.height / 2)
            }),
          { timeout: 10000 }
        )
        .toBeLessThan(2)
      const lineBefore = await page.locator('.note-guide-line').getAttribute('d')
      await page.waitForTimeout(400)
      await expect(page.locator('.note-hover-guide')).toBeVisible()
      expect(await page.locator('.note-guide-line').getAttribute('d')).toBeTruthy()
      expect(lineBefore).toBeTruthy()
      expect(await reader.evaluate((el) => el.scrollTop)).toBe(before)
      await expect(reader).toBeFocused()
      const parkedTop = await page.locator('.notes-scroll').evaluate((el) => el.scrollTop)
      const parkedY = await mark.evaluate((el) => {
        const id = el.closest<HTMLElement>('.zmu-ref')!.dataset.noteId!
        return document
          .querySelector(`.notes-scroll .note-card[data-note-id="${CSS.escape(id)}"] .note-mark`)!
          .getBoundingClientRect().top
      })
      if (label === 'N' + count) {
        await mkdir('work/hover-guide', { recursive: true })
        await page.screenshot({ path: `work/hover-guide/afterglow-${count}.png` })
      }
      await page.mouse.move(60, 20)
      await expect(page.locator('.note-hover-guide')).toHaveCount(0)
      await page.waitForTimeout(700)
      expect(await page.locator('.notes-scroll').evaluate((el) => el.scrollTop)).toBe(parkedTop)
      expect(
        await mark.evaluate((el) => {
          const id = el.closest<HTMLElement>('.zmu-ref')!.dataset.noteId!
          return document
            .querySelector(`.notes-scroll .note-card[data-note-id="${CSS.escape(id)}"] .note-mark`)!
            .getBoundingClientRect().top
        })
      ).toBeCloseTo(parkedY, 0)
    }
    // A rapid retarget must cancel the previous animation and follow the exact repeated occurrence.
    await hoverWithoutScrolling(bodyRef('N' + middle).locator('.zmu-ref-mark'))
    const repeated = page
      .locator('.reader-scroll')
      .getByRole('button', { name: '阅读注释 N1', exact: true })
      .nth(1)
      .locator('.zmu-ref-mark')
    await hoverWithoutScrolling(repeated)
    await expect
      .poll(
        async () =>
          repeated.evaluate((el) => {
            const id = el.closest<HTMLElement>('.zmu-ref')!.dataset.noteId!
            const target = document.querySelector(
              `.notes-scroll .note-card[data-note-id="${CSS.escape(id)}"] .note-mark`
            )
            if (!target) return 99999
            const a = el.getBoundingClientRect(),
              b = target.getBoundingClientRect()
            return Math.abs(a.top + a.height / 2 - b.top - b.height / 2)
          }),
        { timeout: 10000 }
      )
      .toBeLessThan(2)
    await expect(page.locator('.journey-position')).toHaveCount(0)
    expect(
      await page.evaluate(
        () =>
          new Set((window as Window & { __hoverScrollSamples?: number[] }).__hoverScrollSamples)
            .size
      )
    ).toBeGreaterThan(4)
    await page.mouse.move(60, 20)
    await expect(page.locator('.note-hover-guide')).toHaveCount(0)
    expect(await readFile(path, 'utf8')).toBe(source)
    expect(errors).toEqual([])
  })
}

test('small-window long notes stay inside each theme and transfer the current branch to its atlas', async () => {
  await openSource(await readFile('docs/atlas-reading-example.md', 'utf8'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  if (await page.locator('.toc-drawer').isVisible())
    await page.getByRole('button', { name: '切换目录', exact: true }).click()
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByRole('slider', { name: '旁注字号', exact: true }).focus()
  await page.keyboard.press('End')
  await expect(page.getByRole('slider', { name: '旁注字号', exact: true })).toHaveValue('24')
  await page.keyboard.press('Escape')
  await mkdir('work/screens', { recursive: true })
  await expect(page.locator('.notes-scroll .zmu-note-body').first()).toHaveCSS('font-size', '24px')
  for (const [title, theme] of READING_THEMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: title }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    const lastEntry = page
      .locator('.reader-scroll')
      .getByRole('button', { name: '阅读注释 后来', exact: true })
      .last()
    await lastEntry.locator('.zmu-ref-mark').hover()
    await expect(page.locator('.note-peek:popover-open')).toBeVisible()
    await page
      .locator('.peek-shell')
      .evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
    await expect(page.getByRole('button', { name: '关闭就地注页', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('button', { name: '在旁注中阅读', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.locator('.peek-reading .zmu-note-body')).toHaveCSS('font-size', '24px')
    await page.screenshot({ path: `work/screens/peek-compact-${theme}.png`, scale: 'css' })
    await page.keyboard.press('Escape')
    await expand('后来')
    await expect(page.getByRole('button', { name: '关闭就地注页', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('button', { name: '在旁注中阅读', exact: true })).toBeInViewport({
      ratio: 1
    })
    const bounds = await page.locator('.peek-reading').evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        width: innerWidth,
        viewport: innerHeight
      }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(16)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width - 16)
    expect(bounds.height).toBeGreaterThan(100)
    expect(bounds.bottom).toBeLessThan(bounds.viewport - 16)
    await page.screenshot({ path: `work/screens/peek-small-${theme}.png`, scale: 'css' })
    await page.keyboard.press('Escape')
  }
  await expand('后来')
  const child = page
    .locator('.peek-reading')
    .getByRole('button', { name: '阅读注释 痕迹', exact: true })
  await child.locator('.zmu-ref-mark').click()
  await expect(page.locator('.peek-reading .zmu-note-body')).toHaveCSS('font-size', '24px')
  await page.getByRole('button', { name: '查看脉络', exact: true }).click()
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '正在浏览注释 痕迹', exact: true })).toBeVisible()
  await expect(page.locator('.atlas-detail .zmu-note-body')).toHaveCSS('font-size', '24px')
  expect(errors).toEqual([])
})

test('scrolling dismisses an unengaged preview, while an expanded note survives incidental hover and book changes close it', async () => {
  await openSource(
    '# 第一页\n\n两个入口[^甲]，另一个[^乙]。\n\n' +
      '再往下读。\n\n'.repeat(80) +
      '\n\n[^甲]: 保留正在阅读的注页。\n\n[^乙]: 无意路过不应替换已展开的内容。'
  )
  await bodyRef('甲').locator('.zmu-ref-mark').hover()
  await expect(page.locator('.note-peek:popover-open')).toBeVisible()
  await page.locator('.reader-scroll').evaluate((el) => {
    el.scrollTop = 1400
  })
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await page.locator('.reader-scroll').evaluate((el) => {
    el.scrollTop = 0
  })
  await expand('甲')
  await bodyRef('乙').dispatchEvent('pointerover', { pointerType: 'mouse' })
  await page.waitForTimeout(600)
  await expect(page.locator('.peek-reading')).toContainText('保留正在阅读的注页')
  await openSource('# 第二页\n\n新的文稿[^甲]。\n\n[^甲]: 是新的注释。')
  await expect(page.locator('.note-peek:popover-open')).toHaveCount(0)
  await expect(page.locator('.reader-scroll')).toContainText('第二页')
  await expand('甲')
  await expect(page.locator('.peek-reading')).toContainText('是新的注释')
  expect(errors).toEqual([])
})
