import lucentLight from './lucent/light.glsl?raw'
import { lucentNoiseValues, LUCENT_NOISE_SIZE } from './lucent/noise-texture'

/** A procedural optical field; all imagery is generated locally by the GPU. */
const vertex = `attribute vec2 position;
void main(){gl_Position=vec4(position,0.,1.);}`
const fragment = `precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform float time;
uniform float theme;
uniform float progress;
uniform vec4 climate;
uniform vec4 readingState;
uniform vec4 attention;
uniform vec4 structure;
uniform vec4 navigationFlow;
uniform vec4 topology;
uniform vec4 encounterSeed;
uniform vec4 readingHabits;
uniform vec4 navigationMemory;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float f=0.,a=.5;for(int i=0;i<4;i++){f+=a*noise(p);p=mat2(1.6,1.2,-1.2,1.6)*p+3.7;a*=.5;}return f;}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
vec3 spectral(float t){return .55+.45*cos(6.28318*(t+vec3(.0,.33,.67)));}
/* LUCENT_LIGHT */
vec3 starLayer(vec2 p,float density,float depth){
 p*=density;p+=(pointer-.5)*depth+vec2(time*.0015,progress*.25)*depth;
 vec2 cell=floor(p),f=fract(p)-.5;float h=hash(cell);vec2 off=vec2(h,hash(cell+13.))-0.5;vec2 d=f-off*.66;
 float r=length(d);float star=.0018/(r*r+.0005);star*=step(.974,h);
 float shimmer=.58+.42*sin(time*(.3+h)+h*70.);
 vec3 tint=mix(vec3(.46,.64,1.),vec3(1.,.78,.51),hash(cell+31.));
 float rays=max(0.,1.-abs(d.x*d.y)*2400.)*max(0.,.16-r)*step(.994,h)*1.6;
 return tint*(star*.22*shimmer+rays);
}
vec3 cosmos(vec2 uv){
 vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.);vec2 drift=(pointer-.5)*.03;
 vec2 q=rot(-.5)*(p+drift);float mist=fbm(q*3.+vec2(time*.007,progress*.3));
 float veil=exp(-pow(q.y+.16*sin(q.x*2.+time*.015),2.)*11.)*mist;
 vec3 col=vec3(.013,.02,.049)+veil*mix(vec3(.20,.035,.31),vec3(.026,.19,.25),smoothstep(-.5,.8,q.x));
 col+=pow(mist,5.)*.13*vec3(.22,.35,.75);
 float river=exp(-abs(q.y+.08*sin(q.x*3.))*10.)*pow(fbm(q*25.),3.)*.3;
 col+=river*vec3(.34,.31,.45);
 col+=starLayer(p,76.,1.)+starLayer(p+1.3,38.,2.1)+starLayer(p-.7,17.,3.4);
 vec2 center=vec2(.36,.17);vec2 a=p-center; a=rot(-.29)*a;float ring=length(a*vec2(.85,3.5));
 float corona=exp(-abs(ring-.27)*70.)+exp(-abs(ring-.27)*15.)*.18;
 col+=corona*vec3(.18,.31,.39);
 float lens=exp(-length(p-center)*4.7);col+=lens*vec3(.005,.007,.019);
 float grain=hash(gl_FragCoord.xy+fract(time)*.001)-.5;
 return col+grain*.006;
}
void main(){vec2 uv=gl_FragCoord.xy/resolution;vec3 col=theme<.5?glass(uv):cosmos(uv);gl_FragColor=vec4(clamp(col,0.,1.),1.);}`

export interface Atmosphere {
  render(
    time: number,
    theme: number,
    x: number,
    y: number,
    progress: number,
    scale: number,
    field?: Float32Array,
    scrolling?: [number, number, number, number],
    sky?: Float32Array
  ): void
  dispose(): void
}
export function createAtmosphere(canvas: HTMLCanvasElement): Atmosphere | undefined {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  })
  if (!gl) return undefined
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null,
    buffer: WebGLBuffer | null = null,
    noiseTexture: WebGLTexture | null = null
  const releaseResources = (): void => {
    if (buffer) gl.deleteBuffer(buffer)
    if (noiseTexture) gl.deleteTexture(noiseTexture)
    if (program) gl.deleteProgram(program)
    shaders.forEach((shader) => gl.deleteShader(shader))
  }
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Optical shader allocation failed')
    shaders.push(shader)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? 'Optical field compilation failed')
    return shader
  }
  try {
    program = gl.createProgram()
    if (!program) throw new Error('Optical program allocation failed')
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(
      program,
      compile(gl.FRAGMENT_SHADER, fragment.replace('/* LUCENT_LIGHT */', lucentLight))
    )
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Optical field link failed')
    gl.useProgram(program)
    buffer = gl.createBuffer()
    if (!buffer) throw new Error('Optical buffer allocation failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    noiseTexture = gl.createTexture()
    if (!noiseTexture) throw Error('Optical lattice allocation failed')
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      LUCENT_NOISE_SIZE,
      LUCENT_NOISE_SIZE,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      lucentNoiseValues()
    )
    gl.uniform1i(gl.getUniformLocation(program, 'lucentNoiseMap'), 0)
    const uniforms = Object.fromEntries(
      [
        'resolution',
        'pointer',
        'time',
        'theme',
        'progress',
        'climate',
        'readingState',
        'attention',
        'structure',
        'navigationFlow',
        'topology',
        'encounterSeed',
        'readingHabits',
        'navigationMemory',
        'skylightSource',
        'skylightOptics'
      ].map((name) => [name, gl.getUniformLocation(program!, name)])
    )
    return {
      render(time, theme, x, y, progress, scale, field, scrolling, sky) {
        if (gl.isContextLost()) return
        gl.useProgram(program)
        const width = Math.round(innerWidth * scale),
          height = Math.round(innerHeight * scale)
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
          gl.viewport(0, 0, width, height)
        }
        gl.uniform2f(uniforms.resolution, width, height)
        gl.uniform2f(uniforms.pointer, x, 1 - y)
        gl.uniform1f(uniforms.time, time)
        gl.uniform1f(uniforms.theme, theme)
        gl.uniform1f(uniforms.progress, progress)
        gl.uniform4fv(uniforms.navigationFlow, scrolling ?? [0, 0, 0, 0.5])
        gl.uniform4fv(uniforms.skylightSource, sky?.subarray(0, 4) ?? [1.18, -0.25, 0.5, 0.5])
        gl.uniform4fv(uniforms.skylightOptics, sky?.subarray(4, 8) ?? [0, 0.5, 0.94, 0.7])
        if (field) {
          gl.uniform4fv(uniforms.climate, field.subarray(0, 4))
          gl.uniform4fv(uniforms.readingState, field.subarray(4, 8))
          gl.uniform4fv(uniforms.attention, field.subarray(8, 12))
          gl.uniform4fv(uniforms.structure, field.subarray(12, 16))
          if (field.length >= 32) {
            gl.uniform4fv(uniforms.topology, field.subarray(16, 20))
            gl.uniform4fv(uniforms.encounterSeed, field.subarray(20, 24))
            gl.uniform4fv(uniforms.readingHabits, field.subarray(24, 28))
            gl.uniform4fv(uniforms.navigationMemory, field.subarray(28, 32))
          }
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      },
      dispose() {
        releaseResources()
        if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }
  } catch (error) {
    console.warn('[zhumo] 光影采用静态材质：', error)
    releaseResources()
    return undefined
  }
}
