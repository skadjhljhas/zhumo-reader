import { test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, backgroundTests, assertBackgroundWindow, readClipboard } from './runtime'

test('background automation renders and accepts input without showing or focusing its native window', async () => {
  test.skip(!backgroundTests, 'This contract applies only to background automation')
  const root = await mkdtemp(join(tmpdir(), 'zhumo-background-'))
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: root }
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      const events: string[] = []
      const target = globalThis as typeof globalThis & { __zhumoWindowEvents?: string[] }
      target.__zhumoWindowEvents = events
      for (const win of BrowserWindow.getAllWindows()) {
        win.on('show', () => events.push('show'))
        win.on('focus', () => events.push('focus'))
      }
    })
    await expect(page.getByText('另有天地。')).toBeVisible()
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
    await expect(page.locator('.optical-field')).toHaveAttribute('data-ready', 'webgl')
    const paintCounts = await page.evaluate(async () => {
      const canvas = document.querySelector('.optical-field') as HTMLCanvasElement
      const first = canvas.toDataURL()
      const started = performance.now()
      await new Promise<void>((resolve) => {
        let count = 0
        const step = (): void => {
          if (++count === 6) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      return { advancing: first !== canvas.toDataURL(), elapsedMs: performance.now() - started }
    })
    expect(paintCounts.advancing).toBe(true)
    expect(paintCounts.elapsedMs).toBeLessThan(1500)
    await page.getByRole('button', { name: 'AI 注释写作协议', exact: true }).click()
    await page.getByRole('button', { name: '复制写作协议', exact: true }).click()
    expect(await readClipboard(app)).toContain('朱墨')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '进入示范文稿' }).click()
    await page.getByRole('button', { name: '开启编辑', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown 源文编辑器' })
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('【后台输入验证】')
    await expect(editor).toContainText('【后台输入验证】')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
    await expect(editor).toBeVisible()
    await assertBackgroundWindow(app)
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __zhumoWindowEvents?: string[] }).__zhumoWindowEvents
      )
    ).toEqual([])
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
