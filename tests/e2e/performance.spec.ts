import { electron, metricPath, executionMode } from './runtime'
import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('native Electron: half-million-character book remains readable and scrolls across its full length', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-perf-'))
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: root }
  })
  try {
    const page = await app.firstWindow(),
      errors: string[] = [],
      logs: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (/parse|worker/i.test(m.text())) logs.push(m.text())
    })
    await expect(page.getByText('另有天地。')).toBeVisible()
    const path = resolve('src/renderer/public/demo/stress-50w.md')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
    const start = Date.now()
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('.reader-scroll .section-body').first()).toBeVisible({
      timeout: 30000
    })
    const firstViewMs = Date.now() - start
    const metrics = await page.evaluate(async () => {
      const scroll = document.querySelector('.reader-scroll') as HTMLElement
      const frames: number[] = []
      let prev = performance.now()
      const start = prev
      await new Promise<void>((resolve) => {
        function frame(now: number): void {
          frames.push(now - prev)
          prev = now
          const fraction = Math.min(1, (now - start) / 10000)
          scroll.scrollTop = fraction * (scroll.scrollHeight - scroll.clientHeight)
          if (fraction < 1) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      const sorted = frames.slice(4).sort((a, b) => a - b)
      return {
        frames: sorted.length,
        frameP95Ms: sorted[Math.floor(sorted.length * 0.95)],
        frameMaxMs: sorted.at(-1),
        jank33Percent: (sorted.filter((x) => x > 33).length / sorted.length) * 100,
        sectionCount: document.querySelectorAll('.section-frame').length,
        visibleNoteCards: document.querySelectorAll('.note-card').length,
        noteTotal: document.querySelector('.notes-meta')?.textContent,
        domNodes: document.querySelectorAll('*').length
      }
    })
    await expect(page.locator('.section-frame').last().locator('.section-body')).toBeVisible()
    const processMetrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((p) => ({ type: p.type, memoryKB: p.memory.workingSetSize }))
    )
    expect(errors).toEqual([])
    expect(metrics.sectionCount).toBeGreaterThan(40)
    expect(metrics.noteTotal).toContain('3000')
    expect(metrics.visibleNoteCards).toBeLessThan(80)
    await mkdir('work', { recursive: true })
    await writeFile(
      metricPath('native-performance.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          executionMode,
          platform: `Electron 42 / Windows / ${executionMode}`,
          firstViewMs,
          ...metrics,
          processes: processMetrics,
          logs,
          errors
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ firstViewMs, ...metrics }))
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
