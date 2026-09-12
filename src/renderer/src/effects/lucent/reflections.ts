import shader from './reflection.wgsl?raw'
import { prepareHdr, scheduleHdr, cancelHdr } from '../hdr'
import type { HdrFieldFrame } from '../hdr-field'
import { glyphMaskPosition, type GlyphMask } from './glyph-mask'

export async function createGlyphReflections(
  canvas: HTMLCanvasElement,
  hdr: boolean,
  onDeviceLost?: () => void
): Promise<{
  setMasks(masks: GlyphMask[]): void
  draw(frame: HdrFieldFrame): void
  dispose(): void
}> {
  const { device } = await prepareHdr()
  const format: GPUTextureFormat = hdr ? 'rgba16float' : 'rgba8unorm'
  const module = device.createShaderModule({ code: shader })
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex' },
    fragment: {
      module,
      entryPoint: 'fragment',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
          }
        }
      ]
    }
  })
  const context = canvas.getContext('webgpu')!
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
    colorSpace: 'srgb',
    toneMapping: { mode: hdr ? 'extended' : 'standard' },
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const mipModule = device.createShaderModule({
    code: `
    @group(0) @binding(0) var source: texture_2d<f32>;
    @group(0) @binding(1) var sampling: sampler;
    struct V { @builtin(position) position: vec4f, @location(0) uv: vec2f }
    @vertex fn vertex(@builtin(vertex_index) i:u32)->V {
      let points=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
      let p=points[i];return V(vec4f(p,0.,1.),vec2f(p.x*.5+.5,.5-p.y*.5));
    }
    @fragment fn fragment(v:V)->@location(0)vec4f{return textureSampleLevel(source,sampling,v.uv,0.);}
  `
  })
  const mipPipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: mipModule, entryPoint: 'vertex' },
    fragment: { module: mipModule, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] }
  })
  const reflectionSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear'
  })
  function soften(texture: GPUTexture): void {
    const encoder = device.createCommandEncoder()
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const bind = device.createBindGroup({
        layout: mipPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 })
          },
          { binding: 1, resource: sampler }
        ]
      })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0]
          }
        ]
      })
      pass.setPipeline(mipPipeline)
      pass.setBindGroup(0, bind)
      pass.draw(3)
      pass.end()
    }
    device.queue.submit([encoder.finish()])
  }
  type Layer = { mask: GlyphMask; texture: GPUTexture; buffer: GPUBuffer; bind: GPUBindGroup }
  let layers: Layer[] = [],
    disposed = false
  function release(layer: Layer): void {
    layer.texture.destroy()
    layer.buffer.destroy()
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelHdr(canvas)
    for (const layer of layers) release(layer)
    layers = []
    context.unconfigure()
  }
  void device.lost.then(() => {
    if (disposed) return
    dispose()
    onDeviceLost?.()
  })
  canvas.dataset.hdrRenderer = 'glyph-reflections'
  canvas.dataset.hdrFormat = format
  return {
    setMasks(masks) {
      if (disposed) return
      const next: Layer[] = []
      for (const mask of masks) {
        const old = layers.find((layer) => layer.mask.port === mask.port)
        if (old) {
          if (
            old.mask !== mask &&
            old.texture.width === mask.canvas.width &&
            old.texture.height === mask.canvas.height
          ) {
            device.queue.copyExternalImageToTexture(
              { source: mask.canvas },
              { texture: old.texture },
              [mask.canvas.width, mask.canvas.height]
            )
            soften(old.texture)
            old.mask = mask
          }
        }
        if (old && old.mask === mask) {
          next.push(old)
          continue
        }
        const texture = device.createTexture({
          size: [mask.canvas.width, mask.canvas.height],
          format: 'rgba8unorm',
          mipLevelCount: 5,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT
        })
        device.queue.copyExternalImageToTexture({ source: mask.canvas }, { texture }, [
          mask.canvas.width,
          mask.canvas.height
        ])
        soften(texture)
        const buffer = device.createBuffer({
          size: 112,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer } },
            { binding: 1, resource: texture.createView() },
            { binding: 2, resource: reflectionSampler }
          ]
        })
        next.push({ mask, texture, buffer, bind })
      }
      for (const old of layers) if (!next.includes(old)) release(old)
      layers = next
      canvas.dataset.glyphs = String(masks.reduce((total, mask) => total + mask.glyphs, 0))
    },
    draw(frame) {
      if (disposed) return
      const scale = Math.min(devicePixelRatio, 2)
      const width = Math.round(innerWidth * scale),
        height = Math.round(innerHeight * scale)
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const sky = frame.sky ?? new Float32Array([2.65, -1.65, 0.5, 0.5, 0, 0.5, 1, 0.7])
      for (const layer of layers) {
        const p = glyphMaskPosition(layer.mask),
          values = new Float32Array(28)
        values.set([innerWidth, innerHeight, frame.time, hdr ? 1 : 0])
        values.set([p.clip.left, p.clip.top, p.clip.width, p.clip.height], 4)
        values.set([p.x, p.y, p.width, p.height], 8)
        values.set(
          [sky[0] * innerWidth, sky[1] * innerHeight, sky[2] * innerWidth, sky[3] * innerHeight],
          12
        )
        values.set([sky[6], frame.field[23] * Math.PI * 2, sky[4], 1], 16)
        values.set(
          [frame.field[22] * Math.PI * 2, frame.field[21] * Math.PI * 2, frame.field[16], sky[5]],
          20
        )
        values.set(
          [
            frame.field[8],
            frame.field[9],
            frame.field[10] * innerWidth,
            frame.field[11] * innerHeight
          ],
          24
        )
        device.queue.writeBuffer(layer.buffer, 0, values)
      }
      scheduleHdr(canvas, device, (encoder) => {
        if (disposed) return
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 0]
            }
          ]
        })
        pass.setPipeline(pipeline)
        for (const layer of layers) {
          pass.setBindGroup(0, layer.bind)
          pass.draw(6)
        }
        pass.end()
      })
    },
    dispose
  }
}
