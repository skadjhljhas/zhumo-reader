import { test, expect, type ElectronApplication } from '@playwright/test'
import { electron, backgroundTests } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { productIdentity } from '../../src/main/product-identity'
import { selectReaderProfile } from '../../src/main/profile-selection'
import { defaultAiProfile } from '../../src/shared/ai-types'

test('a stable product opens the chosen complete AI profile with decryptable keys, imported fonts and an untitled draft', async () => {
  test.skip(!backgroundTests, 'Isolated background verification only')
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-product-identity-'))
  const appData = join(root, 'appData'),
    profile = join(appData, 'ZhuMo-AI-preview')
  await mkdir(profile, { recursive: true })
  const env = {
    ...process.env,
    ZHUMO_USER_DATA: profile,
    ZHUMO_UPDATE_COORDINATION: join(root, 'coord')
  }
  for (const key of Object.keys(env))
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  let reader: ElectronApplication | undefined
  async function close(force = false): Promise<void> {
    if (!reader) return
    const closed = reader.waitForEvent('close')
    await reader.evaluate(({ app }, force) => (force ? app.exit(0) : app.quit()), force)
    await closed
    reader = undefined
  }
  try {
    const library = join(root, '原文稿'),
      book = join(library, '继续阅读.md')
    await mkdir(library)
    const source = '\ufeff# 继续阅读\r\n\r\n原文仍在原来的位置。'
    await writeFile(book, source)
    await writeFile(
      join(profile, 'manuscript-library.v1.json'),
      JSON.stringify({ version: 1, path: library })
    )
    reader = await electron.launch({
      executablePath: resolve('../朱墨-AI细读/桌面候选35/win-unpacked/ZhuMo-AI.exe'),
      args: [],
      env
    })
    const page = await reader.firstWindow()
    const oldName = await reader.evaluate(({ app }) => app.getName())
    await reader.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ['C:/Windows/Fonts/arial.ttf']
      })
    })
    await page.getByRole('button', { name: '新建 Markdown', exact: true }).click()
    await expect(
      page.getByRole('textbox', { name: 'Markdown 源文编辑器', exact: true })
    ).toBeFocused()
    await page.keyboard.insertText('# 身份升级前的未命名草稿\n\n整套阅读资料继续保留。')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((done, reject) => {
              const open = indexedDB.open('zhumo-recovery', 2)
              open.onerror = () => reject(open.error)
              open.onsuccess = () => {
                const db = open.result,
                  read = db.transaction('drafts-v2').objectStore('drafts-v2').getAll()
                read.onsuccess = () => {
                  db.close()
                  done(read.result.some((d) => d.source.includes('身份升级前的未命名草稿')))
                }
                read.onerror = () => {
                  db.close()
                  reject(read.error)
                }
              }
            })
        )
      )
      .toBe(true)
    await page.evaluate(
      async (defaults) => {
        const imported = await window.api.importFont()
        if (!imported) throw Error('Fixture font import failed')
        await window.api.saveSettings({
          ...(await window.api.getSettings()),
          fontSize: 23,
          bodyFont: imported.font.id,
          noteFont: imported.font.id,
          uiFont: imported.font.id,
          automaticSyntax: false,
          lightRange: 'hdr'
        })
        localStorage.setItem('zhumo.studio.theme', 'lucent')
        await window.ai!.saveProfile('reading', {
          ...defaults,
          model: 'fixture-product-identity',
          endpoint: 'http://127.0.0.1:1/v1',
          apiKey: 'fixture-product-identity-key'
        })
      },
      { ...defaultAiProfile('reading'), maxTokens: 32768, context: 'full' as const }
    )
    // Recovery is deliberately tested after an abrupt exit; a dirty draft otherwise
    // correctly waits for the reader's unsaved-changes decision.
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}'))
            .fontSize
      )
      .toBe(23)
    await close(true)
    const cipher = JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8')).reading
      .cipher
    const selected = selectReaderProfile({
      appData,
      product: productIdentity({ zhumoChannel: 'stable' })
    })
    expect(selected).toBe(await realpath(profile))
    const stablePayload = resolve(
      process.env.ZHUMO_MANAGED_PAYLOAD ?? '../朱墨2.0发行准备/候选02/win-unpacked'
    )
    const manifest = JSON.parse(
      await readFile(join(stablePayload, 'program-files.v1.json'), 'utf8')
    )
    expect(manifest.appId).toBe('com.zhumo.reader.v2')
    reader = await electron.launch({
      executablePath: join(stablePayload, manifest.executable),
      args: [],
      env: { ...env, ZHUMO_USER_DATA: selected }
    })
    const current = await reader.firstWindow()
    expect(await reader.evaluate(({ app }) => app.getName())).not.toBe(oldName)
    expect(await reader.evaluate(({ app }) => app.getPath('userData'))).toBe(selected)
    expect(await reader.evaluate(({ app }) => app.getVersion())).toBe(manifest.appVersion)
    const settings = await current.evaluate(() => window.api.getSettings())
    expect(settings.fontSize).toBe(23)
    expect(settings.lightRange).toBe('hdr')
    expect(settings.bodyFont).toMatch(/^[a-f0-9]{64}$/)
    await expect
      .poll(() =>
        current.evaluate(
          () =>
            [...document.fonts].filter(
              (f) => f.family.startsWith('ZhuMoFont_') && f.status === 'loaded'
            ).length
        )
      )
      .toBe(1)
    expect(await current.evaluate(() => localStorage.getItem('zhumo.studio.theme'))).toBe('lucent')
    await expect(current.locator('.untitled-drafts .recent-book').first()).toContainText(
      '身份升级前的未命名草稿'
    )
    const ai = await current.evaluate(() => window.ai!.getProfiles())
    expect(ai.reading.hasKey).toBe(true)
    expect(ai.reading.keyStorage).not.toBe('unavailable')
    expect(ai.reading.model).toBe('fixture-product-identity')
    expect(
      await reader.evaluate(
        ({ safeStorage }, encoded) =>
          safeStorage.decryptString(Buffer.from(encoded, 'base64')) ===
          'fixture-product-identity-key',
        cipher
      )
    ).toBe(true)
    expect(
      JSON.parse(await readFile(join(profile, 'ai-models.v1.json'), 'utf8')).reading.cipher
    ).toBe(cipher)
    expect(await readFile(book, 'utf8')).toBe(source)
    expect(
      JSON.parse(await readFile(join(profile, 'manuscript-library.v1.json'), 'utf8')).path
    ).toBe(library)
    await close()
  } finally {
    await close(true)
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-product-identity-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
