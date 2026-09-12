/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { chromium } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Compile both echo-field shaders in a hidden headless browser and render sample states
 * to work/echo-field/*.png. This checks GLSL compilation and the look of the field without
 * launching Electron. Star positions here mirror echo-constellation.ts for preview only.
 */
const dir = resolve('src/renderer/src/effects/echo')
const common = await readFile(resolve(dir, 'echo-common.glsl'), 'utf8')
const shaders = {
  lucent: (await readFile(resolve(dir, 'lucent-echo.frag'), 'utf8')).replace(
    '/* ECHO_COMMON */',
    common
  ),
  chaosheng: (await readFile(resolve(dir, 'tide-echo.frag'), 'utf8')).replace(
    '/* ECHO_COMMON */',
    common
  )
}
const hash = (text) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}
const unit = (n) => Math.max(0, Math.min(1, n))
function layout(count, tide, volume = 0.4) {
  const stars = []
  for (let i = 0; i < count; i++) {
    const key = 'stop-' + i,
      h = hash(key),
      j = hash(key + 'orbit'),
      k = hash(key + 'phase')
    const u = (i + 0.5) / count
    const kind = i % 5 === 3 ? 1 : 0
    let x, y, depth
    if (tide) {
      depth = kind ? 0.8 + 0.2 * j : j * 0.75
      x = unit(0.07 + 0.86 * u + (h - 0.5) * 0.05)
      y = unit(0.22 + 0.1 * volume + 0.03 + (1 - depth) * 0.3)
    } else {
      const spread = 0.26 + 0.12 * volume,
        bow = 4 * u * (1 - u),
        along = (j - 0.5) * spread + kind * 0.12
      x = unit(0.16 + 0.68 * u - along * 0.55 + (h - 0.5) * 0.03)
      y = unit(0.3 + 0.4 * u - 0.09 * bow + along * 0.78)
      depth = unit(0.35 + along * 1.4 + kind * 0.2)
    }
    const peak = 0.2 + 0.8 * hash(key + 'dwell') ** 2
    const visitsRaw = 1 + Math.floor(hash(key + 'visits') * 4)
    const visits = Math.log1p(visitsRaw) / (Math.log1p(visitsRaw) + 2)
    stars.push([
      x,
      y,
      0.3 + 0.7 * peak,
      unit(0.6 * peak + 0.3 * visits + 0.05),
      k,
      depth,
      hash(key + 'age') * 0.8,
      (6 + 16 * hash(key + 'hour')) / 24,
      Math.log1p(peak * 3) / (Math.log1p(peak * 3) + 1),
      0.3 + 0.6 * hash(key + 'share'),
      visits,
      kind
    ])
  }
  return stars
}
const states = [
  { name: 'empty', count: 0 },
  { name: 'few', count: 3 },
  { name: 'many', count: 40 }
]
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
})
await mkdir('work/echo-field', { recursive: true })
const report = []
try {
  const page = await browser.newPage({
    viewport: { width: 420, height: 330 },
    deviceScaleFactor: 1
  })
  await page.setContent('<canvas id="c" width="420" height="330" style="display:block"></canvas>')
  for (const [theme, fragment] of Object.entries(shaders)) {
    for (const state of states) {
      for (const [label, live] of [
        ['', [0, 0, 0, 0]],
        ['-live', [0.62, theme === 'chaosheng' ? 0.42 : 0.46, 0.7, 0.33]]
      ]) {
        if (label && state.name !== 'few') continue
        const stars = layout(state.count, theme === 'chaosheng')
        const result = await page.evaluate(
          ({ fragment, stars, live, theme, time }) => {
            const canvas = document.getElementById('c')
            const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true })
            if (!gl) return { error: 'no webgl' }
            const program = gl.createProgram()
            const build = (type, source) => {
              const shader = gl.createShader(type)
              gl.shaderSource(shader, source)
              gl.compileShader(shader)
              if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw Error(gl.getShaderInfoLog(shader))
              gl.attachShader(program, shader)
            }
            try {
              build(
                gl.VERTEX_SHADER,
                'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}'
              )
              build(gl.FRAGMENT_SHADER, fragment)
            } catch (error) {
              return { error: String(error) }
            }
            gl.bindAttribLocation(program, 0, 'position')
            gl.linkProgram(program)
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
              return { error: gl.getProgramInfoLog(program) }
            const buffer = gl.createBuffer()
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
            gl.useProgram(program)
            gl.enableVertexAttribArray(0)
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
            const rows = Math.max(1, stars.length)
            const data = new Uint8Array(rows * 12)
            stars.forEach((s, i) => s.forEach((v, c) => (data[i * 12 + c] = Math.round(v * 255))))
            const texture = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 3, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
            const u = (name) => gl.getUniformLocation(program, name)
            gl.enable(gl.BLEND)
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            gl.viewport(0, 0, canvas.width, canvas.height)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.uniform2f(u('resolution'), canvas.width, canvas.height)
            gl.uniform1f(u('time'), time)
            gl.uniform1f(u('count'), stars.length)
            gl.uniform1f(u('rows'), rows)
            gl.uniform1i(u('stars'), 0)
            gl.uniform4f(u('habits'), 0.62, 0.3, 0.2, 0.5)
            gl.uniform4f(u('flow'), 0.2, 0.35, 0.3, 0.62)
            gl.uniform4f(u('climate'), 0.3, -0.9, 0.7, -0.7)
            gl.uniform4f(u('seed'), 0.13, 0.57, 0.81, 0.29)
            gl.uniform4f(u('live'), ...live)
            gl.uniform4f(u('focus'), stars.length > 2 ? 1 : -1, -1, 0, 0.4)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            const pixels = new Uint8Array(4)
            gl.readPixels(210, 165, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            canvas.style.background = theme === 'chaosheng' ? '#142c48' : '#dce6ef'
            return { centre: [...pixels], error: null }
          },
          { fragment, stars, live, theme, time: 37.5 }
        )
        report.push({ theme, state: state.name + label, ...result })
        if (result.error) continue
        await page.screenshot({ path: `work/echo-field/${theme}-${state.name}${label}.png` })
      }
    }
  }
} finally {
  await browser.close()
}
await writeFile('work/echo-field/report.json', JSON.stringify(report, null, 2))
for (const item of report)
  console.log(item.theme, item.state, item.error ?? 'ok centre=' + item.centre.join(','))
if (report.some((item) => item.error)) process.exitCode = 1
