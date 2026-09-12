import fragment from './field.glsl?raw'
import lucentMotion from './lucent.glsl?raw'
import tidalMotion from './tidal.glsl?raw'
import ocean from '../chaosheng/ocean.glsl?raw'
import type { ManuscriptProfile } from './profile'
import { seasonLight } from './season'
import { ProfileTransition } from './profile-transition'

export interface ManuscriptLightRenderer {
  draw(
    time: number,
    theme: number,
    profile: ManuscriptProfile,
    seed: number[],
    date: Date,
    options?: { smoothChanges?: boolean }
  ): void
  dispose(): void
}
export function createManuscriptLight(
  canvas: HTMLCanvasElement
): ManuscriptLightRenderer | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    preserveDrawingBuffer: true
  })
  if (!gl) return
  const derivatives = gl.getExtension('OES_standard_derivatives')
  const fragmentSource =
    (derivatives
      ? '#extension GL_OES_standard_derivatives : enable\n#define FOLIO_DERIVATIVES\n'
      : '') +
    fragment
      .replace('/* LUCENT_MOTION */', lucentMotion)
      .replace('/* TIDAL_MOTION */', ocean + '\n' + tidalMotion)
  canvas.dataset.motion = 'light-and-water-v2'
  canvas.dataset.filter = derivatives ? 'pixel-footprint' : 'pixel-width'
  const program = gl.createProgram(),
    buffer = gl.createBuffer(),
    shaders: WebGLShader[] = []
  const releaseResources = (): void => {
    shaders.forEach((shader) => gl.deleteShader(shader))
    gl.deleteProgram(program)
    gl.deleteBuffer(buffer)
  }
  try {
    if (!program || !buffer) throw new Error('Light allocation failed')
    for (const [type, source] of [
      [gl.VERTEX_SHADER, 'attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}'],
      [gl.FRAGMENT_SHADER, fragmentSource]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Light shader allocation failed')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Light compilation failed')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'p')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Light link failed')
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const uniforms = Object.fromEntries(
      [
        'resolution',
        'time',
        'theme',
        'structure',
        'detail',
        'encounter',
        'season',
        'spectrum[0]'
      ].map((name) => [name, gl.getUniformLocation(program, name)])
    )
    const transition = new ProfileTransition()
    const structure = transition.values.subarray(0, 4),
      detail = transition.values.subarray(4, 8),
      spectrum = transition.values.subarray(8)
    return {
      draw(time, theme, profile, seed, date, options) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
        gl.uniform1f(uniforms.time, time)
        gl.uniform1f(uniforms.theme, theme)
        if (transition.update(profile, time, options?.smoothChanges ?? false)) {
          gl.uniform4fv(uniforms.structure, structure)
          gl.uniform4fv(uniforms.detail, detail)
          gl.uniform2fv(uniforms['spectrum[0]'], spectrum)
        }
        gl.uniform4fv(uniforms.encounter, seed)
        gl.uniform4fv(uniforms.season, seasonLight(date))
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose() {
        releaseResources()
        if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }
  } catch (error) {
    releaseResources()
    console.warn('[zhumo] Manuscript light unavailable:', error)
    return undefined
  }
}
