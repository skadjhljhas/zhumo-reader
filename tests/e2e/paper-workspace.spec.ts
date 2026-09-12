import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './runtime'
import { READING_THEMES } from './theme-catalog'

test('all themes use left document controls; paper retains source headings without the decorative opening or ending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-paper-workspace-'))
  const file = join(root, '白纸上的阅读.md')
  const source =
    '# 白纸上的阅读\n\n文字先于装饰。[^1]\n\n## 第二节\n\n原有标题、正文和注释都应保留。\n\n[^1]: 一条可以读写的旁注。\n'
  await writeFile(file, source)
  await mkdir('work/paper59', { recursive: true })
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog, BrowserWindow }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      BrowserWindow.getAllWindows()[0].setSize(1080, 720)
    }, file)
    await page.getByRole('button', { name: '打开文稿', exact: true }).click()
    await expect(page.locator('.reader-scroll')).toBeVisible()
    const rail = page.getByRole('navigation', { name: '工作区导航' })
    for (const [name, id] of READING_THEMES) {
      await rail.getByRole('button', { name: '选择阅读主题', exact: true }).click()
      await page.locator('.theme-choice').filter({ hasText: name }).click()
      await page.getByRole('button', { name: '关闭主题', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-skin', id)
      await expect(page.locator('.app-shell > .studio-toolbar')).toHaveCount(0)
      for (const action of ['切换目录', '开启编辑', '打开书籍', '切换注释侧栏']) {
        const button = rail.getByRole('button', { name: action, exact: true })
        await button.scrollIntoViewIfNeeded()
        const [b, r] = await Promise.all([button.boundingBox(), rail.boundingBox()])
        expect(b!.x).toBeGreaterThanOrEqual(r!.x)
        expect(b!.x + b!.width).toBeLessThanOrEqual(r!.x + r!.width + 1)
        expect(b!.y).toBeGreaterThanOrEqual(0)
        expect(b!.y + b!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
        expect(Math.abs(b!.x + b!.width / 2 - (r!.x + r!.width / 2))).toBeLessThan(1)
        expect(r!.width).toBe(64)
      }
      await expect(rail.locator('.toolbar-book,.mode-switch')).toHaveCount(0)
      await rail.getByRole('button', { name: '更多阅读工具', exact: true }).click()
      const tools = page.getByRole('menu', { name: '更多阅读工具', exact: true })
      await expect(
        tools.getByRole('menuitem', { name: '新建 Markdown', exact: true })
      ).toBeVisible()
      await tools.getByRole('menuitem', { name: '导出 PDF', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '导出 PDF', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await rail.getByRole('button', { name: '更多阅读工具', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(rail.getByRole('button', { name: '更多阅读工具', exact: true })).toBeFocused()
      if (id === 'paper') {
        await expect(page.locator('.document-overture')).toHaveCount(0)
        await expect(page.locator('.reader-fin')).toHaveCount(0)
        await expect(page.locator('.section-body h1')).toBeVisible()
        await expect(page.locator('.section-body h1')).toHaveText('白纸上的阅读')
        const colors = await page.evaluate(() => ({
          paper: getComputedStyle(document.querySelector('.app-center')!).backgroundColor,
          ink: getComputedStyle(document.querySelector('.section-body p')!).color,
          top: document.querySelector('.reader-scroll')!.getBoundingClientRect().top
        }))
        expect(colors).toEqual({ paper: 'rgb(255, 255, 255)', ink: 'rgb(17, 17, 17)', top: 0 })
        await page.screenshot({ path: 'work/paper59/paper-left.png', scale: 'css' })
      }
    }
    await rail.getByRole('button', { name: '开启编辑', exact: true }).click()
    await expect(
      page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
    ).toBeVisible()
    await rail.getByRole('button', { name: '阅读', exact: true }).click()
    await expect(page.locator('.reader-scroll')).toBeVisible()
    await rail.getByRole('button', { name: '文本标注方式', exact: true }).click()
    const menu = page.getByRole('dialog', { name: '文本标注方式', exact: true })
    await expect(menu).toBeVisible()
    await menu.getByRole('radio', { name: /跟随阅读/ }).click()
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '关闭标注选项' }).click()
    expect(await readFile(file, 'utf8')).toBe(source)
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  }
})
