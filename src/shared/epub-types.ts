export interface EpubChapter {
  href: string
  title: string
  html: string
  linear: boolean
}
export interface EpubToc {
  title: string
  href: string
  level: number
}
export interface EpubBook {
  title: string
  author: string
  language: string
  chapters: EpubChapter[]
  toc: EpubToc[]
  resources: Record<string, string>
  warnings: string[]
}
export function epubLocation(
  base: string,
  href: string
): { path: string; hash: string } | undefined {
  try {
    const root = 'https://epub.invalid/'
    const url = new URL(href, root + base.split('/').map(encodeURIComponent).join('/'))
    if (url.origin !== 'https://epub.invalid') return
    return {
      path: decodeURIComponent(url.pathname.slice(1)),
      hash: decodeURIComponent(url.hash.slice(1))
    }
  } catch {
    return
  }
}
export const epubAnchor = (path: string, hash = ''): string =>
  'epub-' +
  [...new TextEncoder().encode(path + '#' + hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
