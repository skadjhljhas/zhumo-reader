import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { electron } from './runtime'
import { tidalBookKey, type TidalBookPlaces } from '../../src/renderer/src/composables/tidalPlaces'

async function archive(): Promise<TidalBookPlaces[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('zhumo-reading-echo', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const request = open.result.transaction('books').objectStore('books').getAll()
          request.onsuccess = () => {
            open.result.close()
            resolve(request.result)
          }
          request.onerror = () => {
            open.result.close()
            reject(request.error)
          }
        }
      })
  )
}
async function storeArchive(books: TidalBookPlaces[]): Promise<void> {
  await page.evaluate(
    (books) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('zhumo-reading-echo', 1)
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction('books', 'readwrite')
          for (const book of books) tx.objectStore('books').put(book)
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
          tx.onerror = () => {
            open.result.close()
            reject(tx.error)
          }
        }
      }),
    books
  )
}

let app: ElectronApplication, page: Page, root: string, path: string, errors: string[]
async function launch(): Promise<void> {
  app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980))
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByText('另有天地。')).toBeVisible()
  await page.locator('.space-swatches').getByRole('button', { name: '潮光', exact: true }).click()
}
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zhumo-remembrance-'))
  path = join(root, '停留.md')
  await launch()
})
test.afterEach(async () => {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
async function open(source: string, file = path, ready = true): Promise<void> {
  await writeFile(file, source)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.getByRole('button', { name: /^(打开文稿|打开书籍)$/ }).click()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  const directory = page.getByRole('button', { name: '切换目录', exact: true })
  if ((await directory.getAttribute('aria-pressed')) !== 'true') await directory.click()
  await expect(page.locator('.toc-drawer')).toBeVisible()
  if (ready)
    await expect(page.getByRole('button', { name: '回声：停留的字句', exact: true })).toBeEnabled()
  await page.evaluate(() => document.fonts.ready)
}
async function hover(locator: Locator, text: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  const point = await locator.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const at = (node.textContent ?? '').indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const rect = range.getClientRects()[0]
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    throw Error('Word not found')
  }, text)
  await page.mouse.move(point.x, point.y)
  await page.waitForTimeout(3450)
  await expect(page.locator('.tidal-echo-action')).toHaveCount(0)
  await page.mouse.move(60, 20)
  await page.waitForTimeout(140)
}
async function ledger(): Promise<void> {
  await page.getByRole('button', { name: '回声：停留的字句', exact: true }).click()
  await expect(page.locator('.tidal-memory-dialog')).toBeVisible()
}
async function closeLedger(): Promise<void> {
  await page.getByRole('button', { name: '关闭回声', exact: true }).click()
  await expect(page.locator('.tidal-memory-dialog')).toBeHidden()
}

