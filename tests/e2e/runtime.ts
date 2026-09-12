import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Visible desktop checks are an explicit opt-in. This also applies when someone
// runs a single spec directly instead of using the npm script.
export const backgroundTests = process.env.ZHUMO_E2E_VISIBLE !== '1'
export const executionMode = backgroundTests ? 'background-renderer' : 'visible-desktop'

export function metricPath(name: string): string {
  return `work/${backgroundTests ? 'background/' : ''}${name}`
}

function installClipboard(): void {
  const target = window as Window & { __zhumoTestClipboard?: string }
  target.__zhumoTestClipboard = ''
  // Background assertions check the text handed to the clipboard API. They do
  // not touch the user's OS clipboard. The visible suite uses the native API.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string): Promise<void> => {
        target.__zhumoTestClipboard = String(text)
      },
      readText: async (): Promise<string> => target.__zhumoTestClipboard ?? ''
    }
  })
  document.addEventListener(
    'copy',
    (event) => {
      event.preventDefault()
      target.__zhumoTestClipboard = window.getSelection()?.toString() ?? ''
    },
    true
  )
}

export async function readClipboard(app: ElectronApplication): Promise<string> {
  if (!backgroundTests) return app.evaluate(({ clipboard }) => clipboard.readText())
  return (await app.firstWindow()).evaluate(
    () => (window as Window & { __zhumoTestClipboard?: string }).__zhumoTestClipboard ?? ''
  )
}

export async function assertBackgroundWindow(app: ElectronApplication): Promise<void> {
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      visible: win.isVisible(),
      focused: win.isFocused(),
      focusable: win.isFocusable(),
      throttled: win.webContents.getBackgroundThrottling(),
      offscreen: win.webContents.isOffscreen(),
      frameRate: win.webContents.getFrameRate()
    }))
  )
  expect(windows.length).toBeGreaterThan(0)
  for (const win of windows)
    expect(win).toEqual({
      visible: false,
      focused: false,
      focusable: false,
      throttled: false,
      offscreen: true,
      frameRate: 60
    })
}

export const electron = {
  async launch(options: Parameters<typeof _electron.launch>[0]): Promise<ElectronApplication> {
    if (!options?.env?.ZHUMO_USER_DATA)
      throw new Error('Electron tests require their own ZHUMO_USER_DATA profile')
    await mkdir(backgroundTests ? 'work/background' : 'work', { recursive: true })
    const app = await _electron.launch({
      ...options,
      env: {
        ...options.env,
        ZHUMO_TEST_BACKGROUND: backgroundTests ? '1' : '0',
        ZHUMO_UPDATE_COORDINATION:
          options.env.ZHUMO_UPDATE_COORDINATION ||
          resolve(
            'work/e2e-coordination',
            createHash('sha256').update(options.env.ZHUMO_USER_DATA).digest('hex')
          )
      }
    })
    try {
      const page: Page = await app.firstWindow()
      if (backgroundTests) {
        await assertBackgroundWindow(app)
        await page.addInitScript(installClipboard)
        await page.evaluate(installClipboard)
      }
      return app
    } catch (error) {
      await app.evaluate(({ app }) => app.exit(1)).catch(() => undefined)
      throw error
    }
  }
}
