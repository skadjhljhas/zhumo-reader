import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './runtime'

test('glyph masks respect nested clipping and measure justified Chinese at native positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-mask-layout-'))
  const code = await build({
    stdin: {
      contents:
        "export * from './src/renderer/src/effects/lucent/glyph-mask';export * from './src/renderer/src/effects/lucent/glyph-fonts';",
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'MaskFixture'
  })
  const app = await electron.launch({
    executablePath: process.env.ZHUMO_E2E_EXE,
    args: process.env.ZHUMO_E2E_EXE ? [] : [resolve('out/main/index.js')],
    env: { ...process.env, ZHUMO_USER_DATA: join(root, 'profile') }
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(code.outputFiles[0].text + ';window.MaskFixture=MaskFixture;')
    const result = await page.evaluate(() => {
      const api = (
        window as unknown as {
          MaskFixture: typeof import('../../src/renderer/src/effects/lucent/glyph-mask')
        }
      ).MaskFixture
      const port = document.createElement('div')
      port.style.cssText =
        'position:fixed;left:150px;top:100px;width:450px;height:260px;overflow:auto;background:white;z-index:99999'
      port.innerHTML =
        '<div class="section-body" style="width:440px;max-width:none;font:24px Arial;text-indent:0;margin:0"><div id="crop" style="width:120px;height:64px;overflow:hidden"><span data-source-inline="0" style="white-space:nowrap">Readable light outside the nested viewport must not be painted.</span></div></div>'
      document.body.append(port)
      const mask = api.captureGlyphMask(port),
        ctx = mask.canvas.getContext('2d')!
      const bytes = ctx.getImageData(0, 0, mask.canvas.width, mask.canvas.height).data
      let inside = 0,
        outside = 0
      for (let y = 0; y < mask.canvas.height; y++)
        for (let x = 0; x < mask.canvas.width; x++) {
          const a = bytes[(y * mask.canvas.width + x) * 4 + 3]
          if (x / mask.scale > 121) outside += a
          else inside += a
        }
      const body = port.firstElementChild as HTMLElement
      body.innerHTML =
        '<p style="margin:0;width:320px;font:24px Noto Serif SC;text-indent:0;line-height:40px;text-align:justify;text-align-last:justify"><span data-source-inline="1">文字水光相遇</span></p>'
      const justified = api.captureGlyphMask(port)
      const pixels = justified.canvas
        .getContext('2d')!
        .getImageData(0, 0, justified.canvas.width, justified.canvas.height).data
      const node = body.querySelector('span')!.firstChild!,
        range = document.createRange(),
        bounds = port.getBoundingClientRect()
      const glyphInk: number[] = []
      for (let i = 0; i < node.textContent!.length; i++) {
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const r = range.getBoundingClientRect()
        let alpha = 0
        const left = Math.floor((r.left - bounds.left) * justified.scale),
          top = Math.floor((r.top - justified.top) * justified.scale)
        const right = Math.ceil((r.right - bounds.left) * justified.scale),
          bottom = Math.ceil((r.bottom - justified.top) * justified.scale)
        for (let y = top; y < bottom; y++)
          for (let x = left; x < right; x++)
            if (x >= 0 && y >= 0 && x < justified.canvas.width && y < justified.canvas.height)
              alpha += pixels[(y * justified.canvas.width + x) * 4 + 3]
        glyphInk.push(alpha)
      }
      const unchanged = body.querySelector('span')!.textContent
      port.remove()
      return { inside, outside, glyphInk, unchanged }
    })
    expect(result.inside).toBeGreaterThan(10000)
    expect(result.outside).toBe(0)
    expect(result.glyphInk).toHaveLength(6)
    expect(Math.min(...result.glyphInk)).toBeGreaterThan(1000)
    expect(result.unchanged).toBe('文字水光相遇')
    const shaped = await page.evaluateHandle(
      async (data) => {
        const api = (
          window as unknown as {
            MaskFixture: typeof import('../../src/renderer/src/effects/lucent/glyph-mask') &
              typeof import('../../src/renderer/src/effects/lucent/glyph-fonts')
          }
        ).MaskFixture
        const port = document.createElement('div')
        const fontStyle = document.createElement('style')
        fontStyle.textContent = `@font-face{font-family:"ZhuMo Palt Test";src:url(data:font/ttf;base64,${data})}`
        document.head.append(fontStyle)
        port.style.cssText =
          'position:fixed;left:150px;top:100px;width:450px;height:180px;overflow:hidden;background:#fff;z-index:99999'
        port.innerHTML =
          '<div class="section-body" style="margin:0;width:450px;max-width:none;color:#000;text-shadow:none"><p style="margin:0;text-indent:0;font:48px ZhuMo Palt Test;font-feature-settings:\'palt\' 1;line-height:1.4;text-align:left;letter-spacing:0"><span data-source-inline="0">（文）</span></p></div>'
        document.body.append(port)
        await document.fonts.load('48px "ZhuMo Palt Test"', '（文）')
        const span = port.querySelector('span')!,
          style = getComputedStyle(span),
          fonts = new api.GlyphFonts(() => {})
        let family = fonts.family(style, span.textContent!)
        const start = performance.now()
        while (!family && performance.now() - start < 5000) {
          await new Promise((done) => setTimeout(done, 30))
          family = fonts.family(style, span.textContent!)
        }
        if (!family) throw Error('OpenType mask font did not load')
        const mask = api.captureGlyphMask(port, undefined, (s, t) => fonts.family(s, t))
        const plain = api.captureGlyphMask(port)
        const ctx = mask.canvas.getContext('2d')!
        ctx.font = '48px ' + family
        const measured = ctx.measureText(span.textContent!).width
        const width = span.getBoundingClientRect().width
        return {
          port,
          fonts,
          mask,
          plain,
          measured,
          width,
          features: style.fontFeatureSettings,
          family: style.fontFamily,
          alias: family,
          loaded: [...document.fonts].filter(
            (f) => f.family.startsWith('ZhuMoReflection') && f.status === 'loaded'
          ).length
        }
      },
      (await readFile('tests/fixtures/palt-test.ttf')).toString('base64')
    )
    const nativePixels = await page.screenshot({
      clip: { x: 150, y: 100, width: 450, height: 180 },
      scale: 'device'
    })
    const parity = await shaped.evaluate(
      async ({ mask, plain, measured, width, features, loaded }, png) => {
        const image = await createImageBitmap(
          new Blob([new Uint8Array(png)], { type: 'image/png' })
        )
        const surface = document.createElement('canvas')
        surface.width = image.width
        surface.height = image.height
        const ctx = surface.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        const actual = ctx.getImageData(0, 0, image.width, image.height).data
        const expected = mask.canvas
          .getContext('2d')!
          .getImageData(0, 0, mask.canvas.width, mask.canvas.height).data
        const old = plain.canvas
          .getContext('2d')!
          .getImageData(0, 0, plain.canvas.width, plain.canvas.height).data
        let error = 0,
          ink = 0,
          oldError = 0
        const offset = Math.round(120 * mask.scale)
        for (let y = 0; y < image.height; y++)
          for (let x = 0; x < image.width; x++) {
            const value = 255 - actual[(y * image.width + x) * 4],
              alpha = expected[((y + offset) * mask.canvas.width + x) * 4 + 3]
            error += Math.abs(value - alpha)
            oldError += Math.abs(value - old[((y + offset) * mask.canvas.width + x) * 4 + 3])
            ink += value
          }
        image.close()
        return {
          relativeError: error / Math.max(1, ink),
          oldError: oldError / Math.max(1, ink),
          measured,
          width,
          features,
          loaded
        }
      },
      [...nativePixels]
    )
    console.log('GPOS mask/native pixel comparison:', JSON.stringify(parity))
    expect(parity.loaded).toBeGreaterThan(0)
    expect(parity.measured).toBeCloseTo(parity.width, 0)
    expect(parity.relativeError).toBeLessThan(parity.oldError)
    expect(parity.relativeError).toBeLessThan(0.35)
    await shaped.evaluate(({ port, fonts }) => {
      port.remove()
      fonts.dispose()
    })
  } finally {
    await app.close()
  }
})
