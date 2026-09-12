/** Canvas's font shorthand cannot express arbitrary OpenType positioning features.
 * Private FontFace aliases carry the same features as descriptors; only the mask
 * uses these aliases. The document's font and typesetting remain untouched. */
interface Entry {
  family: string
  initializing: boolean
  pending: Set<string>
  failed: Set<string>
  loaded: Set<string>
  error?: string
}
let sequence = 0
const quoted = (value: string): string => JSON.stringify(value)
const families = (value: string): string[] =>
  (value.match(/"[^"]+"|'[^']+'|[^,]+/g) ?? []).map((name) =>
    name.trim().replace(/^["']|["']$/g, '')
  )

export class GlyphFonts {
  private entries = new Map<string, Entry>()
  private faces = new Set<FontFace>()
  private disposed = false
  constructor(private invalidate: () => void) {}

  private rules(): CSSFontFaceRule[] {
    const result: CSSFontFaceRule[] = []
    const collect = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) result.push(rule)
        else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        collect(sheet.cssRules)
      } catch {
        /* Cross-origin style sheets are not sources for local font aliases. */
      }
    }
    return result
  }

  private async register(
    style: CSSStyleDeclaration,
    features: string,
    entry: Entry
  ): Promise<void> {
    const aliases: string[] = [],
      rules = this.rules()
    const attach = (face: FontFace): void => {
      if (this.disposed) return
      this.faces.add(face)
      document.fonts.add(face)
    }
    for (const family of families(style.fontFamily)) {
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family)) {
        aliases.push(family)
        continue
      }
      const alias = 'ZhuMoReflectionFont_' + ++sequence
      aliases.push(quoted(alias))
      const imported = /^ZhuMoFont_([a-f0-9]{64})$/.exec(family)
      if (imported) {
        const bytes = await window.api.readFont(imported[1])
        attach(new FontFace(alias, new Uint8Array(bytes).buffer, { featureSettings: features }))
        continue
      }
      const matching = rules.filter((rule) => families(rule.style.fontFamily).includes(family))
      if (!matching.length) {
        attach(
          new FontFace(alias, `local(${quoted(family)})`, {
            featureSettings: features,
            weight: style.fontWeight,
            style: style.fontStyle
          })
        )
        continue
      }
      for (const rule of matching) {
        const source = rule.style
          .getPropertyValue('src')
          .replace(
            /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g,
            (_match, double: string, single: string, bare: string) =>
              `url(${quoted(new URL(double || single || bare.trim(), rule.parentStyleSheet?.href || document.baseURI).href)})`
          )
        attach(
          new FontFace(alias, source, {
            style: rule.style.fontStyle || 'normal',
            weight: rule.style.fontWeight || 'normal',
            stretch: rule.style.fontStretch || 'normal',
            unicodeRange: rule.style.getPropertyValue('unicode-range') || 'U+0-10FFFF',
            featureSettings: [rule.style.fontFeatureSettings, features]
              .filter((value) => value && value !== 'normal')
              .join(',')
          })
        )
      }
    }
    entry.family = aliases.join(', ')
    entry.initializing = false
    if (!this.disposed) this.invalidate()
  }

  family(style: CSSStyleDeclaration, text: string): string | undefined {
    const features = style.fontFeatureSettings
    if (!features || features === 'normal') return style.fontFamily
    const key = [style.fontFamily, features, style.fontStyle, style.fontWeight].join('|')
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        family: '',
        initializing: true,
        pending: new Set(),
        failed: new Set(),
        loaded: new Set()
      }
      this.entries.set(key, entry)
      const own = entry
      void this.register(style, features, own).catch((error) => {
        own.initializing = false
        own.family = ''
        own.error = String(error)
      })
    }
    if (entry.initializing || !entry.family) return undefined
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${entry.family}`
    const request = font + '\n' + text
    if (entry.loaded.has(request)) return entry.family
    if (!entry.pending.has(request) && !entry.failed.has(request)) {
      entry.pending.add(request)
      const own = entry
      // A missing platform fallback (for example Songti on Windows) must not
      // prevent the available primary font from being used by the mask.
      void Promise.allSettled(
        families(entry.family).map((family) =>
          document.fonts.load(
            `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${quoted(family)}`,
            text
          )
        )
      )
        .then((results) => {
          if (results.some((result) => result.status === 'fulfilled' && result.value.length > 0))
            own.loaded.add(request)
          else own.failed.add(request)
        })
        .finally(() => {
          own.pending.delete(request)
          if (!this.disposed) this.invalidate()
        })
    }
    return undefined
  }

  dispose(): void {
    this.disposed = true
    for (const face of this.faces) document.fonts.delete(face)
    this.faces.clear()
    this.entries.clear()
  }
}
