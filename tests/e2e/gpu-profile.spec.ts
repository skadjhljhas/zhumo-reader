/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

test('measure native optical shader GPU time without window presentation or readback per frame', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-gpu-timing-'))
  const main = join(root, 'main.cjs'),
    html = join(root, 'index.html')
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Isolated GPU timing</title>')
  await writeFile(
    main,
    `process.on('uncaughtException',e=>{process.stderr.write(String(e));process.exit(1)});const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.ZHUMO_USER_DATA);app.whenReady().then(()=>{const w=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});w.webContents.setFrameRate(60);w.loadFile(${JSON.stringify(html)})});app.on('window-all-closed',()=>app.quit());`
  )
  const app = await electron.launch({
    args: [main],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  try {
    const page = await app.firstWindow()
    const shader = await readFile('src/renderer/src/effects/lucent/light.wgsl', 'utf8')
    const result = await page.evaluate(async (shader) => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter?.features.has('timestamp-query')) return { supported: false }
      const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] })
      const module = device.createShaderModule({ code: shader })
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }
      })
      const uniform = device.createBuffer({
        size: 208,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      const lattice = device.createTexture({
        size: [256, 256],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      })
      device.queue.writeTexture(
        { texture: lattice },
        crypto.getRandomValues(new Uint8Array(65536)),
        { bytesPerRow: 256 },
        [256, 256]
      )
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: lattice.createView() }
        ]
      })
      const results: Array<{
        width: number
        height: number
        medianMs: number
        p95Ms: number
        totalMs: number
      }> = []
      for (const [width, height] of [
        [1920, 1080],
        [3840, 2160]
      ]) {
        const values = new Float32Array(52)
        values.fill(0.4)
        values.set([width, height, 100, 0, 0.7, 0.5, 0.5, 0])
        values.set([0, 0, 0, 0.5], 40)
        values.set([1.18, -0.25, 0.5, 0.5, 0, 0.5, 0.94, 0.7], 44)
        device.queue.writeBuffer(uniform, 0, values)
        const target = device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT
        })
        const query = device.createQuerySet({ type: 'timestamp', count: 128 })
        const resolved = device.createBuffer({
          size: 1024,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
        })
        const read = device.createBuffer({
          size: 1024,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        })
        const encoder = device.createCommandEncoder()
        for (let i = 0; i < 64; i++) {
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: target.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1]
              }
            ],
            timestampWrites: {
              querySet: query,
              beginningOfPassWriteIndex: i * 2,
              endOfPassWriteIndex: i * 2 + 1
            }
          })
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bind)
          pass.draw(3)
          pass.end()
        }
        encoder.resolveQuerySet(query, 0, 128, resolved, 0)
        encoder.copyBufferToBuffer(resolved, 0, read, 0, 1024)
        const started = performance.now()
        device.queue.submit([encoder.finish()])
        await read.mapAsync(GPUMapMode.READ)
        const stamps = new BigUint64Array(read.getMappedRange()),
          ms: number[] = []
        for (let i = 4; i < 64; i++) ms.push(Number(stamps[i * 2 + 1] - stamps[i * 2]) / 1e6)
        ms.sort((a, b) => a - b)
        results.push({
          width,
          height,
          medianMs: ms[30],
          p95Ms: ms[57],
          totalMs: performance.now() - started
        })
        read.unmap()
        read.destroy()
        resolved.destroy()
        query.destroy()
        target.destroy()
      }
      const info = {
        supported: true,
        adapter: adapter.info.description || adapter.info.vendor,
        results
      }
      uniform.destroy()
      lattice.destroy()
      device.destroy()
      return info
    }, shader)
    await mkdir('work/hdr-perf', { recursive: true })
    await writeFile('work/hdr-perf/gpu-time.json', JSON.stringify(result, null, 2))
    expect(result.supported).toBe(true)
  } finally {
    await app.close()
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-gpu-timing-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
