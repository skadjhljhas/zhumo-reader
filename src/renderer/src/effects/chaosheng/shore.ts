import fragment from './shore.frag?raw'
import caustic from './caustic.glsl?raw'
import ocean from './ocean.glsl?raw'
import { createWaveMemory, type WaveMemory } from './wave-memory'

export interface ShoreFrame {
  time: number
  progress: number
  depth: number
  pointer: [number, number]
  presence: number
  hero: [number, number, number, number]
  reader: [number, number, number, number]
  ripples: Float32Array
  scale: number
  moving: boolean
  contact: [number, number]
  interaction: number
  scrolling?: [number, number, number, number]
}
export interface Shore {
  draw(frame: ShoreFrame): void
  dispose(): void
}
export function createShore(canvas: HTMLCanvasElement): Shore | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  })
  if (!gl) return undefined
  const shaders: WebGLShader[] = []
  let memory: WaveMemory | undefined
  let emptyTexture: WebGLTexture | null = null
  let program: WebGLProgram | null = null,
    buffer: WebGLBuffer | null = null
  function releaseResources(): void {
    memory?.dispose()
    if (emptyTexture) gl!.deleteTexture(emptyTexture)
    if (buffer) gl!.deleteBuffer(buffer)
    if (program) gl!.deleteProgram(program)
    for (const shader of shaders) gl!.deleteShader(shader)
  }
  try {
    program = gl.createProgram()
    if (!program) return undefined
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        'attribute vec2 position;\nvoid main(){gl_Position=vec4(position,0.,1.);}'
      ],
      [
        gl.FRAGMENT_SHADER,
        fragment.replace('/* CAUSTIC_LIGHT */', caustic).replace('/* OCEAN */', ocean)
      ]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Cannot allocate a tide shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Tide shader failed')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Tide link failed')
    gl.useProgram(program)
    buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniforms = Object.fromEntries(
      [
        'resolution',
        'pointer',
        'hero',
        'reader',
        'ripples[0]',
        'time',
        'progress',
        'depth',
        'presence',
        'heightField',
        'fieldSize',
        'hasField',
        'navigationFlow'
      ].map((name) => [name, gl.getUniformLocation(program!, name)])
    )
    emptyTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, emptyTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    memory = createWaveMemory(gl)
    canvas.dataset.solver = memory ? 'float-wave' : 'analytic'
    return {
      draw(frame) {
        const width = Math.round(innerWidth * frame.scale),
          height = Math.round(innerHeight * frame.scale)
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        memory?.advance(
          frame.time,
          frame.moving,
          [frame.contact[0], 1 - frame.contact[1]],
          frame.interaction
        )
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.useProgram(program)
        gl.viewport(0, 0, width, height)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, memory?.texture ?? emptyTexture)
        gl.uniform1i(uniforms.heightField, 0)
        gl.uniform2f(uniforms.fieldSize, memory?.size[0] || 1, memory?.size[1] || 1)
        gl.uniform1f(uniforms.hasField, memory ? 1 : 0)
        gl.uniform2f(uniforms.resolution, width, height)
        gl.uniform2f(uniforms.pointer, frame.pointer[0], 1 - frame.pointer[1])
        gl.uniform4f(
          uniforms.hero,
          frame.hero[0] * frame.scale,
          (innerHeight - frame.hero[1]) * frame.scale,
          frame.hero[2] * frame.scale,
          frame.hero[3]
        )
        gl.uniform4f(
          uniforms.reader,
          frame.reader[0],
          1 - frame.reader[1],
          frame.reader[2],
          frame.reader[3]
        )
        gl.uniform4fv(uniforms['ripples[0]'], frame.ripples)
        gl.uniform1f(uniforms.time, frame.time)
        gl.uniform1f(uniforms.progress, frame.progress)
        gl.uniform1f(uniforms.depth, frame.depth)
        gl.uniform1f(uniforms.presence, frame.presence)
        gl.uniform4fv(uniforms.navigationFlow, frame.scrolling ?? [0, 0, 0, 0.5])
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose() {
        releaseResources()
        if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }
  } catch (error) {
    releaseResources()
    console.warn('[chaosheng] Using the static shore material:', error)
    return undefined
  }
}
