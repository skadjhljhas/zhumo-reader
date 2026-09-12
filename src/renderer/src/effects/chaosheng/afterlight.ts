import fragment from './afterlight.frag?raw'
import caustic from './caustic.glsl?raw'
import ocean from './ocean.glsl?raw'

export interface AfterlightFrame {
  width: number
  height: number
  time: number
  chosen: number
  density: number
  pointer: [number, number]
}
export interface Afterlight {
  draw(frame: AfterlightFrame): void
  dispose(): void
}
export function createAfterlight(canvas: HTMLCanvasElement): Afterlight | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  })
  if (!gl) return
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  function dispose(): void {
    if (program) gl!.deleteProgram(program)
    if (buffer) gl!.deleteBuffer(buffer)
    for (const shader of shaders) gl!.deleteShader(shader)
  }
  try {
    program = gl.createProgram()
    if (!program) return
    for (const [type, source] of [
      [gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}'],
      [gl.FRAGMENT_SHADER, fragment.replace('/* CAUSTIC_LIGHT */', ocean + '\n' + caustic)]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw Error('Cannot allocate afterlight shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader) ?? 'Afterlight shader failed')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'position')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program) ?? 'Afterlight link failed')
    buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.useProgram(program)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const uniforms = Object.fromEntries(
      ['resolution', 'time', 'chosen', 'density', 'pointer'].map((name) => [
        name,
        gl.getUniformLocation(program!, name)
      ])
    )
    return {
      draw(frame) {
        const scale = Math.min(devicePixelRatio || 1, 2, 1600 / Math.max(frame.width, 1))
        const width = Math.max(1, Math.round(frame.width * scale))
        const height = Math.max(1, Math.round(frame.height * scale))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        gl.viewport(0, 0, width, height)
        gl.useProgram(program)
        gl.uniform2f(uniforms.resolution, width, height)
        gl.uniform1f(uniforms.time, frame.time)
        gl.uniform1f(uniforms.chosen, frame.chosen)
        gl.uniform1f(uniforms.density, frame.density)
        gl.uniform2f(uniforms.pointer, ...frame.pointer)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose
    }
  } catch {
    dispose()
    return
  }
}