test('a remembered occurrence stays distinct and returns precisely after travelling far away', async () => {
  const source =
    '# 起点\n\n门槛，在这里被第一次说出。\n\n## 重读\n\n门槛，在第二次出现时已经不同。\n\n' +
    Array.from(
      { length: 35 },
      (_, i) => '# 远处' + i + '\n\n' + '我们保留足够的距离，让读者能够回来。'.repeat(35)
    ).join('\n\n')
  await open(source)
  const paragraphs = page.locator('.reader-scroll .section-body p').filter({ hasText: '门槛' })
  await hover(paragraphs.nth(1), '门槛')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await page.locator('.toc-item').last().click()
  await expect(page.locator('.section-frame').last().locator('.section-body')).toBeVisible()
  let previous = -1,
    stable = 0
  await expect
    .poll(
      async () => {
        const top = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
        stable = top === previous ? stable + 1 : 0
        previous = top
        return stable
      },
      { intervals: [60, 100, 100] }
    )
    .toBeGreaterThanOrEqual(3)
  const away = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  expect(away).toBeGreaterThan(5000)
  await ledger()
  await expect(page.locator('.tidal-place-context')).toContainText('第二次出现')
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(away)
  await page.getByRole('button', { name: '回到这句', exact: true }).click()
  await expect(paragraphs.nth(1)).toBeInViewport()
  await expect
    .poll(() =>
      paragraphs.nth(1).evaluate((paragraph) => {
        const viewport = paragraph.closest('.reader-scroll')!.getBoundingClientRect()
        return [...(CSS.highlights.get('zhumo-search-match') ?? [])].map((range) => {
          if (!(range instanceof Range)) return { text: '', belongs: false, visible: false }
          const rects = [...range.getClientRects()]
          return {
            text: range.toString(),
            belongs:
              paragraph.contains(range.startContainer) && paragraph.contains(range.endContainer),
            visible:
              rects.length > 0 &&
              rects.every(
                (rect) =>
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.left >= viewport.left &&
                  rect.right <= viewport.right &&
                  rect.top >= viewport.top &&
                  rect.bottom <= viewport.bottom
              )
          }
        })
      })
    )
    .toEqual([{ text: '门槛', belongs: true, visible: true }])
  expect(await readFile(path, 'utf8')).toBe(source)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('local places survive reopening and a changed manuscript receives its own identity', async () => {
  const source = '# 原页\n\n停留，在这一句，稍后仍可回来。'
  await open(source)
  await hover(page.locator('.reader-scroll .section-body p'), '停留')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await app.evaluate(({ session }) => session.defaultSession.flushStorageData())
  await app.close()
  await launch()
  await open(source)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await ledger()
  await expect(page.locator('.tidal-place-context')).toContainText('稍后仍可回来')
  await closeLedger()
  await open(source.replace('稍后仍可回来', '已经是新的文字'))
  await expect(page.locator('.tidal-memory-heading small')).toContainText('0 处')
  await ledger()
  await expect(page.locator('.tidal-memory-empty')).toBeVisible()
  expect(errors).toEqual([])
})

test('a remembered annotation keeps its own source and excludes reference labels from context', async () => {
  const source =
    '# 两种来处\n\n这里也有自由。[^甲]\n\n[^甲]: 自由在旁注里继续。[^乙]\n\n[^乙]: 子注。'
  await open(source)
  await hover(page.locator('.notes-scroll .zmu-note-body p').filter({ hasText: '自由' }), '自由')
  await ledger()
  await expect(page.locator('.tidal-place-context')).toHaveText('自由在旁注里继续。')
  await expect(page.locator('.tidal-place-reading h3')).toHaveText('旁注 甲')
  const before = await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)
  await page.getByRole('button', { name: '回到这句', exact: true }).click()
  await expect(page.locator('.notes-scroll .note-card.is-reading')).toHaveAttribute(
    'aria-label',
    '甲'
  )
  expect(await page.locator('.reader-scroll').evaluate((el) => el.scrollTop)).toBe(before)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('clearing is undoable and pausing leaves existing places available', async () => {
  await open('# 选择留下什么\n\n自由与停留，属于不同的句子。')
  const paragraph = page.locator('.reader-scroll .section-body p')
  await hover(paragraph, '自由')
  await ledger()
  await page.getByRole('button', { name: '清除本书停留', exact: true }).click()
  await expect(page.locator('.tidal-place')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销清除', exact: true }).click()
  await expect(page.locator('.tidal-place')).toHaveCount(1)
  await page.getByRole('checkbox', { name: '记住停留', exact: true }).uncheck()
  await closeLedger()
  await hover(paragraph, '停留')
  await ledger()
  await expect(page.locator('.tidal-place')).toHaveCount(1)
  await expect(page.locator('.tidal-place-word')).toHaveText('自由')
  expect(errors).toEqual([])
})

test('small windows, quiet mode and keyboard preview keep the return action reachable', async () => {
  await open('# 阅读的岸\n\n后来，原句在这里等待。\n\n另一句仍然留在书中。')
  await hover(page.locator('.reader-scroll .section-body p').first(), '后来')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640))
  await page.getByRole('button', { name: '收起目录', exact: true }).click()
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await ledger()
  await expect(page.getByRole('button', { name: '回到这句', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expect(page.getByRole('button', { name: '清除本书停留', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expect(page.locator('.tidal-place-context')).toContainText('原句在这里等待')
  expect(
    await page.locator('.tidal-memory-dialog').evaluate((el) => el.scrollWidth - el.clientWidth)
  ).toBeLessThanOrEqual(1)
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/潮光-回声-小窗口.png', scale: 'css' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.tidal-memory-dialog')).toBeHidden()
  await expect(page.locator('.reader-scroll')).toBeVisible()
  expect(errors).toEqual([])
})

test('a delayed fingerprint from another book cannot replace the current book places', async () => {
  const source = '# 此处\n\n自由，在此处留下一个位置。'
  await open(source)
  await hover(page.locator('.reader-scroll .section-body p'), '自由')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let calls = 0
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto['digest']>): Promise<ArrayBuffer> => {
        const delay = ++calls === 1 ? 600 : 0
        const value = await digest(...args)
        return new Promise((resolve) => setTimeout(() => resolve(value), delay))
      }
    })
  })
  await open('# 彼处\n\n这一本书尚未留下停留。', join(root, '另一本.md'), false)
  await expect(page.locator('.document-overture h1')).toHaveText('彼处')
  await open(source)
  await expect(page.locator('.document-overture h1')).toHaveText('此处')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('1 处')
  await page.waitForTimeout(750)
  await ledger()
  await expect(page.locator('.tidal-place-word')).toHaveText('自由')
  await expect(page.locator('.tidal-place-context')).toContainText('此处留下一个位置')
  expect(errors).toEqual([])
})

test('afterlight drifts through the whitespace while the original sentence stays still', async () => {
  const source = '# 时间的微光\n\n后来，自由与停留，都在这一句里折回。'
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  await open(source)
  const paragraph = page.locator('.reader-scroll .section-body p')
  for (const word of ['后来', '自由', '停留']) await hover(paragraph, word)
  await ledger()
  await expect(page.locator('.tidal-place')).toHaveCount(3)
  const material = page.locator('.tidal-afterlight')
  const field = page.locator('.tidal-afterlight-field')
  await expect(material).toHaveAttribute('data-ready', 'webgl')
  await expect
    .poll(() => field.evaluate((el) => Number((el as HTMLElement).dataset.frames)))
    .toBeGreaterThan(3)
  const geometry = await page.locator('.tidal-place-context').boundingBox()
  const first = await field.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await expect
    .poll(() => field.evaluate((el) => (el as HTMLCanvasElement).toDataURL()))
    .not.toBe(first)
  expect(await page.locator('.tidal-place-context').boundingBox()).toEqual(geometry)
  const relation = await material.evaluate((el) => {
    const note = el.parentElement!.querySelector('.tidal-place-note')!.getBoundingClientRect()
    const surface = el.getBoundingClientRect()
    return { clearance: surface.top - note.bottom, height: surface.height }
  })
  expect(relation.clearance).toBeGreaterThanOrEqual(9)
  expect(relation.height).toBeGreaterThan(100)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(180)
  const quiet = await field.evaluate((el) => (el as HTMLCanvasElement).toDataURL())
  await page.waitForTimeout(180)
  expect(await field.evaluate((el) => (el as HTMLCanvasElement).toDataURL())).toBe(quiet)
  await page
    .locator('.tidal-place')
    .filter({ has: page.locator('.tidal-place-word', { hasText: '后来' }) })
    .click()
  await expect(page.locator('.tidal-place-context mark')).toHaveText('后来')
  await expect
    .poll(() => field.evaluate((el) => (el as HTMLCanvasElement).toDataURL()))
    .not.toBe(quiet)
  expect(await page.locator('.tidal-place-context').boundingBox()).toEqual(geometry)
  const pixels = await field.evaluate((el) => {
    const canvas = el as HTMLCanvasElement
    const gl = canvas.getContext('webgl')!
    const data = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    let occupied = 0,
      maxAlpha = 0
    const tones = new Set<string>()
    for (let at = 0; at < data.length; at += 80) {
      maxAlpha = Math.max(maxAlpha, data[at + 3])
      if (data[at + 3] > 20) {
        occupied++
        tones.add([data[at] >> 3, data[at + 1] >> 3, data[at + 2] >> 3].join(','))
      }
    }
    return { occupied, tones: tones.size, maxAlpha, error: gl.getError() }
  })
  expect(pixels.occupied).toBeGreaterThan(100)
  expect(pixels.tones).toBeGreaterThan(15)
  expect(pixels.maxAlpha).toBeLessThanOrEqual(140)
  expect(pixels.error).toBe(0)
  await mkdir('work/screens', { recursive: true })
  await page.screenshot({ path: 'work/screens/潮光-回声-微光.png', scale: 'css' })
  expect(await readFile(path, 'utf8')).toBe(source)
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await closeLedger()
  await expect(field).toHaveCount(0)
  expect(errors).toEqual([])
})

test('afterlight recovers its context and off mode keeps the original sentence usable', async () => {
  await open('# 仍能阅读\n\n后来，文字始终在原处。')
  await hover(page.locator('.reader-scroll .section-body p'), '后来')
  await ledger()
  const material = page.locator('.tidal-afterlight')
  const field = page.locator('.tidal-afterlight-field')
  await expect(material).toHaveAttribute('data-ready', 'webgl')
  await field.evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext('webgl')!
    const extension = gl.getExtension('WEBGL_lose_context')!
    extension.loseContext()
    setTimeout(() => extension.restoreContext(), 180)
  })
  await expect(material).toHaveAttribute('data-ready', 'lost')
  await expect(page.locator('.tidal-afterlight-fallback')).toBeVisible()
  await expect(page.locator('.tidal-place-context')).toHaveText('后来，文字始终在原处。')
  await expect(material).toHaveAttribute('data-ready', 'webgl')
  await closeLedger()
  await page.getByRole('button', { name: '光影：丰沛', exact: true }).click()
  await page.getByRole('button', { name: '光影：静谧', exact: true }).click()
  await ledger()
  await expect(material).toHaveAttribute('data-ready', 'static')
  await expect(page.locator('.tidal-afterlight-fallback')).toBeVisible()
  await expect(field).toBeHidden()
  await page.getByRole('button', { name: '回到这句', exact: true }).click()
  await expect(page.locator('.reader-scroll .section-body p')).toBeInViewport()
  expect(errors).toEqual([])
})

