export interface GlyphMask {
  port: HTMLElement
  canvas: HTMLCanvasElement
  left: number
  top: number
  width: number
  height: number
  scroll: number
  scrollX: number
  scale: number
  glyphs: number
  anchor?: { element: HTMLElement; x: number; y: number; height: number }
}
const overscan = 120
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const measuredCharacters =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u

/** Capture only glyph alpha using the actual DOM run font and measured positions.
 * The original text, selection, annotations and model colours are never rewritten. */
export function captureGlyphMask(
  port: HTMLElement,
  previous?: GlyphMask,
  fontFamily?: (style: CSSStyleDeclaration, text: string) => string | undefined,
  selection?: { ranges: Range[]; bounds: DOMRect; padding: number }
): GlyphMask {
  const box = selection?.bounds ?? port.getBoundingClientRect(),
    canvas = previous?.canvas ?? document.createElement('canvas')
  const margin = selection?.padding ?? overscan
  const captureLeft = box.left - (selection ? margin : 0)
  const scale = Math.min(devicePixelRatio, 2)
  const width = Math.max(1, box.width + (selection ? margin * 2 : 0)),
    height = Math.max(1, box.height + margin * 2)
  if (canvas.width !== Math.ceil(width * scale)) canvas.width = Math.ceil(width * scale)
  if (canvas.height !== Math.ceil(height * scale)) canvas.height = Math.ceil(height * scale)
  const ctx = canvas.getContext('2d', { alpha: true })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const top = box.top - margin,
    bottom = box.bottom + margin
  if (selection) {
    ctx.beginPath()
    ctx.rect(margin, margin, box.width, box.height)
    ctx.clip()
  }
  let glyphs = 0
  let anchor: GlyphMask['anchor']
  const excluded = 'pre,code,.zmu-math,.zmu-diagram,.zmu-ref,button,svg,canvas'
  const targets = [
    ...port.querySelectorAll<HTMLElement>(
      '.section-body [data-source-inline],.zmu-note-body [data-source-inline],.document-overture h1'
    )
  ]
  if (selection) {
    targets.length = 0
    if (port.matches('[data-source-inline]')) targets.push(port)
    targets.push(...port.querySelectorAll<HTMLElement>('[data-source-inline]'))
  }
  const range = document.createRange()
  const clipping = new Map<Element, { rect: DOMRect; x: boolean; y: boolean }>()
  for (const target of targets) {
    const bounds = target.getBoundingClientRect()
    if (
      !bounds.width ||
      !bounds.height ||
      bounds.bottom < top ||
      bounds.top > bottom ||
      target.closest(excluded)
    )
      continue
    anchor ??= {
      element: target,
      x: bounds.left - box.left,
      y: bounds.top - box.top + port.scrollTop,
      height: bounds.height
    }
    ctx.save()
    // A text table or a long annotation may have its own clipped viewport inside
    // the reader. Invisible glyphs must not create light outside that viewport.
    for (
      let ancestor: HTMLElement | null = target;
      ancestor && ancestor !== port;
      ancestor = ancestor.parentElement
    ) {
      let clip = clipping.get(ancestor)
      if (!clip) {
        const style = getComputedStyle(ancestor)
        clip = {
          rect: ancestor.getBoundingClientRect(),
          x: style.overflowX !== 'visible',
          y: style.overflowY !== 'visible'
        }
        clipping.set(ancestor, clip)
      }
      if (clip.x || clip.y) {
        const left = clip.x ? Math.max(box.left, clip.rect.left) : box.left
        const right = clip.x ? Math.min(box.right, clip.rect.right) : box.right
        const upper = clip.y ? Math.max(top, clip.rect.top) : top
        const lower = clip.y ? Math.min(bottom, clip.rect.bottom) : bottom
        ctx.beginPath()
        ctx.rect(
          left - captureLeft,
          upper - top,
          Math.max(0, right - left),
          Math.max(0, lower - upper)
        )
        ctx.clip()
      }
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    while (walker.nextNode() && glyphs < 12000) {
      const node = walker.currentNode as Text,
        element = node.parentElement
      if (!element || !node.data.trim() || element.closest(excluded)) continue
      const owner = element.closest('[data-source-inline]')
      if (owner && owner !== target) continue
      range.selectNodeContents(node)
      const full = range.getBoundingClientRect()
      if (full.bottom < top || full.top > bottom || !full.height) continue
      const style = getComputedStyle(element)
      const seek = (edge: number, end: boolean): number => {
        let low = 0,
          high = node.length
        while (low < high) {
          const mid = (low + high) >>> 1
          range.setStart(node, mid)
          range.setEnd(node, mid + 1)
          const r = range.getBoundingClientRect()
          if (end ? r.top <= edge : r.bottom < edge) low = mid + 1
          else high = mid
        }
        return low
      }
      const start = full.top < top ? seek(top, false) : 0
      const end = full.bottom > bottom ? seek(bottom, true) : node.length
      const visibleText = node.data.slice(start, end)
      const family = fontFamily ? fontFamily(style, visibleText) : style.fontFamily
      if (!family) continue
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${family}`
      ctx.fontKerning = style.fontKerning as CanvasFontKerning
      ctx.fontStretch = style.fontStretch as CanvasFontStretch
      ctx.fontVariantCaps = style.fontVariantCaps as CanvasFontVariantCaps
      ctx.direction = style.direction === 'rtl' ? 'rtl' : 'ltr'
      ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
      ctx.wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing
      const metrics = ctx.measureText('Hg国')
      const ascent = metrics.fontBoundingBoxAscent || parseFloat(style.fontSize) * 0.86
      const paint = (from: number, to: number): void => {
        const text = node.data.slice(from, to)
        if (!text.trim()) return
        range.setStart(node, from)
        range.setEnd(node, to)
        const rects = range.getClientRects()
        if (rects.length > 1) {
          const parts = [...graphemes.segment(text)]
          if (parts.length > 1) {
            for (const item of parts)
              paint(from + item.index, from + item.index + item.segment.length)
            return
          }
        }
        const rect = range.getBoundingClientRect()
        if (rect.width && rect.bottom >= top && rect.top <= bottom) {
          ctx.fillText(text, rect.left - captureLeft, rect.top - top + ascent)
          glyphs += text.length
        }
      }
      const spans = selection
        ? selection.ranges
            .filter((r) => r.intersectsNode(node))
            .map((r) => ({
              start: Math.max(start, r.startContainer === node ? r.startOffset : 0),
              end: Math.min(end, r.endContainer === node ? r.endOffset : node.length)
            }))
        : [{ start, end }]
      for (const span of spans)
        for (const part of segmenter.segment(node.data.slice(span.start, span.end))) {
          const from = span.start + part.index
          if (measuredCharacters.test(part.segment)) {
            for (const item of graphemes.segment(part.segment))
              paint(from + item.index, from + item.index + item.segment.length)
          } else paint(from, from + part.segment.length)
        }
    }
    ctx.restore()
  }
  return {
    port,
    canvas,
    left: captureLeft,
    top,
    width,
    height,
    scroll: port.scrollTop,
    scrollX: port.scrollLeft,
    scale,
    glyphs,
    anchor
  }
}

export function glyphMaskPosition(mask: GlyphMask): {
  x: number
  y: number
  width: number
  height: number
  clip: DOMRect
} {
  const clip = mask.port.getBoundingClientRect()
  return {
    x: clip.left - (mask.port.scrollLeft - mask.scrollX),
    y: clip.top - overscan - (mask.port.scrollTop - mask.scroll),
    width: mask.width,
    height: mask.height,
    clip
  }
}

export function needsGlyphMaskRefresh(mask: GlyphMask): boolean {
  const rect = mask.port.getBoundingClientRect()
  const anchor = mask.anchor,
    actual = anchor?.element.getBoundingClientRect()
  return (
    !mask.port.isConnected ||
    Math.abs(mask.port.scrollTop - mask.scroll) > overscan * 0.6 ||
    mask.port.scrollLeft !== mask.scrollX ||
    Math.min(devicePixelRatio, 2) !== mask.scale ||
    Math.abs(rect.width - mask.width) > 0.5 ||
    Math.abs(rect.height + overscan * 2 - mask.height) > 0.5 ||
    Boolean(
      anchor &&
      actual &&
      (!anchor.element.isConnected ||
        Math.abs(actual.left - rect.left - anchor.x) > 0.5 ||
        Math.abs(actual.top - rect.top + mask.port.scrollTop - anchor.y) > 0.5 ||
        Math.abs(actual.height - anchor.height) > 0.5)
    )
  )
}
