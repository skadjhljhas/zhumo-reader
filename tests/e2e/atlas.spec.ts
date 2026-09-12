import { READING_THEMES } from './theme-catalog'
import { electron } from './runtime'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: ElectronApplication, page: Page, root: string, errors: string[]
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-atlas-'))
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
  const info = test.info()
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await mkdir('work/screens', { recursive: true })
    await page
      .screenshot({ path: 'work/screens/atlas-failure.png', timeout: 5000 })
      .catch(() => undefined)
    const geometry = await page
      .evaluate(() => {
        const root = document.querySelector<HTMLElement>('.notes-scroll')
        return {
          viewport: { width: innerWidth, height: innerHeight },
          active: document.activeElement?.className,
          fonts: document.fonts.status,
          sidebar: root && {
            top: root.scrollTop,
            height: root.scrollHeight,
            clientHeight: root.clientHeight,
            rect: root.getBoundingClientRect().toJSON()
          },
          rows: [...document.querySelectorAll('.notes-scroll .note-card')].map((card) => ({
            id: (card as HTMLElement).dataset.noteId,
            rect: card.getBoundingClientRect().toJSON(),
            mark: card.querySelector('.note-mark')?.getBoundingClientRect().toJSON()
          }))
        }
      })
      .catch(() => null)
    await writeFile('work/atlas-failure-geometry.json', JSON.stringify(geometry, null, 2))
  }
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function openSource(source: string): Promise<void> {
  const path = join(root, '脉络阅读.md')
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
}
async function searchNote(term: string): Promise<void> {
  await page.getByRole('combobox', { name: '查找注释脉络' }).fill(term)
  await expect(page.locator('.atlas-result')).toHaveCount(1)
  await page.getByRole('combobox', { name: '查找注释脉络' }).press('Enter')
}

