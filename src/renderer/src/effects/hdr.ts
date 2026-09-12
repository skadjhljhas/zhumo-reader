/// <reference types="@webgpu/types" />
import { computed, reactive, watch } from 'vue'
import { settings } from '../composables/useSettings'
import { studio } from '../composables/useStudio'
import { createFrameBatch } from './frame-batch'
import { clipHdrDamage, unionHdrDamage, type HdrDamage } from './hdr-damage'

const media = matchMedia('(dynamic-range: high)')
export const hdrState = reactive({
  display: media.matches,
  engine: 'idle' as 'idle' | 'checking' | 'ready' | 'unavailable',
  error: ''
})
media.addEventListener('change', () => {
  hdrState.display = media.matches
})
export const hdrEnabled = computed(
  () =>
    settings.lightRange === 'hdr' &&
    studio.themeId === 'lucent' &&
    studio.effectsMode !== 'off' &&
    hdrState.display &&
    hdrState.engine === 'ready'
)
export const nativeInkEnabled = computed(
  () => hdrState.engine === 'ready' && studio.effectsMode !== 'off'
)
export const hdrDescription = computed(() => {
  if (settings.lightRange !== 'hdr') return 'SDR · 日常阅读'
  if (studio.themeId !== 'lucent') return 'HDR 已为琉璃记住；切换到琉璃后应用。'
  if (studio.effectsMode === 'off') return '光效已关闭；开启后应用 HDR 选择。'
  if (hdrState.engine === 'unavailable') return '当前图形环境无法输出 HDR，正在使用 SDR。'
  if (!hdrState.display)
    return 'HDR 已选择；当前系统显示通道仍为 SDR。请在 Windows 显示设置中启用 HDR。'
  if (hdrState.engine !== 'ready') return '正在准备 HDR 光场…'
  return 'HDR · 背景、文本荧光与注释引线使用扩展亮度'
})

const shader = /* wgsl */ `
@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<uniform> options: vec4f;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  var points = array<vec2f, 3>(vec2f(-1.,-1.), vec2f(3.,-1.), vec2f(-1.,3.));
  let p = points[index]; return Vertex(vec4f(p,0.,1.), vec2f(p.x*.5+.5, .5-p.y*.5));
}
fn linear(c:vec3f) -> vec3f { return select(c/12.92, pow((c+.055)/1.055,vec3f(2.4)), c>vec3f(.04045)); }
fn encoded(c:vec3f) -> vec3f { return select(c*12.92, 1.055*pow(max(c,vec3f(0.)),vec3f(1./2.4))-.055, c>vec3f(.0031308)); }
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  let sample = textureSample(picture,filtering,input.uv);
  if (sample.a == 0.) { discard; }
  let energy = sample.rgb;
  // Field: keep the paper and shadows at their original exposure. Only light crests expand.
  let crest = smoothstep(.76,.98,dot(energy,vec3f(.2126,.7152,.0722)));
  let gain = select(7., 1.+3.5*crest*crest, options.x>.5);
  let alpha = sample.a;
  return vec4f(encoded(energy*gain)*alpha,alpha);
}`
let ready:
  Promise<{ device: GPUDevice; pipeline: GPURenderPipeline; sampler: GPUSampler }> | undefined
/** One submission per display frame, shared by all visible HDR surfaces. */
export const hdrMetrics = {
  submissions: 0,
  passes: 0,
  sourceCopies: 0,
  copiedPixels: 0,
  bandDraws: 0,
  fieldDraws: 0
}
export const hdrTelemetry = reactive({
  fps: 0,
  frameMs: 0,
  p95Ms: 0,
  displayHz: 0,
  gpu: '',
  gpuQueueWaitMs: 0
})
const intervals: number[] = []
let previousPresent = 0,
  previousAudit = 0,
  previousGpuAudit = 0
function recordFrame(now: number): void {
  if (previousPresent && now - previousPresent < 1000) {
    intervals.push(now - previousPresent)
    if (intervals.length > 240) intervals.shift()
  }
  previousPresent = now
  if (now - previousAudit < 500 || !intervals.length) return
  previousAudit = now
  const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length
  const ordered = [...intervals].sort((a, b) => a - b)
  hdrTelemetry.fps = 1000 / average
  hdrTelemetry.frameMs = average
  hdrTelemetry.p95Ms = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))]
  Object.assign(document.documentElement.dataset, {
    hdrFps: hdrTelemetry.fps.toFixed(1),
    hdrP95Ms: hdrTelemetry.p95Ms.toFixed(2),
    hdrSubmissions: String(hdrMetrics.submissions),
    hdrSourceCopies: String(hdrMetrics.sourceCopies),
    hdrCopiedPixels: String(hdrMetrics.copiedPixels),
    hdrBandDraws: String(hdrMetrics.bandDraws),
    hdrFieldDraws: String(hdrMetrics.fieldDraws),
    hdrGpu: hdrTelemetry.gpu,
    hdrGpuQueueWaitMs: hdrTelemetry.gpuQueueWaitMs.toFixed(2)
  })
}
const hdrBatch = createFrameBatch<
  object,
  { device: GPUDevice; encode: (encoder: GPUCommandEncoder) => void }
