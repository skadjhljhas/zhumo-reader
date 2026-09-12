import shader from './lucent/light.wgsl?raw'
import { prepareHdr, scheduleHdr, cancelHdr, hdrMetrics } from './hdr'
export interface HdrFieldFrame {
  time: number
  x: number
  y: number
  progress: number
  field: Float32Array
  scrolling: [number, number, number, number]
  sky?: Float32Array
}
export class HdrFieldMotion {
  ready = false
  current: HdrFieldFrame | undefined
  setReady(value: boolean): void {
    this.ready = value
  }
  private listeners = new Set<(value: HdrFieldFrame) => void>()
  update(value: HdrFieldFrame): void {
    this.current = value
    this.listeners.forEach((listener) => listener(value))
  }
  subscribe(listener: (value: HdrFieldFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
const fieldPipelines = new WeakMap<GPUDevice, Promise<GPURenderPipeline>>()
export async function createHdrField(
  canvas: HTMLCanvasElement
): Promise<{ draw(frame: HdrFieldFrame): void; dispose(): void }> {
  const { device } = await prepareHdr()
  let pending = fieldPipelines.get(device)
  if (!pending) {
    const module = device.createShaderModule({ code: shader })
    pending = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    })
    fieldPipelines.set(device, pending)
  }
  const pipeline = await pending
  const context = canvas.getContext('webgpu')!
  context.configure({
    device,
    format: 'rgba16float',
    colorSpace: 'srgb',
    alphaMode: 'premultiplied',
    toneMapping: { mode: 'extended' },
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
  const values = new Float32Array(52)
  const buffer = device.createBuffer({
    size: values.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer } }
    ]
  })
  canvas.dataset.hdrFormat = 'rgba16float'
  canvas.dataset.hdrToneMapping = 'extended'
  canvas.dataset.hdrRenderer = 'native-field'
  let disposed = false
  return {
    draw(frame) {
      if (disposed) return
      const scale = Math.min(
        devicePixelRatio,
        device.limits.maxTextureDimension2D / innerWidth,
        device.limits.maxTextureDimension2D / innerHeight
      )
      const width = Math.max(1, Math.round(innerWidth * scale)),
        height = Math.max(1, Math.round(innerHeight * scale))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      values.set([width, height, frame.time, 0, frame.x, 1 - frame.y, frame.progress, 0])
      values.set(frame.field, 8)
      values.set(frame.scrolling, 40)
      values.set(frame.sky ?? [1.18, -0.25, 0.5, 0.5, 0, 0.5, 0.94, 0.7], 44)
      scheduleHdr(canvas, device, (encoder) => {
        if (disposed) return
        device.queue.writeBuffer(buffer, 0, values)
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: [0, 0, 0, 1],
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.draw(3)
        pass.end()
        hdrMetrics.passes++
        hdrMetrics.fieldDraws++
      })
    },
    dispose() {
      disposed = true
      cancelHdr(canvas)
      buffer.destroy()
      context.unconfigure()
    }
  }
}
