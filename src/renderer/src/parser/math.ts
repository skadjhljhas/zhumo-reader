import katex from 'katex'
import 'katex/contrib/mhchem'
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import type { MathItem } from 'mathjax-full/js/core/MathItem.js'
import type { LiteElement } from 'mathjax-full/js/adaptors/lite/Element.js'
import type { LiteText } from 'mathjax-full/js/adaptors/lite/Text.js'
import type { LiteDocument } from 'mathjax-full/js/adaptors/lite/Document.js'
import type {
  AbstractParseMap,
  CommandMap,
  DelimiterMap,
  EnvironmentMap
} from 'mathjax-full/js/input/tex/SymbolMap.js'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const packages = [
  ...AllPackages.filter((p) => !['html', 'action', 'noerrors', 'noundefined'].includes(p)),
  'physics'
]
function escapeHtml(source: string): string {
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface MathRenderer {
  (source: string, display: boolean): string
  /** Resolve deferred SVG output after every section and annotation has been compiled. */
  finalize(html: string): string
}
const macroMutation =
  /\\(?:gdef|xdef|def|edef|newcommand|renewcommand|providecommand|DeclareMathOperator|let|newenvironment|renewenvironment)\b/
const equationAware =
  /\\(?:eqref|label|ref|tag|notag|nonumber)\b|\\begin\{(?:equation|align|gather|multline|flalign|alignat)\*?\}/
const restrictedExtension = /\\(?:html[A-Z]\w*|require|class|style|cssId)\b/

function wrapMath(source: string, display: boolean, html: string, engine: string): string {
  const tag = display ? 'div' : 'span'
  const error = engine === 'source' ? ' data-math-error="true"' : ''
  return `<${tag} class="zmu-math${display ? ' zmu-math-block' : ''}" data-math-source="${escapeHtml(source)}" data-math-engine="${engine}"${error} tabindex="0" role="button" aria-label="查看公式与 LaTeX 源文">${html}</${tag}>`
}
function retainedSource(source: string, display: boolean): string {
  return wrapMath(
    source,
    display,
    `<span class="zmu-math-error">${escapeHtml(source)}</span>`,
    'source'
  )
}

/** Track local user bindings through MathJax's public map operations. Snapshots share
 * unchanged maps, so ordinary formulas do not copy the full command dictionary. */
function trackBindings<T>(map: AbstractParseMap<T>): () => () => void {
  let bindings = new Map<string, T>()
  const add = map.add.bind(map),
    remove = map.remove.bind(map)
  map.add = (name, value) => {
    bindings = new Map(bindings).set(name, value)
    add(name, value)
  }
  map.remove = (name) => {
    bindings = new Map(bindings)
    bindings.delete(name)
    remove(name)
  }
  return () => {
    const saved = bindings
    return () => {
      for (const name of bindings.keys()) if (!saved.has(name)) remove(name)
      for (const [name, value] of saved) add(name, value)
      bindings = saved
    }
  }
}

/** Each book owns its macros, equation labels and cache. No document can redefine another. */
export function createMathRenderer(options: { deferred?: boolean } = {}): MathRenderer {
  const macros: NonNullable<katex.KatexOptions['macros']> = {}
  const cache = new Map<string, string>()
  const definitions: string[] = []
  const pending: Array<{
    item: MathItem<LiteElement, LiteText, LiteDocument>
    source: string
    display: boolean
  }> = []
  let resolved: string[] | undefined
  let fallback: ReturnType<typeof mathjax.document> | undefined
  let macroVersion = 0
  let customMacros = false
  let snapshotBindings: (() => () => void) | undefined
  const document = (): ReturnType<typeof mathjax.document> => {
    if (!fallback) {
      const input = new TeX({ packages, tags: 'ams', maxMacros: 1500, maxBuffer: 100000 })
      const handlers = input.parseOptions.handlers
      const snapshots = [
        trackBindings(handlers.retrieve('new-Command') as CommandMap),
        trackBindings(handlers.retrieve('new-Delimiter') as DelimiterMap),
        trackBindings(handlers.retrieve('new-Environment') as EnvironmentMap)
      ]
      snapshotBindings = () => {
        const restore = snapshots.map((snapshot) => snapshot())
        return () => restore.forEach((reset) => reset())
      }
      input.preFilters.add(({ math }: { math: MathItem<LiteElement, LiteText, LiteDocument> }) => {
        math.inputData.recompile?.restoreZhuMoBindings?.()
      })
      fallback = mathjax.document('', {
        InputJax: input,
        OutputJax: new SVG({ fontCache: 'none' })
      })
      for (const definition of definitions) fallback.convert(definition, { display: false })
    }
    return fallback
  }
  const svg = (source: string, display: boolean): string => {
    const doc = document()
    if (options.deferred) {
      const item: MathItem<LiteElement, LiteText, LiteDocument> = new doc.options.MathItem(
        source,
        doc.inputJax[0],
        display
      )
      item.start.node = adaptor.body(doc.document)
      item.setMetrics(16, 8, 1200, 1000000, 1)
      const restore = snapshotBindings?.()
      // Compile now so later formulas see macros and numbering in reading order.
      // MathJax's document compilation then revisits forward refs with all labels known.
      item.compile(doc)
      if (item.inputData.recompile && restore)
        item.inputData.recompile.restoreZhuMoBindings = restore
      doc.math.push(item)
      pending.push({ item, source, display })
      return `<!--zmu-math-slot:${pending.length - 1}-->`
    }
    const html = adaptor.outerHTML(
      doc.convert(source, { display, em: 16, ex: 8, containerWidth: 1200 })
    )
    return html.includes('data-mjx-error')
      ? retainedSource(source, display)
      : wrapMath(source, display, html, 'mathjax')
  }
  const render: MathRenderer = (source, display) => {
    const defines = macroMutation.test(source)
    customMacros ||= defines
    // Numbered environments and refs are stateful even when their source is identical.
    const mutates = defines || equationAware.test(source)
    const key = `${macroVersion}:${display}:${source}`
    if (!mutates && !customMacros && cache.has(key)) return cache.get(key)!
    let result: string
    let fast = false
    try {
      if (
        equationAware.test(source) ||
        restrictedExtension.test(source) ||
        (customMacros && fallback)
      )
        throw new Error('Use equation-aware renderer')
      const html = katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        macros,
        globalGroup: true,
        maxExpand: 1500,
        maxSize: 30,
        output: 'htmlAndMathml'
      })
      result = wrapMath(source, display, html, 'katex')
      fast = true
      if (defines) definitions.push(source)
    } catch {
      try {
        result = svg(source, display)
      } catch {
        result = retainedSource(source, display)
      }
    }
    if (mutates) macroVersion++
    // Custom commands can hide counter changes and further definitions. Keep them in one
    // macro environment after falling back, and cache only known stateless fast output.
    if (fast && !mutates && !customMacros && cache.size < 1200) cache.set(key, result)
    return result
  }
  render.finalize = (html) => {
    if (!pending.length) return html
    if (!resolved) {
      fallback!.compile().typeset()
      resolved = pending.map(({ item, source, display }) => {
        const markup = adaptor.outerHTML(item.typesetRoot)
        return markup.includes('data-mjx-error')
          ? retainedSource(source, display)
          : wrapMath(source, display, markup, 'mathjax')
      })
    }
    return html.replace(
      /<!--zmu-math-slot:(\d+)-->/g,
      (slot, index) => resolved![Number(index)] ?? slot
    )
  }
  return render
}