>((jobs, now) => {
  if (document.hidden) return
  recordFrame(now)
  const encoders = new Map<GPUDevice, GPUCommandEncoder>()
  try {
    for (const job of jobs) {
      let encoder = encoders.get(job.device)
      if (!encoder) {
        encoder = job.device.createCommandEncoder()
        encoders.set(job.device, encoder)
      }
      job.encode(encoder)
    }
    for (const [device, encoder] of encoders) {
      device.queue.submit([encoder.finish()])
      hdrMetrics.submissions++
      if (now - previousGpuAudit > 500) {
        previousGpuAudit = now
        const since = performance.now()
        void device.queue
          .onSubmittedWorkDone()
          .then(() => {
            hdrTelemetry.gpuQueueWaitMs = performance.now() - since
          })
          .catch(() => undefined)
      }
    }
  } catch (error) {
    hdrState.engine = 'unavailable'
    hdrState.error = String(error)
  }
})
export function scheduleHdr(
  owner: object,
  device: GPUDevice,
  encode: (encoder: GPUCommandEncoder) => void
): void {
  hdrBatch.put(owner, { device, encode })
}
export function cancelHdr(owner: object): void {
  hdrBatch.cancel(owner)
}
const sourceListeners = new WeakMap<HTMLCanvasElement, Set<(damage?: HdrDamage) => void>>()
export function markHdrSourceDirty(source?: HTMLCanvasElement, damage?: HdrDamage): void {
  if (source) sourceListeners.get(source)?.forEach((listener) => listener(damage))
}
export function watchHdrSource(
  source: HTMLCanvasElement,
  listener: (damage?: HdrDamage) => void
): () => void {
  let listeners = sourceListeners.get(source)
  if (!listeners) {
    listeners = new Set()
    sourceListeners.set(source, listeners)
  }
  listeners.add(listener)
  return () => listeners?.delete(listener)
}
export function prepareHdr(): NonNullable<typeof ready> {
  if (ready) return ready
  hdrState.engine = 'checking'
  ready = (async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('WebGPU 不可用')
    hdrTelemetry.gpu = adapter.info?.description || adapter.info?.vendor || 'WebGPU'
    void window.api
      ?.getDisplayInfo?.()
      .then((display) => {
        hdrTelemetry.displayHz = display.refreshRate
      })
      .catch(() => undefined)
    const device = await adapter.requestDevice()
    const module = device.createShaderModule({ code: shader })
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    })
    const probe = document.createElement('canvas').getContext('webgpu')
    if (!probe) throw new Error('HDR 画布不可用')
    device.pushErrorScope('validation')
    probe.configure({
      device,
      format: 'rgba16float',
      alphaMode: 'premultiplied',
      toneMapping: { mode: 'extended' }
    })
    const accepted = probe.getConfiguration()?.toneMapping?.mode === 'extended'
    const error = await device.popErrorScope()
    probe.unconfigure()
    if (!accepted || error) throw new Error(error?.message ?? '扩展亮度不可用')
    device.lost.then(() => {
      hdrState.engine = 'unavailable'
      hdrState.error = '图形设备已断开'
      ready = undefined
    })
    device.addEventListener('uncapturederror', (event) => {
      event.preventDefault()
      console.warn('[zhumo] HDR 输出已回退：', event.error.message)
      hdrState.engine = 'unavailable'
      hdrState.error = event.error.message
    })
    hdrState.engine = 'ready'
    return {
      device,
      pipeline,
      sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
    }
  })()
  ready.catch((error) => {
    hdrState.engine = 'unavailable'
    hdrState.error = String(error)
    ready = undefined
  })
  return ready
}
watch(
  () => settings.lightRange,
  (value) => {
    if (value === 'hdr') void prepareHdr().catch(() => undefined)
  },
  { immediate: true }
)
watch(
  hdrEnabled,
  (enabled) => {
    document.documentElement.dataset.lightRange = enabled ? 'hdr' : 'sdr'
  },
  { immediate: true }
)

/** One shared GPU pipeline, independent native scroll surfaces, premultiplied HDR output. */
export async function createHdrPresenter(
  canvas: HTMLCanvasElement,
  kind: 'field' | 'light'
): Promise<{ draw(source: HTMLCanvasElement, damage?: HdrDamage): void; dispose(): void }> {
  const { device, pipeline, sampler } = await prepareHdr()
  const context = canvas.getContext('webgpu')!
  context.configure({
    device,
    format: 'rgba16float',
    colorSpace: 'srgb',
    alphaMode: 'premultiplied',
    toneMapping: { mode: 'extended' },
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })
  canvas.dataset.hdrFormat = 'rgba16float'
  canvas.dataset.hdrToneMapping = 'extended'
  const uniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(uniform, 0, new Float32Array([kind === 'field' ? 1 : 0, 0, 0, 0]))
  let texture: GPUTexture | undefined,
    bind: GPUBindGroup,
    disposed = false
  let pendingDamage: HdrDamage | null | undefined
  return {
    draw(source, damage) {
      if (disposed || source.width < 1 || source.height < 1) return
      if (!texture || canvas.width !== source.width || canvas.height !== source.height) {
        pendingDamage = null
        texture?.destroy()
        canvas.width = source.width
        canvas.height = source.height
        texture = device.createTexture({
          size: [source.width, source.height],
          format: 'rgba8unorm-srgb',
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
            { binding: 2, resource: { buffer: uniform } }
          ]
        })
      }
      if (!damage) pendingDamage = null
      else if (pendingDamage !== null) pendingDamage = unionHdrDamage(pendingDamage, damage)
      scheduleHdr(canvas, device, (encoder) => {
        if (disposed || !texture) return
        const area = clipHdrDamage(pendingDamage, source.width, source.height)
        pendingDamage = undefined
        if (!area.width || !area.height) return
        device.queue.copyExternalImageToTexture(
          { source, origin: [area.x, area.y] },
          { texture, origin: [area.x, area.y], premultipliedAlpha: false, colorSpace: 'srgb' },
          [area.width, area.height]
        )
        hdrMetrics.sourceCopies++
        hdrMetrics.copiedPixels += area.width * area.height
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
        hdrMetrics.passes++
      })
    },
    dispose() {
      disposed = true
      cancelHdr(canvas)
      texture?.destroy()
      uniform.destroy()
      context.unconfigure()
    }
  }
}
