let instance = 0
export const nextDiagramId = (): string => `zhumo-diagram-${++instance}`

/** Cached diagrams and their enlarged copies must never share SVG IDs or marker references. */
export function diagramInstance(markup: string, prefix = nextDiagramId()): string {
  const template = document.createElement('template')
  template.innerHTML = markup
  const ids = new Map<string, string>()
  template.content.querySelectorAll('[id]').forEach((node) => {
    const id = node.id
    ids.set(id, `${prefix}-${id}`)
    node.id = ids.get(id)!
  })
  const urls = (value: string): string =>
    value.replace(
      /url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g,
      (_whole, _quote: string, id: string) => `url(#${ids.get(id) ?? `${prefix}-${id}`})`
    )
  for (const node of template.content.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === 'id') continue
      let value = urls(attribute.value)
      if (['href', 'xlink:href'].includes(attribute.name) && value.startsWith('#'))
        value = `#${ids.get(value.slice(1)) ?? `${prefix}-${value.slice(1)}`}`
      if (['aria-labelledby', 'aria-describedby'].includes(attribute.name))
        value = value
          .split(/\s+/)
          .map((id) => ids.get(id) ?? `${prefix}-${id}`)
          .join(' ')
      if (value !== attribute.value) node.setAttribute(attribute.name, value)
    }
    if (node.tagName.toLowerCase() === 'style') {
      let css = urls(node.textContent ?? '')
      for (const [id, replacement] of [...ids].sort((a, b) => b[0].length - a[0].length)) {
        const escaped = CSS.escape(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        css = css.replace(
          new RegExp(`#${escaped}(?=[\\s.#:[\\]>+~(){},]|$)`, 'g'),
          `#${replacement}`
        )
      }
      node.textContent = css
    }
  }
  return template.innerHTML
}

/** XML serialization also closes HTML void elements inside mathematical labels. */
export function exportDiagramSvg(markup: string): string {
  const template = document.createElement('template')
  template.innerHTML = diagramInstance(markup)
  const svg = template.content.querySelector('svg')
  if (!svg) throw new Error('没有可复制的图解。')
  return new XMLSerializer().serializeToString(svg)
}

/** Defense in depth after Mermaid's strict renderer; keep only local SVG references. */
export function cleanDiagramSvg(markup: string): {
  svg: string
  width: number
  height: number
  title: string
} {
  const template = document.createElement('template')
  template.innerHTML = markup
  const svg = template.content.querySelector('svg')
  if (!svg) throw new Error('图解没有生成可显示的 SVG。')
  svg
    .querySelectorAll('script,iframe,object,embed,image,img,a,animate,animateTransform,set')
    .forEach((node) => {
      if (node.tagName.toLowerCase() === 'a') node.replaceWith(...node.childNodes)
      else node.remove()
    })
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        (['href', 'xlink:href'].includes(attribute.name) && !attribute.value.startsWith('#'))
      )
        node.removeAttribute(attribute.name)
    }
  }
  const viewBox = svg
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number)
  const width = viewBox?.[2] || Number.parseFloat(svg.getAttribute('width') ?? '800')
  const height = viewBox?.[3] || Number.parseFloat(svg.getAttribute('height') ?? '400')
  if (![width, height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('图解的尺寸无效。')
  if (!viewBox) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  return { svg: svg.outerHTML, width, height, title: svg.querySelector('title')?.textContent ?? '' }
}
