import { app, screen, type BrowserWindow } from 'electron'
import { open, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

let claimed = false
/** Explicit developer capture: timing and device metadata only, never book text or keys. */
export async function startPerformanceReport(window: BrowserWindow): Promise<void> {
  const path = process.env.ZHUMO_PERF_REPORT
  if (!path || claimed) return
  claimed = true
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return
  const file = await open(path, 'wx', 0o600)
  let busy = false,
    samples = 0,
    ended = false
  const deadline = Date.now() + 5 * 60 * 1000
  let profileStarted = false,
    ownsDebugger = false,
    profileTimer: ReturnType<typeof setTimeout> | undefined
  let initialMetrics: unknown
  const stopProfile = async (): Promise<void> => {
    clearTimeout(profileTimer)
    if (!ownsDebugger || window.isDestroyed()) return
    try {
      const profile = await window.webContents.debugger.sendCommand('Profiler.stop')
      const metrics = await window.webContents.debugger.sendCommand('Performance.getMetrics')
      await writeFile(path + '.cpu.json', JSON.stringify({ initialMetrics, metrics, ...profile }), {
        flag: 'wx'
      })
    } finally {
      if (ownsDebugger && !window.isDestroyed()) window.webContents.debugger.detach()
      ownsDebugger = false
    }
  }
  const finish = async (): Promise<void> => {
    if (ended) return
    ended = true
    clearInterval(timer)
    if (!busy) await file.close()
  }
  const sample = async (): Promise<void> => {
    if (busy || ended) return
    if (Date.now() > deadline) {
      await finish()
      return
    }
    if (window.isDestroyed()) {
      await finish()
      return
    }
    if (!window.isVisible() || window.isMinimized()) return
    busy = true
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const optics = await Promise.race([
        window.webContents.executeJavaScript(`(() => {
        const d=document.documentElement.dataset;
        return {fps:Number(d.hdrFps||0),p95Ms:Number(d.hdrP95Ms||0),
          submissions:Number(d.hdrSubmissions||0),copies:Number(d.hdrSourceCopies||0),
          bandDraws:Number(d.hdrBandDraws||0),fieldDraws:Number(d.hdrFieldDraws||0),gpu:d.hdrGpu||'',gpuQueueWaitMs:Number(d.hdrGpuQueueWaitMs||0),range:d.lightRange||'sdr'};
      })()`),
        new Promise<never>((_done, reject) => {
          timeout = setTimeout(() => reject(Error('Renderer temporarily paused')), 1000)
        })
      ]).finally(() => clearTimeout(timeout))
      const display = screen.getDisplayMatching(window.getBounds())
      if (process.env.ZHUMO_PERF_CPU === '1' && optics.range === 'hdr' && !profileStarted) {
        profileStarted = true
        if (!window.webContents.debugger.isAttached()) {
          window.webContents.debugger.attach('1.3')
          ownsDebugger = true
          window.webContents.debugger.once('detach', () => {
            ownsDebugger = false
          })
          await window.webContents.debugger.sendCommand('Performance.enable')
          initialMetrics = await window.webContents.debugger.sendCommand('Performance.getMetrics')
          await window.webContents.debugger.sendCommand('Profiler.enable')
          await window.webContents.debugger.sendCommand('Profiler.start')
          profileTimer = setTimeout(() => {
            void stopProfile().catch(() => undefined)
          }, 10000)
        }
      }
      await file.write(
        JSON.stringify({
          at: new Date().toISOString(),
          optics,
          refreshHz: display.displayFrequency,
          scale: display.scaleFactor,
          bounds: window.getBounds(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          offscreen: window.webContents.isOffscreen(),
          processes: app
            .getAppMetrics()
            .map((metric) => ({ type: metric.type, cpu: metric.cpu.percentCPUUsage }))
        }) + '\n'
      )
      if (optics.range === 'hdr' && optics.fps > 0 && window.isFocused()) samples++
    } catch (error) {
      if (!ended)
        await file.write(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'
        )
    } finally {
      busy = false
      if (ended) await file.close()
      else if (samples >= 20) await finish()
    }
  }
  const timer = setInterval(() => {
    void sample()
  }, 1000)
  window.once('closed', () => {
    clearTimeout(profileTimer)
    void finish()
  })
  await file.write(
    JSON.stringify({
      version: app.getVersion(),
      features: app.getGPUFeatureStatus(),
      gpu: await app.getGPUInfo('complete'),
      measure: 'HDR animation submissions; onscreen and offscreen are recorded separately'
    }) + '\n'
  )
}
