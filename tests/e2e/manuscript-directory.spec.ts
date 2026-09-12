import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { electron } from './runtime'

test('desktop dialogs share the manuscript directory while regular saves keep the original path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-default-folder-'))
  const profile = join(root, 'profile')
  const folder = join(profile, '文稿')
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: profile }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('另有天地。')).toBeVisible()
    expect((await stat(folder)).isDirectory()).toBe(true)
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.OpenDialogOptions
        if (options.defaultPath !== folder) throw new Error('Wrong default open directory')
        return { canceled: true, filePaths: [] }
      }
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.SaveDialogOptions
        if (options.defaultPath !== folder + '\\新文稿.md')
          throw new Error('Wrong default save directory: ' + options.defaultPath)
        return { canceled: false, filePath: options.defaultPath }
      }
    }, folder)
    expect(await page.evaluate(() => window.api.openBookDialog())).toBeNull()
    await page.evaluate(() => window.api.saveBookAs('新文稿.md', '# 存入文稿目录'))
    expect(await readFile(join(folder, '新文稿.md'), 'utf8')).toBe('# 存入文稿目录')
    const original = join(root, '外部原稿.md')
    await writeFile(original, '# 原处')
    await page.evaluate((path) => window.api.saveBook(path, '# 修改后', '# 原处'), original)
    expect(await readFile(original, 'utf8')).toBe('# 修改后')
    expect(await readFile(join(folder, '新文稿.md'), 'utf8')).toBe('# 存入文稿目录')
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
