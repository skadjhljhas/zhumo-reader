import type { ParsedBook } from '../../../shared/types'
import { searchBlocks } from './searchText'

export function bookFileUrl(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/')
  if (/^[a-z]:\//i.test(normalized))
    return `file:///${normalized.slice(0, 2)}${encodePath(normalized.slice(2))}`
  if (normalized.startsWith('//')) {
    const [host, ...rest] = normalized.slice(2).split('/')
    return `file://${host}/${rest.map(encodeURIComponent).join('/')}`
  }
  if (normalized.startsWith('/')) return `file://${encodePath(normalized)}`
  return undefined
}
export function bookPathFromUrl(url: URL): string | undefined {
  if (url.protocol !== 'file:') return undefined
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  if (url.hostname) return `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
  return /^\/[a-z]:\//i.test(path) ? path.slice(1).replace(/\//g, '\\') : path
}
export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Attach local image locations and stable heading hashes to the reading projection only. */
export function attachBookResources(book: ParsedBook, path: string): ParsedBook {
  const base = bookFileUrl(path)
  const counts = new Map<string, number>()
  const transform = (html: string, headings: boolean): string => {
    if (!/<img\b|<h[1-6]\b/.test(html)) return html
    const template = document.createElement('template')
    template.innerHTML = html
    if (base)
      template.content.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src')
        if (src) {
          try {
            img.src = new URL(src, base).href
          } catch {
            /* Preserve unsupported URLs as supplied. */
          }
        }
        img.loading = 'lazy'
        img.decoding = 'async'
      })
    if (headings)
      template.content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading) => {
        const copy = heading.cloneNode(true) as HTMLElement
        copy.querySelectorAll('.zmu-ref').forEach((ref) => ref.remove())
        const slug = headingSlug(copy.textContent ?? '')
        const duplicate = counts.get(slug) ?? 0
        counts.set(slug, duplicate + 1)
        heading.dataset.headingHash = duplicate ? `${slug}-${duplicate}` : slug
      })
    return template.innerHTML
  }
  for (const section of book.sections) section.html = transform(section.html, true)
  for (const note of book.notes) note.html = transform(note.html, false)
  return book
}

export function findBookHash(
  book: ParsedBook,
  hash: string
): { sectionId: string; blockIndex: number } | undefined {
  let decoded = hash.replace(/^#/, '')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    /* Literal malformed percent marks remain searchable. */
  }
  for (const section of book.sections) {
    if (!section.html.includes('data-heading-hash=')) continue
    const template = document.createElement('template')
    template.innerHTML = section.html
    const target = template.content.querySelector(`[data-heading-hash="${CSS.escape(decoded)}"]`)
    if (target) {
      const blocks = searchBlocks(template.content)
      const index = blocks.findIndex(
        (block) => block === target || block.contains(target) || target.contains(block)
      )
      return {
        sectionId: section.id,
        blockIndex:
          index >= 0
            ? index
            : Math.max(
                0,
                blocks.findIndex((block) =>
                  Boolean(target.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
                )
              )
      }
    }
  }
  return undefined
}
