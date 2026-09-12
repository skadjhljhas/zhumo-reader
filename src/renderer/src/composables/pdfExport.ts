import { reactive } from 'vue'
import type { ParsedBook } from '../../../shared/types'
import type { SyntaxAnalysis } from '../../../shared/ai-types'
import { bookState, parseInWorker } from './useBook'
import { documentSession } from './documentSession'
import { documentAnnotationSources } from './documentAnnotations'
import { settings } from './useSettings'
import { studio } from './useStudio'
import { automaticSyntax, syntaxEntryContains } from './automaticSyntax'
import { aiSelection, aiState } from './aiReading'
import { readingAppearance, readingAppearanceKey } from '../effects/reading-appearance'
import { readingColorSegments } from '../../../shared/reading-colors'
import { readingPalette } from '../effects/reading-palette'
import { resolveSyntaxAnchors, type SyntaxAnchor } from '../effects/syntax-ranges'
import { attachBookResources } from './bookResources'
export const pdfExport = reactive({
  open: false,
  busy: false,
  error: '',
  style: 'theme' as 'theme' | 'paper',
  landscape: false,
  notes: true
})
const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(binary)
}
function cssSnapshot(): string {
  return [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules]
          .map((rule) =>
            rule.cssText.replace(/url\((['"]?)(.*?)\1\)/g, (all, _quote, url) => {
              if (url.startsWith('data:') || url.startsWith('#')) return all
              return (
                'url("' +
                new URL(url, sheet.href ?? document.baseURI).href.replace(/"/g, '%22') +
                '")'
              )
            })
          )
          .join('\n')
      } catch {
        return ''
      }
    })
    .join('\n')
}
function addInk(root: HTMLElement, book: ParsedBook): void {
  if (
    !aiState.lightsOn ||
    studio.effectsMode === 'off' ||
    documentSession.mode !== 'read' ||
    pdfExport.style === 'paper'
  )
    return
  const sources: Array<{ analysis: SyntaxAnalysis; anchors: SyntaxAnchor[] }> =
    automaticSyntax.entries
      .filter(
        (e) =>
          settings.automaticSyntax &&
          e.analysis?.version === 4 &&
          !automaticSyntax.entries.some(
            (other) =>
              (other.analysis?.marks?.length || other.analysis?.spans.length) &&
              syntaxEntryContains(other, e)
          )
      )
      .map((e) => ({ analysis: e.analysis!, anchors: e.anchors }))
  if (settings.annotationMode === 'document') {
    sources.length = 0
    sources.push(...documentAnnotationSources.value)
  }
  if (
    aiSelection.value &&
    aiState.runs.syntax.analysis?.version === 4 &&
    !aiState.stale &&
    aiState.runs.syntax.appearanceKey === readingAppearanceKey()
  )
    sources.push({ analysis: aiState.runs.syntax.analysis, anchors: aiSelection.value.anchors })
  for (const source of sources) {
    const slices = resolveSyntaxAnchors(source.anchors, book.notes, root)
    const work: Array<{ node: Text; from: number; to: number; ink: string; glow: string }> = []
    for (const segment of readingColorSegments(source.analysis.marks ?? []))
      for (const slice of slices) {
        const start = Math.max(segment.start, slice.start),
          end = Math.min(segment.end, slice.end)
        if (end <= start) continue
        if (slice.atomic && slice.node instanceof HTMLElement) {
          slice.node.style.backgroundColor = segment.mark.glowColor + '40'
          continue
        }
        if (slice.node instanceof Text && !slice.node.parentElement?.closest('math,svg'))
          work.push({
            node: slice.node,
            from: slice.from + start - slice.start,
            to: slice.from + end - slice.start,
            ink: segment.mark.textColor,
            glow: segment.mark.glowColor
          })
      }
    const grouped = new Map<Text, typeof work>()
    for (const item of work) grouped.set(item.node, [...(grouped.get(item.node) ?? []), item])
    for (const items of grouped.values())
      for (const item of items.sort((a, b) => b.from - a.from)) {
        const range = document.createRange()
        range.setStart(item.node, item.from)
        range.setEnd(item.node, item.to)
        const span = document.createElement('span'),
          p = readingPalette(item.glow)
        span.className = 'pdf-ink'
        span.style.color = item.ink
        span.style.backgroundImage = `linear-gradient(110deg,${p.cool}28,${p.main}70 35%,${p.main}50 70%,${p.warm}38)`
        span.style.textShadow = '0 0 3px ' + item.glow + '60'
        range.surroundContents(span)
      }
  }
}
export async function composePdf(book: ParsedBook, title: string, path: string): Promise<string> {
  const root = document.createElement('div')
  root.className = 'studio-frame pdf-document reader-scroll'
  const assigned = new Set<string>()
  root.innerHTML =
    studio.themeId === 'paper' && pdfExport.style === 'theme'
      ? ''
      : '<header class="document-overture pdf-title"><div class="overture-copy"><span class="eyebrow">朱墨 · ' +
        (pdfExport.style === 'theme'
          ? escape(
              studio.themeId === 'lucent'
                ? '琉璃'
                : studio.themeId === 'chaosheng'
                  ? '潮光'
                  : '阅读空间'
            )
          : '文稿') +
        '</span><h1>' +
        escape(title) +
        '</h1></div></header>'
  for (const section of book.sections) {
    const chapter = document.createElement('section')
    chapter.className = 'section-frame pdf-chapter'
    chapter.dataset.sectionId = section.id
    const article = document.createElement('article')
    article.className = 'section-body'
    article.innerHTML = section.html
    const aside = document.createElement('aside')
    aside.className = 'pdf-notes'
    if (pdfExport.notes) {
      const attached = book.notes.filter(
        (note) =>
          !assigned.has(note.id) &&
          (section.anchorIds.includes(note.id) ||
            note.anchorSpots.some((spot) => spot.kind === 'body' && spot.sectionId === section.id))
      )
      for (const note of attached) {
        assigned.add(note.id)
        aside.innerHTML +=
          '<section class="note-card pdf-note" data-note-id="' +
          escape(note.id) +
          '" id="pdf-note-' +
          escape(note.id) +
          '"><header class="pdf-note-label">' +
          escape(note.typeLabel ?? '注') +
          ' · ' +
          escape(note.displayMark) +
          '</header><div class="zmu-note-body">' +
          note.html +
          '</div></section>'
      }
    }
    const columns = document.createElement('div')
    columns.className = 'pdf-columns'
    if ((aside.textContent?.length ?? 0) > Math.max(800, article.textContent?.length ?? 0))
      columns.classList.add('pdf-notes-below')
    columns.append(article)
    if (aside.children.length) columns.append(aside)
    else columns.classList.add('pdf-body-only')
    chapter.append(columns)
    root.append(chapter)
  }
  const remaining = pdfExport.notes ? book.notes.filter((n) => !assigned.has(n.id)) : []
  if (remaining.length) {
    const appendix = document.createElement('section')
    appendix.className = 'pdf-appendix'
    appendix.innerHTML =
      '<h2>其他注释</h2>' +
      remaining
        .map(
          (n) =>
            '<section class="note-card pdf-note" data-note-id="' +
            escape(n.id) +
            '" id="pdf-note-' +
            escape(n.id) +
            '"><header class="pdf-note-label">' +
            escape(n.typeLabel ?? '注') +
            ' · ' +
            escape(n.displayMark) +
            '</header><div class="zmu-note-body">' +
            n.html +
            '</div></section>'
        )
        .join('')
    root.append(appendix)
  }
  addInk(root, book)
  const diagrams = root.querySelectorAll<HTMLElement>('.zmu-diagram')
  if (diagrams.length) {
    const [{ renderDiagram }, { diagramInstance }] = await Promise.all([
      import('./diagramRenderer'),
      import('./diagramSvg')
    ])
    for (const diagram of diagrams) {
      const source = diagram.querySelector('.diagram-source code')?.textContent ?? ''
      try {
        const result = await renderDiagram(
          source,
          pdfExport.style === 'paper' ? 'lucent' : studio.themeId
        )
        diagram.innerHTML = '<div class="diagram-canvas">' + diagramInstance(result.svg) + '</div>'
        diagram.dataset.diagramState = 'ready'
      } catch {
        const pre = document.createElement('pre')
        pre.textContent = source
        diagram.replaceChildren(pre)
      }
    }
  }
  root.querySelectorAll('details').forEach((details) => {
    details.open = true
  })
  for (const ref of root.querySelectorAll<HTMLElement>('.zmu-ref')) {
    const anchor = document.createElement('a')
    anchor.className = ref.className
    anchor.innerHTML = ref.innerHTML
    if (pdfExport.notes) anchor.href = '#pdf-note-' + ref.dataset.noteId
    ref.replaceWith(anchor)
  }
  for (const img of root.querySelectorAll('img')) {
    img.removeAttribute('loading')
    if (img.getAttribute('src')) {
      try {
        img.src = new URL(
          img.getAttribute('src')!,
          new URL(path.replace(/\\/g, '/'), 'file:///')
        ).href
      } catch {
        /* Preserve a resource URL when no filesystem base exists for an unsaved draft. */
      }
    }
  }
  const computed = getComputedStyle(document.documentElement),
    vars = [...computed]
      .filter((name) => name.startsWith('--'))
      .map((name) => name + ':' + computed.getPropertyValue(name) + ';')
      .join('')
  let customFonts = ''
  for (const id of new Set(
    [settings.uiFont, settings.bodyFont, settings.noteFont].filter(Boolean)
  )) {
    const bytes = await window.api.readFont(id)
    customFonts +=
      '@font-face{font-family:"ZhuMoFont_' +
      id +
      '";src:url(data:font/ttf;base64,' +
      base64(bytes) +
      ');font-weight:normal;font-style:normal;}'
  }
  let background = ''
  if (pdfExport.style === 'theme' && studio.effectsMode !== 'off') {
    window.dispatchEvent(new Event('zhumo:capture-optics'))
    const canvas = document.querySelector<HTMLCanvasElement>('.optical-field,.tidal-field')
    try {
      if (canvas?.width && canvas?.height) background = canvas.toDataURL('image/png')
    } catch {
      /* The theme colours still render without an unavailable bitmap. */
    }
    const art = document.querySelector<HTMLCanvasElement>(
      '.document-overture .manuscript-light-canvas'
    )
    try {
      if (art?.width && art?.height) {
        const image = document.createElement('img')
        image.className = 'pdf-title-art'
        image.src = art.toDataURL('image/png')
        image.setAttribute('aria-hidden', 'true')
        root.querySelector('.pdf-title')?.append(image)
      }
    } catch {
      /* Optional title light may be unavailable after a GPU reset. */
    }
  }
  const attributes = [
    'skin',
    'theme',
    'paragraphStyle',
    'customBodyfont',
    'customNotefont',
    'customUifont'
  ]
    .map((key) => {
      const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        value = document.documentElement.getAttribute(attr)
      return value === null ? '' : attr + '="' + escape(value) + '"'
    })
    .filter(Boolean)
    .join(' ')
  const css = `
@page{size:A4 ${pdfExport.landscape ? 'landscape' : 'portrait'};margin:14mm 14mm 17mm;}
:root{${vars}} ${customFonts}
html,body{height:auto!important;min-width:0!important;overflow:visible!important;background:transparent!important;color-scheme:light!important;scrollbar-width:none!important;}
::-webkit-scrollbar{display:none!important;}
*{animation:none!important;transition:none!important;caret-color:transparent!important;print-color-adjust:exact;-webkit-print-color-adjust:exact;}
.pdf-background{position:fixed;inset:0;z-index:-1;background-color:${pdfExport.style === 'paper' ? '#fff' : 'var(--bg)'};background-image:${background ? 'url("' + background + '")' : 'none'};background-size:cover;background-position:center;}
.pdf-document{display:block!important;height:auto!important;overflow:visible!important;min-width:0!important;color:var(--text);background:transparent!important;}
.pdf-title{min-height:0!important;padding:0 0 8mm!important;margin:0 0 8mm!important;break-after:avoid;}
.pdf-title h1{font-size:30px!important;line-height:1.5!important;}
.pdf-title{position:relative;}.pdf-title-art{position:absolute;right:0;top:0;width:42%;height:115px;object-fit:contain;pointer-events:none;}.pdf-title:has(.pdf-title-art) .overture-copy{max-width:60%;}
.pdf-chapter{padding:0!important;margin:0 0 6mm!important;}
.pdf-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.43fr);gap:7mm;align-items:start;}
.pdf-body-only{display:block;}
.pdf-document .section-body,.pdf-document .zmu-note-body{content-visibility:visible!important;contain:none!important;overflow:visible!important;max-height:none!important;width:100%!important;max-width:100%!important;min-width:0!important;margin-left:0!important;margin-right:0!important;box-sizing:border-box!important;}
.pdf-document .section-body{font-family:var(--font-body);font-size:15px!important;line-height:1.9!important;}
.pdf-document .section-body :is(h1,h2,h3,h4){break-after:avoid;}
.pdf-document p{orphans:3;widows:3;}
.pdf-document :is(img,svg){max-width:100%;}
.pdf-document pre{white-space:pre-wrap!important;overflow-wrap:anywhere;overflow:visible!important;}
.pdf-document .diagram-canvas{height:auto!important;max-height:none!important;overflow:visible!important;}.pdf-document .diagram-canvas svg{height:auto!important;width:100%!important;}
.pdf-document :is(.zmu-diagram,.zmu-math-block){break-inside:avoid-page;}
.pdf-notes{min-width:0;}
.pdf-document .pdf-note{position:relative!important;transform:none!important;padding:0 0 0 3mm!important;margin:0 0 5mm!important;opacity:1!important;break-inside:avoid-page;background:transparent!important;border:0!important;border-left:1px solid var(--line-strong)!important;box-shadow:none!important;}
.pdf-note .zmu-note-body{font-family:var(--font-note,'LXGW WenKai',serif)!important;font-size:11px!important;line-height:1.8!important;}
.pdf-note-label{font-family:var(--ui-font);font-size:10px;color:var(--text-2);margin-bottom:2mm;break-after:avoid;}
.pdf-document .pdf-long-note{break-inside:auto;}
.pdf-notes-below{display:block;}.pdf-notes-below .pdf-notes{margin-top:6mm;}.pdf-notes-below .zmu-note-body{font-size:13px!important;}.pdf-notes-below .pdf-note{break-inside:auto;}
.pdf-document .pdf-ink{box-decoration-break:clone;-webkit-box-decoration-break:clone;border-radius:3px;}
.pdf-appendix{break-before:page;}
${pdfExport.style === 'paper' ? '.pdf-document pre,.pdf-document code{background:#f3f5f7!important;color:#25333b!important;} .pdf-document .zmu-ref-mark{background:#e3edf4!important;color:#314f65!important;box-shadow:none!important;} .pdf-document .eyebrow{color:#536573!important;}' : ''}
${pdfExport.style === 'paper' ? ':root{--bg:#fff!important;--bg-elevated:#f5f7fa!important;--paper:#fff!important;--text:#25333b!important;--text-2:#536573!important;--line-strong:#acbcc7!important;--accent:#40647e!important;--accent-strong:#40647e!important;} .pdf-document *{text-shadow:none!important;} .pdf-document .section-body *{color:inherit!important;} .pdf-document :is(h1,h2,h3,h4){color:var(--text)!important;background:none!important;-webkit-text-fill-color:currentColor!important;}' : ''}
`
  return (
    '<!doctype html><html ' +
    attributes +
    ' style="' +
    escape(vars) +
    '"' +
    '><head><meta charset="utf-8"><title>' +
    escape(title) +
    '</title><style>' +
    cssSnapshot() +
    css +
    '</style></head><body><div class="pdf-background"></div>' +
    root.outerHTML +
    '</body></html>'
  )
}
export async function exportCurrentPdf(): Promise<void> {
  if (pdfExport.busy || !bookState.payload || !bookState.book) return
  pdfExport.busy = true
  pdfExport.error = ''
  try {
    const payload = bookState.payload,
      path = payload.path,
      source = documentSession.source
    const book = payload.epub
      ? bookState.book
      : attachBookResources(await parseInWorker(source, settings.noteLevelCap), path)
    const title = book.title || payload.title || '未命名'
    const html = await composePdf(book, title, path)
    const result = await window.api.exportPdf({
      title,
      html,
      orientation: pdfExport.landscape ? 'landscape' : 'portrait',
      footerColor: pdfExport.style === 'paper' ? '#496274' : readingAppearance().textColor
    })
    if (result) {
      pdfExport.open = false
      bookState.statusMessage =
        'PDF 已导出：' +
        result.path +
        (result.missingImages ? '（有 ' + result.missingImages + ' 张图片未加载）' : '')
    }
  } catch (error) {
    pdfExport.error = error instanceof Error ? error.message : String(error)
  } finally {
    pdfExport.busy = false
  }
}
