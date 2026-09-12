import { test, expect } from '@playwright/test'
import { electron } from './runtime'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/shared/ipc-types'
import { lucentNoiseValues } from '../../src/renderer/src/effects/lucent/noise-texture'

test('render fixed distant sky directions with the production HDR shader', async () => {
  test.setTimeout(60000)
  const root = await mkdtemp(join(tmpdir(), 'zhumo-sky-poses-')),
    profile = join(root, 'profile'),
    book = join(root, '在天光中.md')
  const output = resolve('../朱墨-AI细读/天光方位61')
  await mkdir(profile)
  await mkdir(output, { recursive: true })
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ ...DEFAULT_SETTINGS, lightRange: 'hdr', automaticSyntax: false })
  )
  await writeFile(
    book,
    '# 文字接住一束光\n\n阅读并不把世界关在书页之外。窗外的光、此刻的迟疑、曾经读过的另一句话，都在这一行之间停留。\n\n文字保持自己的重量。光沿着笔画的边缘经过，轻轻留下冷暖的差异，然后散入那些尚未被说出的空隙。[^光]\n\n## 不是每一处明亮都需要解释\n\n有时，一个词在另一段文字里才获得回声；有时，我们回到原处，才发现它已经微微改变了颜色。\n\n真正缓慢的变化，不催促目光。它让阅读拥有可以停留的时间，让理解保有尚未完成的余地。\n\n在这里，空白仍有空气，文字仍然清晰。\n\n公式也保持原来的字形：$2H_2+O_2\\longrightarrow2H_2O$。\n\n[^光]: 天光从画外而来。它的位置和色彩由时间、文本与阅读行为共同影响，保留不易预料的游移。\n'
  )
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: profile }
  })
  try {
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      localStorage.setItem('zhumo.studio.theme', 'lucent')
      const original = window.matchMedia.bind(window)
      window.matchMedia = (query) => {
        const media = original(query)
        if (query === '(dynamic-range: high)')
          Object.defineProperty(media, 'matches', { get: () => true })
        return media
      }
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    })
    await page.reload()
    await app.evaluate(({ dialog }, book) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] })
    }, book)
    await page.getByRole('button', { name: /^打开(?: Markdown|文件)$/, exact: true }).click()
    await expect(page.locator('[data-hdr-renderer="native-field"]')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.addStyleTag({ content: '.glyph-reflection-field{visibility:hidden!important}' })
    await page.evaluate(() =>
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    )
    await page.waitForTimeout(80)
    const field = new Float32Array(32).fill(0.4)
    const target = await page.evaluateHandle(
      async ({ shader, noise }) => {
        const canvas = document.querySelector(
          '[data-hdr-renderer="native-field"]'
        ) as HTMLCanvasElement
        const context = canvas.getContext('webgpu')!,
          device = context.getConfiguration()!.device
        const module = device.createShaderModule({ code: shader })
        const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'previewFragment', targets: [{ format: 'rgba16float' }] }
        })
        const uniform = device.createBuffer({
          size: 208,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
        const texture = device.createTexture({
          size: [256, 256],
          format: 'r8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        })
        device.queue.writeTexture(
          { texture },
          new Uint8Array(noise),
          { bytesPerRow: 256 },
          [256, 256]
        )
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: texture.createView() }
          ]
        })
        return { canvas, context, device, pipeline, uniform, texture, bind }
      },
      {
        shader:
          (await readFile('src/renderer/src/effects/lucent/light.wgsl', 'utf8')).replace(
            '@fragment fn fragment(frame:FieldVertex) -> @location(0) vec4f',
            'fn opticalHdrPixel(frame:FieldVertex) -> vec4f'
          ) +
          `\n@fragment fn previewFragment(frame:FieldVertex) -> @location(0) vec4f {
          let color=opticalHdrPixel(frame).rgb;
          let peak=max(color.r,max(color.g,color.b));
          let shoulder=.7+.3*(1.-exp(-max(peak-.7,0.)/.3));
          return vec4f(color*select(1.,shoulder/peak,peak>.7),1.);
        }`,
        noise: [...lucentNoiseValues()]
      }
    )
    const poses = [
      {
        name: '右上',
        file: 'upper-right.png',
        sky: [2.65, -1.65, 0.5, 0.5, 0.03, 0.55, 0.96, 0.7]
      },
      {
        name: '左上',
        file: 'upper-left.png',
        sky: [-1.65, -1.65, 0.5, 0.53, -0.07, 0.55, 0.96, 0.7]
      },
      { name: '左侧', file: 'left.png', sky: [-1.75, 0.46, 0.54, 0.51, 0.06, 0.55, 0.96, 0.1] },
      { name: '下方', file: 'below.png', sky: [0.65, 2.75, 0.49, 0.48, 0.08, 0.55, 0.96, -0.9] }
    ]
    for (const pose of poses) {
      await target.evaluate(
        async ({ canvas, context, device, pipeline, uniform, bind }, { sky, field }) => {
          const values = new Float32Array(52)
          values.set([canvas.width, canvas.height, 65, 0, 0.65, 0.5, 0.2, 0])
          values.set(field, 8)
          values.set([0, 0, 0, 0.5], 40)
          values.set(sky, 44)
          device.queue.writeBuffer(uniform, 0, values)
          const encoder = device.createCommandEncoder()
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1]
              }
            ]
          })
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bind)
          pass.draw(3)
          pass.end()
          device.queue.submit([encoder.finish()])
          await device.queue.onSubmittedWorkDone()
          if (!canvas.dataset.proofLoop) {
            canvas.dataset.proofLoop = 'on'
            const redraw = (): void => {
              if (canvas.dataset.proofLoop !== 'on') return
              const command = device.createCommandEncoder()
              const painting = command.beginRenderPass({
                colorAttachments: [
                  {
                    view: context.getCurrentTexture().createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 1]
                  }
                ]
              })
              painting.setPipeline(pipeline)
              painting.setBindGroup(0, bind)
              painting.draw(3)
              painting.end()
              device.queue.submit([command.finish()])
              requestAnimationFrame(redraw)
            }
            requestAnimationFrame(redraw)
          }
        },
        { sky: pose.sky, field: [...field] }
      )
      await page.screenshot({ path: join(output, pose.file) })
    }
    expect(
      await page
        .locator('.zmu-math *')
        .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).textShadow === 'none'))
    ).toBe(true)
    const seam = await target.evaluate(
      async ({ canvas, context, device, pipeline, uniform, bind }, field) => {
        canvas.dataset.proofLoop = 'off'
        let reference: Uint16Array | undefined,
          maximum = 0
        const half = (v: number): number => {
          const e = (v >> 10) & 31,
            m = v & 1023
          return (v & 32768 ? -1 : 1) * (e ? 2 ** (e - 15) * (1 + m / 1024) : (2 ** -14 * m) / 1024)
        }
        for (const offset of [-0.00001, 0.00001]) {
          const values = new Float32Array(52)
          values.set([canvas.width, canvas.height, 65, 0, 0.65, 0.5, 0.2, 0])
          values.set(field, 8)
          values.set([0, 0, 0, 0.5], 40)
          values.set([0.5 + offset, 1.25, 0.5, 0.5, 0.08, 0.55, 0.96, -0.9], 44)
          device.queue.writeBuffer(uniform, 0, values)
          const texture = context.getCurrentTexture(),
            stride = Math.ceil((texture.width * 8) / 256) * 256
          const pixels = device.createBuffer({
            size: stride * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          })
          const encoder = device.createCommandEncoder()
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: texture.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1]
              }
            ]
          })
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, bind)
          pass.draw(3)
          pass.end()
          encoder.copyTextureToBuffer({ texture }, { buffer: pixels, bytesPerRow: stride }, [
            texture.width,
            texture.height
          ])
          device.queue.submit([encoder.finish()])
          await pixels.mapAsync(GPUMapMode.READ)
          const data = new Uint16Array(pixels.getMappedRange())
          if (!reference) reference = new Uint16Array(data)
          else
            for (let y = 0; y < texture.height; y += 7)
              for (let x = 0; x < texture.width; x += 7)
                for (let c = 0; c < 3; c++) {
                  const at = (y * stride) / 2 + x * 4 + c
                  maximum = Math.max(maximum, Math.abs(half(data[at]) - half(reference[at])))
                }
          pixels.unmap()
          pixels.destroy()
        }
        return maximum
      },
      [...field]
    )
    expect(seam).toBeLessThan(0.0025)
    await writeFile(
      join(output, 'continuity.json'),
      JSON.stringify({ belowSeamMaximumChannelDifference: seam }, null, 2)
    )
    await target.evaluate(({ uniform, texture }) => {
      uniform.destroy()
      texture.destroy()
    })
    await target.dispose()
    await writeFile(
      join(output, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>天光方位</title><style>body{padding:30px;background:#edf4f8;color:#294555;font:16px system-ui}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}img{width:100%}</style><h1>远处天光的四个方位</h1><p>此页只比较背景光场。HDR 高光压缩为 SDR 预览。</p><div class="grid">${poses.map((p) => `<figure><img src="${p.file}"><figcaption>${p.name}</figcaption></figure>`).join('')}</div>`
    )
  } finally {
    await app.close()
    const part = relative(await realpath(tmpdir()), await realpath(root))
    expect(part.startsWith('zhumo-sky-poses-') && !part.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
