import fragment from './wave-memory.frag?raw'

const STEP = 1 / 60
export interface WaveMemory {
  advance(time: number, moving: boolean, pointer: [number, number], interaction: number): void
  readonly texture: WebGLTexture
  readonly size: [number, number]
  dispose(): void
}

/** A bounded, fixed-step height/velocity field; each frame carries real prior
 * state. The renderer can retain its analytic material if float targets fail.
 */
export function createWaveMemory(gl: WebGLRenderingContext): WaveMemory | undefined {
  if (!gl.getExtension('OES_texture_float')) return
  gl.getExtension('WEBGL_color_buffer_float')
  const shaders: WebGLShader[] = []
  const textures: WebGLTexture[] = []
  const targets: WebGLFramebuffer[] = []
  let program: WebGLProgram | null = null
  let size: [number, number] = [0, 0]
  let front = 0,
    accumulator = 0
  let lastTime: number | undefined
  let lastPointer: [number, number] | undefined
  let lastInteraction = 0
  function dispose(): void {
    for (const target of targets) gl.deleteFramebuffer(target)
    for (const texture of textures) gl.deleteTexture(texture)
    for (const shader of shaders) gl.deleteShader(shader)
    if (program) gl.deleteProgram(program)
  }
  try {
    program = gl.createProgram()
    if (!program) return
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        'attribute vec2 position;\nvoid main(){gl_Position=vec4(position,0.,1.);}'
      ],
      [gl.FRAGMENT_SHADER, fragment]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('No wave shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Wave shader failed')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Wave program failed')
    const uniforms = Object.fromEntries(
      ['previous', 'grid', 'stroke', 'force'].map((name) => [
        name,
        gl.getUniformLocation(program!, name)
      ])
    )
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture(),
        target = gl.createFramebuffer()
      if (!texture || !target) {
        if (texture) gl.deleteTexture(texture)
        if (target) gl.deleteFramebuffer(target)
        throw new Error('No wave target')
      }
      textures.push(texture)
      targets.push(target)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.FLOAT, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Float wave target unavailable')
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    function resize(): void {
      const width = Math.max(384, Math.min(896, Math.round(innerWidth / 16) * 8))
      const height = Math.max(192, Math.min(640, Math.round(innerHeight / 16) * 8))
      if (size[0] === width && size[1] === height) return
      size = [width, height]
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, textures[i])
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.FLOAT, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[i])
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      front = 0
      accumulator = 0
      lastPointer = undefined
      lastTime = undefined
      lastInteraction = 0
    }
    return {
      get texture() {
        return textures[front]
      },
      get size() {
        return size
      },
      advance(time, moving, pointer, interaction) {
        resize()
        if (!moving) {
          lastTime = undefined
          accumulator = 0
          lastPointer = undefined
          lastInteraction = 0
          return
        }
        if (interaction <= 0) {
          lastPointer = pointer
          lastInteraction = 0
        }
        const elapsed = lastTime === undefined ? 0 : Math.max(0, Math.min(0.08, time - lastTime))
        lastTime = time
        accumulator = Math.min(0.08, accumulator + elapsed)
        const steps = Math.min(4, Math.floor(accumulator / STEP))
        if (!steps) return
        accumulator -= steps * STEP
        const before = lastInteraction > 0 ? (lastPointer ?? pointer) : pointer
        const distance = Math.hypot(
          (pointer[0] - before[0]) * size[0],
          (pointer[1] - before[1]) * size[1]
        )
        const pressure = Math.min(1, distance / Math.max(1, steps) / 7) * interaction
        gl.useProgram(program)
        gl.uniform1i(uniforms.previous, 0)
        gl.uniform2f(uniforms.grid, size[0], size[1])
        gl.viewport(0, 0, size[0], size[1])
        gl.activeTexture(gl.TEXTURE0)
        for (let i = 0; i < steps; i++) {
          const a = i / steps,
            b = (i + 1) / steps
          gl.uniform4f(
            uniforms.stroke,
            before[0] + (pointer[0] - before[0]) * a,
            before[1] + (pointer[1] - before[1]) * a,
            before[0] + (pointer[0] - before[0]) * b,
            before[1] + (pointer[1] - before[1]) * b
          )
          gl.uniform1f(uniforms.force, pressure)
          gl.bindTexture(gl.TEXTURE_2D, textures[front])
          gl.bindFramebuffer(gl.FRAMEBUFFER, targets[1 - front])
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          front = 1 - front
        }
        lastPointer = [pointer[0], pointer[1]]
        lastInteraction = interaction
      },
      dispose
    }
  } catch (error) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    dispose()
    console.warn('[chaosheng] Retaining analytic water:', error)
    return
  }
}