test('actual shared entries, three levels, history, pins and returning to the manuscript', async () => {
  await openSource(await readFile('docs/annotation-example.md', 'utf8'))
  const opener = page.getByRole('button', { name: '查看注释脉络 门槛', exact: true })
  await opener.click()
  await expect(page.locator('.atlas-dialog')).toBeVisible()
  await expect(page.locator('.atlas-neighbor.is-body')).toHaveCount(2)
  await expect(page.locator('.atlas-detail')).toContainText('免费')
  await page.getByRole('button', { name: '进入子注 反面', exact: true }).click()
  await expect(page.getByRole('button', { name: '进入父注 门槛', exact: true })).toBeVisible()
  await expect(page.locator('.atlas-detail')).toContainText('具体化的责任不能全部落在受阻者身上')
  await page.getByRole('button', { name: '进入子注 检验', exact: true }).click()
  await expect(page.locator('.atlas-detail')).toContainText('处理期限')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(page.getByRole('button', { name: '正在浏览注释 反面', exact: true })).toBeFocused()
  await page.keyboard.press('Alt+ArrowRight')
  await expect(page.getByRole('button', { name: '正在浏览注释 检验', exact: true })).toBeFocused()
  await page
    .locator('.atlas-detail')
    .getByRole('button', { name: '固定注释 检验', exact: true })
    .click()
  await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
  await expect(page.locator('.atlas-dialog')).toHaveCount(0)
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '检验'
  )
  await expect(page.getByRole('button', { name: '取消固定注释 检验', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '注释脉络', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在浏览注释 检验', exact: true })).toBeVisible()
  await searchNote('这里把“开放”拆开')
  await page.getByRole('button', { name: '定位正文 谁在解释这扇门 第2处', exact: true }).click()
  await expect(page.locator('.atlas-dialog')).toHaveCount(0)
  await expect(
    page.locator('.reader-scroll p').filter({ hasText: '这段距离不宜只由其中一方命名' })
  ).toBeInViewport()
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('long annotation branches restore the paragraph and replace abandoned forward history', async () => {
  const paragraphs = Array.from(
    { length: 28 },
    (_, i) => `    第${i + 1}段。${'解释需要保留自己的展开空间。'.repeat(12)}`
  ).join('\n\n')
  await openSource(
    '# 长注释\n\n正文[^根]。\n\n[^根]: 论述开始。\n\n' +
      paragraphs +
      '\n\n    在这里进入第一支线[^旧]，或第二支线[^新]。\n\n[^旧]: 第一种解释。\n\n[^新]: 另一种解释。'
  )
  await page.getByRole('button', { name: '注释脉络', exact: true }).click()
  const detail = page.locator('.atlas-detail')
  await detail.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const branch = detail.getByRole('button', { name: '阅读注释 旧', exact: true })
  await expect(branch).toBeInViewport()
  const departure = await detail.evaluate((el) => el.scrollTop)
  await branch.locator('.zmu-ref-mark').click()
  await expect(detail).toContainText('第一种解释')
  await expect.poll(() => detail.evaluate((el) => el.scrollTop)).toBe(0)
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(branch).toBeInViewport()
  await expect.poll(() => detail.evaluate((el) => el.scrollTop)).toBeCloseTo(departure, 0)
  await detail.getByRole('button', { name: '阅读注释 新', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(detail).toContainText('另一种解释')
  await expect(page.getByRole('button', { name: '脉络前进', exact: true })).toBeDisabled()
  await expect(page.locator('.atlas-history > span')).toHaveText('2 / 2')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '注释脉络', exact: true })).toBeFocused()
  expect(errors).toEqual([])
})

test('all 1500 notes remain searchable while dense branches and repeated chapter entries stay bounded', async () => {
  const labels = Array.from({ length: 1500 }, (_, i) => `n${i}`)
  await openSource(
    '# 关系\n\n## 同名\n\n早先入口[^根]。\n\n## 同名\n\n第二入口[^根]。\n\n[^根]: ' +
      labels.map((label) => `[^${label}]`).join(' ') +
      '\n\n' +
      labels
        .map(
          (label, i) =>
            `[^${label}]: ${i === 1499 ? '穷尽分页之后仍能找到的独有句子' : `这一支线的内容${i}`}。`
        )
        .join('\n\n')
  )
  await page.locator('.notes-scroll').focus()
  await expect(page.locator('.notes-scroll')).toBeFocused()
  await page.keyboard.press('Control+End')
  await expect(
    page.locator('.notes-scroll .note-mark').filter({ hasText: /^n1499$/ })
  ).toBeInViewport()
  await page.keyboard.press('Control+Home')
  await expect(page.locator('.notes-scroll .note-mark').first()).toHaveText('根')
  await page.getByRole('button', { name: '查看注释脉络 根', exact: true }).click()
  expect(await page.locator('.atlas-neighbor.outgoing').count()).toBeLessThanOrEqual(4)
  await expect(page.getByRole('button', { name: '定位正文 同名 第1处', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '定位正文 同名 第2处', exact: true })).toBeVisible()
  const firstIds = await page
    .locator('.atlas-neighbor.outgoing')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-note-id')))
  await page.getByRole('button', { name: '下一组支线', exact: true }).click()
  const nextIds = await page
    .locator('.atlas-neighbor.outgoing')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-note-id')))
  expect(nextIds.some((id) => firstIds.includes(id))).toBe(false)
  const start = Date.now()
  await searchNote('穷尽分页之后仍能找到的独有句子')
  expect(Date.now() - start).toBeLessThan(5000)
  await expect(page.getByRole('button', { name: '正在浏览注释 n1499', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: '进入父注 根', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '在旁注中阅读', exact: true }).click()
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toContainText(
    '穷尽分页之后仍能找到的独有句子'
  )
  expect(await page.locator('.note-card').count()).toBeLessThan(25)
  expect(errors).toEqual([])
})

test('keyboard list edges settle around large notes and later manual input cancels the old edge request', async () => {
  const labels = Array.from({ length: 120 }, (_, i) => 'edge' + i)
  const finalNote =
    Array.from(
      { length: 70 },
      (_, i) => '    最后一条的第' + i + '段。' + '继续细读。'.repeat(15)
    ).join('\n\n') + '\n\n    这里是最后一条注释的结尾。'
  await openSource(
    '# 键盘的来回\n\n正文[^根]。\n\n[^根]: ' +
      labels.map((label) => '[^' + label + ']').join(' ') +
      '\n\n' +
      labels
        .map(
          (label, i) =>
            '[^' + label + ']: ' + (i === 119 ? '\n' + finalNote : '这一处保留自己的内容。')
        )
        .join('\n\n')
  )
  const notes = page.locator('.notes-scroll')
  await notes.focus()
  await expect(notes).toBeFocused()
  await page.keyboard.press('Control+End')
  const tail = notes.locator('.zmu-note-body p').filter({ hasText: '这里是最后一条注释的结尾。' })
  await expect(tail).toBeInViewport()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+Home')
  await expect(notes.locator('.note-mark').first()).toHaveText('根')
  await expect(notes.locator('.note-mark').first()).toBeInViewport()
  await page.waitForTimeout(250)
  expect(await notes.evaluate((el) => el.scrollTop)).toBeLessThan(2)
  await page.keyboard.press('Control+End')
  await expect(tail).toBeInViewport()
  const end = await notes.evaluate((el) => el.scrollTop)
  await page.keyboard.press('Control+End')
  await notes.hover()
  await page.mouse.wheel(0, -800)
  await expect.poll(() => notes.evaluate((el) => el.scrollTop)).toBeLessThan(end - 300)
  await page.waitForTimeout(300)
  expect(await notes.evaluate((el) => el.scrollTop)).toBeLessThan(end - 300)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('formula inspection stacks above the atlas and references return to their real numbered equation', async () => {
  await openSource(String.raw`# 公式来路
正文[^推导]。

\[\begin{equation}a=b\label{body}\end{equation}\]

[^推导]: 这一步参见 $\eqref{body}$。

    \[\begin{equation}x=y\label{note}\end{equation}\]
`)
  await page.getByRole('button', { name: '查看注释脉络 推导', exact: true }).click()
  expect(await page.locator('[id="mjx-eqn:note"]').count()).toBe(1)
  const formula = page.locator('.atlas-detail .zmu-math-block')
  await formula.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.math-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(formula).toBeFocused()
  await expect(page.locator('.atlas-dialog')).toBeVisible()
  await page.locator('.atlas-detail a[href="#mjx-eqn%3Abody"]').click()
  await expect(page.locator('.atlas-dialog')).toHaveCount(0)
  await expect(page.locator('.reader-scroll [id="mjx-eqn:body"]')).toBeInViewport()
  expect(errors).toEqual([])
})

test('small-window layouts keep graph nodes apart and every control reachable across all nine themes', async () => {
  const labels = Array.from({ length: 16 }, (_, i) => `支线${i}`)
  await openSource(
    '# 注释的空间\n\n第一处[^根]。第二处[^根]。第三处[^根]。\n\n[^根]: ' +
      labels.map((label) => `[^${label}]`).join(' ') +
      '\n\n' +
      labels.map((label) => `[^${label}]: 在这里展开自己的讨论。`).join('\n\n')
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await mkdir('work/screens', { recursive: true })
  for (const [name, id] of READING_THEMES) {
    await page.getByRole('button', { name: '选择阅读主题', exact: true }).click()
    await page.locator('.theme-choice').filter({ hasText: name }).click()
    await page.getByRole('button', { name: '回到阅读', exact: true }).click()
    await page.getByRole('button', { name: '注释脉络', exact: true }).click()
    await expect(page.getByRole('button', { name: '在旁注中阅读', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect
      .poll(() =>
        page.locator('.atlas-neighbor').evaluateAll((els) =>
          els.every((el, i) => {
            const rect = el.getBoundingClientRect(),
              parent = el.parentElement!.getBoundingClientRect()
            return (
              rect.top >= parent.top &&
              rect.bottom <= parent.bottom &&
              rect.left >= parent.left &&
              rect.right <= parent.right &&
              els.slice(i + 1).every((other) => {
                const box = other.getBoundingClientRect()
                return (
                  rect.right <= box.left ||
                  box.right <= rect.left ||
                  rect.bottom <= box.top ||
                  box.bottom <= rect.top
                )
              })
            )
          })
        )
      )
      .toBe(true)
    await page.getByRole('combobox', { name: '查找注释脉络' }).focus()
    await expect(page.getByRole('button', { name: '下一页注释结果', exact: true })).toBeInViewport({
      ratio: 1
    })
    await page.keyboard.press('Escape')
    await expect(page.locator('.atlas-picker')).toHaveCount(0)
    await page.screenshot({ path: `work/screens/atlas-small-${id}.png`, scale: 'css' })
    await page.keyboard.press('Escape')
    await expect(page.locator('.atlas-dialog')).toHaveCount(0)
  }
  expect(errors).toEqual([])
})

test('missing, unreferenced and self-referencing notes remain navigable without false branches', async () => {
  await openSource(
    '# 边界\n\n正文[^自]。\n\n[^自]: 再次引用自身[^自]，以及未定义的引用[^缺]。\n\n[^孤]: 独立材料。'
  )
  await page.getByRole('button', { name: '注释脉络', exact: true }).click()
  await expect(page.locator('.atlas-focus-node')).toContainText('自引用')
  await expect(page.locator('.atlas-self-loop')).toHaveCount(1)
  await page.getByRole('button', { name: '进入子注 缺', exact: true }).click()
  await expect(page.locator('.atlas-detail')).toContainText('未找到此注释的定义')
  await expect(page.locator('.atlas-neighbor.outgoing')).toHaveCount(0)
  await searchNote('独立材料')
  await expect(page.locator('.atlas-neighbor')).toHaveCount(0)
  await expect(page.locator('.atlas-reading > footer')).toContainText('未引用')
  expect(errors).toEqual([])
})
