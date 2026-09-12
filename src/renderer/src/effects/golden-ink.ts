import shader from './golden-ink.wgsl?raw'
import { prepareHdr, scheduleHdr, cancelHdr } from './hdr'
const pipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, Promise<GPURenderPipeline>>>()
export async function createGoldenInk(
  canvas: HTMLCanvasElement,
  hdr: boolean,
  lost: () => void
): Promise<{
  upload(mask: HTMLCanvasElement, width: number, height: number): void
  draw(time: number, strength: number, reveal: number): void
  dispose(): void
}> {
  const { device } = await prepareHdr()
  const format: GPUTextureFormat = hdr ? 'rgba16float' : 'rgba8unorm'
  let variants = pipelines.get(device)
  if (!variants) {
    variants = new Map()
    pipelines.set(device, variants)
  }
  let pending = variants.get(format)
  if (!pending) {
    const module = device.createShaderModule({ code: shader })
    pending = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] }
    })
    variants.set(format, pending)
  }
  const pipeline = await pending,
    context = canvas.getContext('webgpu')!
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
    colorSpace: 'srgb',
    toneMapping: { mode: hdr ? 'extended' : 'standard' },
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
  canvas.dataset.hdrRenderer = 'golden-glyphs'
  canvas.dataset.hdrFormat = format
  const buffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const values = new Float32Array(8)
  let texture: GPUTexture | undefined,
    bind: GPUBindGroup | undefined,
    disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelHdr(canvas)
    texture?.destroy()
    buffer.destroy()
    context.unconfigure()
  }
  void device.lost.then(() => {
    if (!disposed) {
      dispose()
      lost()
    }
  })
  return {
    upload(mask, width, height) {
      if (disposed) return
      values.set([width, height, 0, 0])
      canvas.width = mask.width
      canvas.height = mask.height
      if (!texture || texture.width !== mask.width || texture.height !== mask.height) {
        texture?.destroy()
        texture = device.createTexture({
          size: [mask.width, mask.height],
          format: 'rgba8unorm',
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT
        })
        bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer } }
          ]
        })
      }
      device.queue.copyExternalImageToTexture({ source: mask }, { texture }, [
        mask.width,
        mask.height
      ])
    },
    draw(time, strength, reveal) {
      if (disposed || !bind) return
      values.set([time, strength, reveal, hdr ? 1 : 0], 4)
      scheduleHdr(canvas, device, (encoder) => {
        if (disposed || !bind) return
        device.queue.writeBuffer(buffer, 0, values)
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: [0, 0, 0, 0],
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.draw(3)
        pass.end()
      })
    },
    dispose
  }
}
