import lucentSource from './lucent-echo.frag?raw'
import tideSource from './tide-echo.frag?raw'
import common from './echo-common.glsl?raw'
import { ECHO_STAR_TEXELS } from '../echo-constellation'
import type { EchoTheme } from './echo-palette'

export interface EchoFieldFrame {
  width: number
  height: number
  time: number
  /** Stars actually drawn (a visual summary; the archive is never cropped). */
  count: number
  /** Rows in the packed texture, at least 1. */
  rows: number
  data: Uint8Array
  /** Sixteen smoothed channels, see EchoFieldDynamics. */
  dynamics: ArrayLike<number>
  /** Four per-opening random seeds. */
  seed: ArrayLike<number>
  /** selected index, hovered index (-1 none), compact 0/1, manuscript volume 0..1. */
  focus: [number, number, number, number]
  /** Fraction of manuscript text in annotations, independent of the recorded echo count. */
  annotation?: number
  scale?: number
}
export interface EchoField {
  draw(frame: EchoFieldFrame): void
  dispose(): void
}
const UNIFORMS = [
  'resolution',
  'time',
  'count',
  'rows',
  'stars',
  'habits',
  'flow',
  'climate',
  'seed',
  'live',
  'focus',
  'annotation'
] as const

/** The echo field: one full-screen triangle, all light summed per pixel in the fragment shader. */
export function createEchoField(
  canvas: HTMLCanvasElement,
  theme: EchoTheme
): EchoField | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power'
  })
  if (!gl) return
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  let texture: WebGLTexture | null = null
  function dispose(): void {
    if (program) gl!.deleteProgram(program)
    if (buffer) gl!.deleteBuffer(buffer)
    if (texture) gl!.deleteTexture(texture)
    for (const shader of shaders) gl!.deleteShader(shader)
  }
  try {
    program = gl.createProgram()
    if (!program) return
    const fragment = (theme === 'chaosheng' ? tideSource : lucentSource).replace(
      '/* ECHO_COMMON */',
      common
    )
    for (const [type, source] of [
      [gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}'],
      [gl.FRAGMENT_SHADER, fragment]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw Error('Cannot allocate echo shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader) ?? 'Echo shader failed')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program) ?? 'Echo link failed')
    buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.useProgram(program)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    const uniforms = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(program!, name)])
    ) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
    return {
      draw(frame) {
        const scale = Math.min(
          frame.scale ?? devicePixelRatio ?? 1,
          2,
          1400 / Math.max(frame.width, 1)
        )
        const width = Math.max(1, Math.round(frame.width * scale))
        const height = Math.max(1, Math.round(frame.height * scale))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const rows = Math.max(1, frame.rows)
        gl.viewport(0, 0, width, height)
        gl.useProgram(program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          ECHO_STAR_TEXELS,
          rows,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          frame.data.subarray(0, rows * ECHO_STAR_TEXELS * 4)
        )
        const d = frame.dynamics
        gl.uniform2f(uniforms.resolution, width, height)
        gl.uniform1f(uniforms.time, frame.time)
        gl.uniform1f(uniforms.count, frame.count)
        gl.uniform1f(uniforms.rows, rows)
        gl.uniform1i(uniforms.stars, 0)
        gl.uniform4f(uniforms.habits, d[0], d[1], d[2], d[3])
        gl.uniform4f(uniforms.flow, d[4], d[5], d[6], d[7])
        gl.uniform4f(uniforms.climate, d[8], d[9], d[10], d[11])
        gl.uniform4f(uniforms.live, d[12], d[13], d[14], d[15])
        gl.uniform4f(uniforms.seed, frame.seed[0], frame.seed[1], frame.seed[2], frame.seed[3])
        gl.uniform4f(uniforms.focus, ...frame.focus)
        gl.uniform1f(uniforms.annotation, Math.max(0, Math.min(1, frame.annotation ?? 0)))
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose
    }
  } catch (error) {
    dispose()
    console.warn('[zhumo] Echo field unavailable, keeping the still fallback:', error)
    return
  }
}

/** Still fallback without WebGL or with effects off: the same data as soft gradients, no motion. */
export function drawEchoFallback(
  context: CanvasRenderingContext2D,
  frame: EchoFieldFrame,
  theme: EchoTheme
): void {
  const { width, height } = frame
  context.clearRect(0, 0, width, height)
  const tide = theme === 'chaosheng'
  const read = (i: number, c: number): number => frame.data[i * ECHO_STAR_TEXELS * 4 + c] / 255
  const paint = (
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotate: number,
    rgb: string,
    alpha: number
  ): void => {
    context.save()
    context.translate(x, y)
    context.rotate(rotate)
    context.scale(rx, ry)
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1)
    gradient.addColorStop(0, rgb.replace('A', alpha.toFixed(3)))
    gradient.addColorStop(1, rgb.replace('A', '0'))
    context.fillStyle = gradient
    context.beginPath()
    context.arc(0, 0, 1, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }
  for (let i = 0; i < frame.count; i++) {
    const x = read(i, 0) * width,
      y = read(i, 1) * height,
      mag = read(i, 2),
      warmth = read(i, 3),
      age = read(i, 6),
      hour = read(i, 7)
    const day = 0.5 + 0.5 * Math.cos((hour - 0.5) * Math.PI * 2)
    const warm = Math.min(1, 0.55 * warmth + 0.45 * day)
    const rgb = tide
      ? `rgba(${Math.round(214 + 41 * warm)},${Math.round(232 - 2 * warm)},${Math.round(255 - 76 * warm)},A)`
      : `rgba(${Math.round(237 + 18 * warm)},${Math.round(245 - 3 * warm)},${Math.round(255 - 36 * warm)},A)`
    const gain = 1 + (i === frame.focus[0] ? 0.7 : 0) + (i === frame.focus[1] ? 0.4 : 0)
    const strength = (0.35 + 0.65 * mag) * (1 - 0.4 * age) * gain
    if (tide)
      paint(
        x,
        y + height * (0.05 + 0.15 * mag),
        width * 0.03,
        height * (0.08 + 0.2 * mag),
        0,
        rgb,
        0.55 * strength
      )
    else paint(x, y, width * (0.05 + 0.08 * mag), height * 0.035, -0.6, rgb, 0.5 * strength)
  }
  const live = frame.dynamics
  if (live[14] > 0.001) {
    const rgb = tide ? 'rgba(236,240,240,A)' : 'rgba(250,247,238,A)'
    paint(live[12] * width, live[13] * height, width * 0.04, height * 0.12, 0, rgb, 0.5 * live[14])
  }
}