test('new reading places preserve the shared raw-text version and leave the old shelf untouched', async () => {
  const source = '\ufeff# 新坐标\r\n\r\n😀门槛，在原来的字句中等待。\r\n'
  const legacy = JSON.stringify({
    version: 1,
    books: [
      {
        key: createHash('sha256')
          .update(path + '\0' + source)
          .digest('hex'),
        at: 1,
        places: [
          {
            kind: 'section',
            owner: 'old',
            block: 1,
            start: 0,
            end: 3,
            word: '旧停留',
            before: '',
            after: '',
            title: '旧记录',
            position: 0.1,
            at: 1,
            visits: 1
          }
        ]
      }
    ]
  })
  await page.evaluate((value) => localStorage.setItem('zhumo.chaosheng.places.v1', value), legacy)
  await open(source)
  await ledger()
  await expect(page.locator('.tidal-place')).toHaveCount(0)
  await closeLedger()
  await hover(page.locator('.reader-scroll .section-body p'), '门槛')
  await expect.poll(async () => (await archive()).length).toBe(1)
  const stored = {
    old: await page.evaluate(() => localStorage.getItem('zhumo.chaosheng.places.v1')),
    current: { version: 2, books: await archive() }
  }
  expect(stored.old).toBe(legacy)
  expect(stored.current.version).toBe(2)
  const saved = stored.current.books[0].places[0]
  expect(saved.address.schema).toBe(1)
  expect(saved.address.version).toEqual({
    path,
    length: source.length,
    digest: createHash('sha256').update(Buffer.from(source, 'utf16le')).digest('hex'),
    hash: 'sha256-utf16le-1',
    projection: 'zhumo-search-text-1'
  })
  expect(saved.address.match).toEqual({ start: 2, end: 4, text: '门槛' })
  expect(saved).not.toHaveProperty('before')
  expect(saved).not.toHaveProperty('word')
  await ledger()
  await expect(page.locator('.tidal-place-context')).toHaveText('😀门槛，在原来的字句中等待。')
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('an unresolvable cached address keeps its word visible without offering a false return', async () => {
  const source = '# 核对原句\n\n门槛，在这里留下一个位置。'
  await open(source)
  await hover(page.locator('.reader-scroll .section-body p'), '门槛')
  const books = await archive()
  books[0].places[0].address.blockIndex = 99999
  await storeArchive(books)
  await open(source)
  await ledger()
  await expect(page.locator('.tidal-place-context')).toHaveText('门槛')
  await expect(page.locator('.tidal-place-note')).toContainText('暂时无法核对')
  await expect(page.getByRole('button', { name: '回到这句', exact: true })).toBeDisabled()
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('legacy twenty-four places migrate, the twenty-fifth accumulates, and clear/undo/restart preserve every place', async () => {
  test.setTimeout(60000)
  const source =
    '# 回声仍然生长\n\n' +
    Array.from({ length: 220 }, (_, i) => `门槛，在第${i + 1}段原文中等待。`).join('\n\n')
  await open(source)
  const paragraphs = page.locator('.reader-scroll .section-body p')
  await hover(paragraphs.first(), '门槛')
  await expect.poll(async () => (await archive()).length).toBe(1)
  const seed = (await archive())[0]
  seed.places = Array.from({ length: 24 }, (_, i) => ({
    ...seed.places[0],
    address: {
      ...seed.places[0].address,
      blockIndex: seed.places[0].address.blockIndex + i,
      suffix: `，在第${i + 1}段原文中等待。`
    },
    at: Date.now() + i
  }))
  // Seed the exact legacy v2 shape under a fresh file identity, so migration is exercised.
  const nextFile = join(root, '从二十四继续.md')
  for (const p of seed.places) p.address.version = { ...p.address.version, path: nextFile }
  seed.key = tidalBookKey(seed.places[0].address.version)
  await page.evaluate(
    (book) =>
      localStorage.setItem(
        'zhumo.chaosheng.places.v2',
        JSON.stringify({ version: 2, books: [book] })
      ),
    seed
  )
  await open(source, nextFile)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('24 处')
  await hover(page.locator('.reader-scroll .section-body p').nth(24), '门槛')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('25 处')
  await ledger()
  await expect(page.locator('.tidal-place-word')).toHaveCount(25)
  await page.getByRole('button', { name: '清除本书停留', exact: true }).click()
  await expect(page.locator('.tidal-place-word')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销清除', exact: true }).click()
  await expect(page.locator('.tidal-place-word')).toHaveCount(25)
  await expect
    .poll(async () => (await archive()).find((b) => b.key === seed.key)?.places.length)
    .toBe(25)
  await app.evaluate(({ app }) => app.exit(0))
  await launch()
  await open(source, nextFile)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('25 处')
  const expanded = (await archive()).find((b) => b.key === seed.key)!
  expanded.places = Array.from({ length: 210 }, (_, i) => ({
    ...seed.places[0],
    address: {
      ...seed.places[0].address,
      blockIndex: seed.places[0].address.blockIndex + i,
      suffix: `，在第${i + 1}段原文中等待。`
    },
    position: (i + 0.5) / 220,
    at: Date.now() + i
  }))
  await storeArchive([expanded])
  await open(source, nextFile)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('210 处')
  await ledger()
  await expect(page.locator('.tidal-place-word')).toHaveCount(80)
  await expect(page.locator('.tidal-memory-dialog .echo-star')).toHaveCount(160)
  await page.getByRole('button', { name: '继续查看更早的回声', exact: true }).click()
  await page.getByRole('button', { name: '继续查看更早的回声', exact: true }).click()
  await expect(page.locator('.tidal-place-word')).toHaveCount(210)
  await page.getByRole('button', { name: '清除本书停留', exact: true }).click()
  await expect
    .poll(async () => (await archive()).find((b) => b.key === seed.key)?.places.length)
    .toBe(0)
  await closeLedger()
  await open(source, nextFile)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('0 处')
  expect(await readFile(nextFile, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('a failed database write preserves the newest echo and a later clear through reopening and restart', async () => {
  test.setTimeout(60000)
  const source = '# 回声存储故障\n\n自由与停留，在重开后仍能找到。'
  await open(source)
  const paragraph = page.locator('.reader-scroll .section-body p')
  await hover(paragraph, '自由')
  await expect.poll(async () => (await archive())[0]?.places.length).toBe(1)
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction
    Object.defineProperty(IDBDatabase.prototype, 'transaction', {
      configurable: true,
      value: function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ): IDBTransaction {
        if (args[1] === 'readwrite')
          throw new DOMException('Fixture disk-write failure', 'QuotaExceededError')
        return transaction.apply(this, args)
      }
    })
  })
  await hover(paragraph, '停留')
  await expect(page.locator('.tidal-memory-heading small')).toContainText('2 处')
  await open(source)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('2 处')
  expect((await archive())[0].places).toHaveLength(1)
  await ledger()
  await page.getByRole('button', { name: '清除本书停留', exact: true }).click()
  await app.evaluate(({ app }) => app.exit(0))
  await launch()
  await open(source)
  await expect(page.locator('.tidal-memory-heading small')).toContainText('0 处')
  await hover(page.locator('.reader-scroll .section-body p'), '停留')
  await expect
    .poll(async () => (await archive())[0].places.map((p) => p.address.match.text))
    .toEqual(['停留'])
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((k) => k.startsWith('zhumo.reading-echo.pending:'))
            .length
      )
    )
    .toBe(0)
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(errors).toEqual([])
})

test('changing books during a shared return cancels the old request without reopening its preview', async () => {
  await open('# 旧来处\n\n门槛，在旧文稿中留下一个位置。')
  await hover(page.locator('.reader-scroll .section-body p'), '门槛')
  await ledger()
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let first = true
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto['digest']>): Promise<ArrayBuffer> => {
        const pause = first
        first = false
        const value = await digest(...args)
        if (pause) await new Promise((resolve) => setTimeout(resolve, 650))
        return value
      }
    })
  })
  await page.getByRole('button', { name: '回到这句', exact: true }).click()
  await open('# 新来处\n\n这份文稿不应被旧请求拉走。', join(root, '新文稿.md'))
  await page.waitForTimeout(800)
  await expect(page.locator('.document-overture h1')).toHaveText('新来处')
  await expect(page.locator('.tidal-memory-dialog')).toBeHidden()
  await expect(page.locator('.tidal-memory-heading small')).toContainText('0 处')
  expect(errors).toEqual([])
})
