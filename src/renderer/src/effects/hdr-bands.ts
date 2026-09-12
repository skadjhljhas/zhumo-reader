import { watch } from 'vue'
import { prepareHdr, scheduleHdr, cancelHdr, hdrMetrics, nativeInkEnabled } from './hdr'
import type { ColorTile } from './color-tiles'

export interface HdrBandFrame {
  wake: number
  intensity: number
  now: number
}
/** Animation uniforms travel directly to renderers, without rerendering the Vue/SVG tree. */
export class HdrBandMotion {
  current: HdrBandFrame = { wake: 0, intensity: 1, now: performance.now() }
  private listeners = new Set<(frame: HdrBandFrame) => void>()
  update(wake: number, intensity: number, now: number): void {
    this.current.wake = wake
    this.current.intensity = intensity
    this.current.now = now
    this.listeners.forEach((listener) => listener(this.current))
  }
  subscribe(listener: (frame: HdrBandFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
const shader = /* wgsl */ `
struct Band { rect: vec4f, cool: vec4f, warm: vec4f, main: vec4f, timing: vec4f }
struct Options { tile: vec4f, motion: vec4f, flags: vec4f }
@group(0) @binding(0) var<storage, read> bands: array<Band>;
@group(0) @binding(1) var<uniform> options: Options;
struct Vertex { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) v: u32, @builtin(instance_index) instance: u32) -> Vertex {
  let band = bands[instance / 3u]; let lobe = instance % 3u + select(0u,3u,options.motion.w>.5);
  let points = array<vec2f,6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));
  let local = points[v];
  var color = band.main; var offset = vec2f(0.);
  if (lobe == 0u) { color = band.cool; offset = vec2f(-band.rect.z*.13,options.motion.x); }
  if (lobe == 1u) { color = band.warm; offset = vec2f(band.rect.z*.17,-options.motion.x*.6); }
  var center = band.rect.xy + band.rect.zw*vec2f(.5,.61) + offset;
  var radius = vec2f(max(5.,band.rect.z*.62),max(.01,band.rect.w*.66));
  let radiance = band.timing.y;
  if (lobe == 3u) {
    color = vec4f(mix(band.cool.rgb,band.warm.rgb,.52)*1.85,.14*radiance);
    radius = vec2f(band.rect.z*.7+70.*radiance,band.rect.w*.8+65.*radiance);
  }
  if (lobe == 4u) {
    color = vec4f(mix(band.main.rgb,vec3f(2.8,2.72,2.52),.72),.065*radiance);
    center += vec2f(45.*radiance+sin(options.motion.z*.17+band.rect.x)*3.*radiance,-115.*radiance);
    radius = max(vec2f(.01),vec2f(85.,210.)*radiance);
  }
  if (lobe == 5u) {
    color = vec4f(mix(band.main.rgb,vec3f(3.9,3.7,3.3),.8),.26*radiance);
    center.y = band.rect.y+band.rect.w*.48;
    radius = vec2f(band.rect.z*.54+30.*radiance,3.+radiance*3.);
  }
  if (options.flags.x < .5) { color = vec4f(clamp(color.rgb,vec3f(0.),vec3f(1.)),color.a); }
  let uv = (center + local*radius-options.tile.xy)/options.tile.zw;
  let progress = clamp((options.motion.z-band.timing.x)/2.6,0.,1.);
  let reveal = progress*progress*(3.-2.*progress);
  return Vertex(vec4f(uv.x*2.-1.,1.-uv.y*2.,0.,1.),local,vec4f(color.rgb,color.a*reveal*options.motion.y));
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  let r = length(input.local);
  if (r >= 1. || input.color.a <= 0.) { discard; }
  let feather = select(1.-r/.42*(1.-160./255.),160./255.*(1.-(r-.42)/.58),r>.42);
  let alpha = max(0.,feather)*input.color.a;
  return vec4f(input.color.rgb*alpha,alpha);
}`
const pipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, Promise<GPURenderPipeline>>>()
function pipelineFor(
  device: GPUDevice,
  format: GPUTextureFormat = 'rgba16float'
): Promise<GPURenderPipeline> {
  let variants = pipelines.get(device)
  if (!variants) {
    variants = new Map()
    pipelines.set(device, variants)
  }
  let pipeline = variants.get(format)
  if (!pipeline) {
    const module = device.createShaderModule({ code: shader })
    pipeline = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
    variants.set(format, pipeline)
  }
  return pipeline
}
// Compile while the HDR reading room is opening, before the first streamed mark arrives.
watch(
  nativeInkEnabled,
  (enabled) => {
    if (enabled)
      void prepareHdr()
        .then(({ device }) => Promise.all([pipelineFor(device), pipelineFor(device, 'rgba8unorm')]))
        .catch(() => undefined)
  },
  { immediate: true }
)
export async function createHdrBands(
  canvas: HTMLCanvasElement,
  radianceOnly = false,
  hdr = true
): Promise<{
  setTile(tile: ColorTile): void
  draw(frame: HdrBandFrame): void
  dispose(): void
}> {
  const format = hdr ? 'rgba16float' : 'rgba8unorm'
  const { device } = await prepareHdr(),
    pipeline = await pipelineFor(device, format)
  const context = canvas.getContext('webgpu')!
  context.configure({
    device,
    format,
    colorSpace: 'srgb',
    alphaMode: 'premultiplied',
    toneMapping: { mode: hdr ? 'extended' : 'standard' },
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
  canvas.dataset.hdrFormat = format
  canvas.dataset.hdrToneMapping = hdr ? 'extended' : 'standard'
  canvas.dataset.hdrRenderer = radianceOnly ? 'radiance-field' : 'instanced-bands'
  const epoch = performance.now(),
    values = new Float32Array(12)
  values[8] = hdr ? 1 : 0
  const uniform = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  let buffer: GPUBuffer | undefined,
    bind: GPUBindGroup,
    count = 0,
    disposed = false
  let capacity = 0,
    previousData: Float32Array | undefined
  function resizeSurface(): void {
    if (!values[2] || !values[3]) return
    const scale = Math.min(
      devicePixelRatio,
      device.limits.maxTextureDimension2D / values[2],
      device.limits.maxTextureDimension2D / values[3]
    )
    const width = Math.max(1, Math.ceil(values[2] * scale)),
      height = Math.max(1, Math.ceil(values[3] * scale))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
  }
  // A lobe has a constant colour: perform its transfer function once, rather than
  // repeating six powers for every covered fragment on every frame.
  const color = (hex: string, alpha: number): number[] =>
    [1, 3, 5]
      .map((at) => {
        const c = parseInt(hex.slice(at, at + 2), 16) / 255
        const energy = (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * (hdr ? 7 : 1)
        return energy <= 0.0031308 ? energy * 12.92 : 1.055 * energy ** (1 / 2.4) - 0.055
      })
      .concat(alpha)
  return {
    setTile(tile) {
      if (disposed) return
      values.set([tile.x, tile.y, tile.width, tile.height])
      resizeSurface()
      count = tile.bands.length
      const data = new Float32Array(Math.max(1, count) * 20)
      tile.bands.forEach((band, index) =>
        data.set(
          [
            band.x,
            band.y,
            band.width,
            band.height,
            ...color(band.ink.palette.cool, 0.16),
            ...color(band.ink.palette.warm, 0.15),
            ...color(band.ink.palette.main, 0.48),
            (band.ink.born - epoch) / 1000,
            band.ink.mark.radiance ?? 0,
            0,
            0
          ],
          index * 20
        )
      )
      if (!buffer || capacity < data.byteLength) {
        buffer?.destroy()
        capacity = Math.max(data.byteLength, capacity * 2)
        buffer = device.createBuffer({
          size: capacity,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        })
        bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer } },
            { binding: 1, resource: { buffer: uniform } }
          ]
        })
        previousData = undefined
      }
      if (
        !previousData ||
        previousData.length !== data.length ||
        data.some((value, index) => value !== previousData![index])
      )
        device.queue.writeBuffer(buffer, 0, data)
      previousData = data
    },
    draw(frame) {
      if (disposed || !buffer) return
      resizeSurface()
      values.set([frame.wake, frame.intensity, (frame.now - epoch) / 1000, radianceOnly ? 1 : 0], 4)
      scheduleHdr(canvas, device, (encoder) => {
        if (disposed) return
        device.queue.writeBuffer(uniform, 0, values)
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
        pass.draw(6, count * 3)
        pass.end()
        hdrMetrics.passes++
        hdrMetrics.bandDraws++
      })
    },
    dispose() {
      disposed = true
      cancelHdr(canvas)
      buffer?.destroy()
      uniform.destroy()
      context.unconfigure()
    }
  }
}
