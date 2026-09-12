// Real browser DOM projection, without Electron, network access or a visible window.
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

;(async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL('../../tests/browser/manuscript-profile.ts', import.meta.url))
    ],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    define: { PACKAGE_VERSION: JSON.stringify('3.2.2') }
  })
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true
  })
  const page = await browser.newPage(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(async () => {
      const api = window.themeProfileTest
      const parent = api.measureManuscript(
        api.parseBook('- 父项[^1]\n  - 子项\n\n[^1]: - 注内父项\n      - 注内子项')
      )
      const atomic = api.measureManuscript(
        api.parseBook(
          '# 原子区域\n\n文字😀 $x^2$。[^1]\n\n| 甲 | 乙 |\n| --- | --- |\n| 值 | 文 |\n\n```mermaid\nA --> B\n```\n\n[^1]: 数学 $y+1$。'
        )
      )
      const paragraphs = Array.from(
        { length: 5000 },
        (_, i) => '第' + i + '段。' + '文字与旁注在阅读中相遇。'.repeat(8)
      ).join('\n\n')
      const book = api.parseBook(paragraphs)
      let callbacks = 0,
        frame
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- This verifier runs directly as JavaScript.
      const paint = () => {
        callbacks++
        frame = requestAnimationFrame(paint)
      }
      frame = requestAnimationFrame(paint)
      const profile = await api.measureManuscriptAsync(book, { budgetMs: 2 })
      cancelAnimationFrame(frame)
      const controller = new AbortController()
      let yields = 0,
        cancelled = ''
      try {
        await api.measureManuscriptAsync(api.parseBook(paragraphs), {
          signal: controller.signal,
          budgetMs: 1,
          yield: async () => {
            if (++yields === 2) controller.abort()
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        })
      } catch (error) {
        cancelled = error.name
      }
      return {
        parent,
        atomic,
        long: {
          chars: book.stats.chars,
          callbacks,
          cached: api.measureManuscript(book) === profile
        },
        yields,
        cancelled
      }
    })
    assert.equal(result.parent.noteChars, 8)
    assert(
      result.parent.spectrum.some((value) => value !== 0),
      'A reference on a nested list parent must affect the light.'
    )
    assert.equal(
      result.atomic.noteChars,
      6,
      'Math source is counted once, without duplicate rendered glyph layers.'
    )
    assert(result.long.chars > 500000)
    assert(result.long.callbacks > 0, 'Long analysis must yield to a frame callback.')
    assert(result.long.cached)
    assert.equal(result.yields, 2)
    assert.equal(result.cancelled, 'AbortError')
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        nestedList: true,
        atomicText: true,
        long: result.long,
        cancellationAfterWork: true
      })
    )
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
