import DOMPurify from 'dompurify'
import type { ParsedBook, NoteRecord, SourceBlock } from '../../../shared/types'
import { epubLocation, epubAnchor, type EpubBook } from '../../../shared/epub-types'
import { searchBlocks, searchableText } from '../composables/searchText'

const typeOf = (el: Element): string[] =>
  ((el.getAttribute('epub:type') ?? '') + ' ' + (el.getAttribute('role') ?? '')).split(/\s+/)
/** EPUB content joins the reader's semantic DOM, with publication styles/scripts isolated
 * out of the app and resources resolved exclusively from the selected archive. */
export function projectEpub(input: EpubBook): { book: ParsedBook; source: string } {
  const sections = input.chapters.map((chapter, i) => {
    const root = document.createElement('div')
    root.innerHTML = DOMPurify.sanitize(chapter.html, {
      USE_PROFILES: { html: true, svg: true, mathMl: true },
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['epub:type'],
      FORBID_TAGS: [
        'script',
        'style',
        'link',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'button',
        'textarea',
        'select',
        'meta',
        'base',
        'foreignObject',
        'template',
        'dialog'
      ],
      FORBID_ATTR: ['style', 'class', 'name', 'autofocus', 'accesskey', 'contenteditable']
    })
    const id = 'epub-section-' + i,
      anchors = new Map<string, Element>()
    for (const el of root.querySelectorAll('[id]')) {
      const original = el.id
      if (!anchors.has(original)) anchors.set(original, el)
      el.id = epubAnchor(chapter.href, original)
      el.setAttribute('data-heading-hash', el.id)
    }
    for (const el of root.querySelectorAll('img,image')) {
      const attribute =
        el.localName === 'image' ? (el.hasAttribute('href') ? 'href' : 'xlink:href') : 'src'
      const value = el.getAttribute(attribute) ?? ''
      const location = epubLocation(chapter.href, value)
      const resource = location && input.resources[location.path]
      if (resource) el.setAttribute(attribute, resource)
      else if (!/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);/i.test(value))
        el.removeAttribute(attribute)
      if (el.localName === 'img') {
        el.setAttribute('loading', 'lazy')
        el.setAttribute('decoding', 'async')
      }
      el.removeAttribute('srcset')
    }
    for (const el of root.querySelectorAll('audio,video,source,track')) {
      el.removeAttribute('src')
      el.removeAttribute('autoplay')
      el.setAttribute('preload', 'none')
      const poster = el.getAttribute('poster'),
        location = poster && epubLocation(chapter.href, poster)
      if (location && input.resources[location.path])
        el.setAttribute('poster', input.resources[location.path])
      else el.removeAttribute('poster')
    }
    for (const el of root.querySelectorAll('a[href],use[href],use[xlink\\:href]')) {
      const attribute = el.hasAttribute('href') ? 'href' : 'xlink:href',
        href = el.getAttribute(attribute) ?? ''
      const location = epubLocation(chapter.href, href)
      if (location) el.setAttribute(attribute, '#' + epubAnchor(location.path, location.hash))
      else if (!/^https?:|^mailto:/i.test(href)) el.removeAttribute(attribute)
      el.removeAttribute('target')
      el.removeAttribute('download')
    }
    for (const el of root.querySelectorAll('*'))
      for (const attr of [
        'fill',
        'stroke',
        'clip-path',
        'mask',
        'filter',
        'marker-start',
        'marker-mid',
        'marker-end'
      ]) {
        const value = el.getAttribute(attr)
        if (value?.includes('url(')) {
          const fragment = /^url\(['"]?#([^)'" ]+)['"]?\)$/.exec(value)
          if (fragment) el.setAttribute(attr, 'url(#' + epubAnchor(chapter.href, fragment[1]) + ')')
          else el.removeAttribute(attr)
        }
      }
    const heading = root.querySelector('h1,h2,h3,h4,h5,h6')
    const title = chapter.title || heading?.textContent?.trim() || `第 ${i + 1} 节`
    root.className = 'epub-content'
    root.dataset.epubProjection = 'true'
    root.lang = input.language
    root.dir = /^(ar|fa|he|ur)(-|$)/i.test(input.language) ? 'rtl' : 'auto'
    root.dataset.headingHash = epubAnchor(chapter.href)
    if (!heading) {
      const h = document.createElement('h2')
      h.textContent = title
      root.prepend(h)
    }
    root.firstElementChild?.setAttribute('data-epub-chapter-start', epubAnchor(chapter.href))
    return { chapter, id, root, anchors, title }
  })
  const noteNodes = new Map<Element, { note: NoteRecord; section: (typeof sections)[number] }>()
  for (const section of sections)
    for (const node of section.root.querySelectorAll('[epub\\:type],[role]')) {
      if (
        !typeOf(node).some((type) =>
          ['footnote', 'endnote', 'doc-footnote', 'doc-endnote'].includes(type)
        )
      )
        continue
      const label = String(noteNodes.size + 1)
      noteNodes.set(node, {
        section,
        note: {
          id: 'epub-note-' + label,
          label,
          type: 'original',
          displayMark: label,
          level: 1,
          html: '',
          anchorSpots: [],
          parentIds: [],
          refCount: 0
        }
      })
    }
  let order = 0
  for (const section of sections)
    for (const link of section.root.querySelectorAll('a[href]')) {
      const target = sections
        .flatMap((s) => [...s.anchors.values()])
        .find((el) => '#' + el.id === link.getAttribute('href'))
      if (!target) continue
      let entry =
        noteNodes.get(target) ?? [...noteNodes].find(([node]) => node.contains(target))?.[1]
      if (!entry && !typeOf(link).some((type) => ['noteref', 'doc-noteref'].includes(type)))
        continue
      if (!entry) {
        const owner = sections.find((s) => s.root.contains(target))!,
          node = target.closest('li,aside') ?? target
        const label = String(noteNodes.size + 1)
        entry = {
          section: owner,
          note: {
            id: 'epub-note-' + label,
            label,
            type: 'original',
            displayMark: link.textContent?.trim() || label,
            level: 1,
            html: '',
            anchorSpots: [],
            parentIds: [],
            refCount: 0
          }
        }
        noteNodes.set(node, entry)
      }
      const { note } = entry
      if (!note.refCount) note.displayMark = link.textContent?.trim() || note.displayMark
      note.refCount++
      note.anchorSpots.push({
        kind: 'body',
        sectionId: section.id,
        sectionTitle: section.title,
        order: order++
      })
      const sup = document.createElement('sup')
      sup.className = 'zmu-ref'
      sup.dataset.noteId = note.id
      sup.dataset.level = '1'
      sup.tabIndex = 0
      sup.setAttribute('role', 'button')
      sup.setAttribute('aria-label', '阅读注释 ' + note.displayMark)
      if (link.id) {
        sup.id = link.id
        sup.dataset.headingHash = link.id
      }
      const mark = document.createElement('span')
      mark.className = 'zmu-ref-mark'
      mark.textContent = link.textContent?.trim() || note.displayMark
      sup.append(mark)
      const container =
        link.parentElement?.tagName === 'SUP' &&
        link.parentElement.textContent?.trim() === link.textContent?.trim()
          ? link.parentElement
          : link
      container.replaceWith(sup)
    }
  const notes: NoteRecord[] = []
  for (const [node, { note }] of noteNodes) {
    const holder = document.createElement('div')
    holder.innerHTML = node.innerHTML
    if (!holder.querySelector('p,li,pre,table')) {
      const p = document.createElement('p')
      p.append(...holder.childNodes)
      holder.append(p)
    }
    note.html = holder.innerHTML
    notes.push(note)
    node.remove()
  }
  const toc: ParsedBook['toc'] = [],
    seen = new Set<string>()
  for (const item of input.toc) {
    const location = epubLocation('', item.href),
      section = sections.find((s) => s.chapter.href === location?.path)
    if (!location || !section) continue
    const id = epubAnchor(location.path, location.hash)
    if (seen.has(id)) continue
    seen.add(id)
    const target = location.hash
      ? section.anchors.get(location.hash)
      : section.root.querySelector('h1,h2,h3,h4,h5,h6')
    if (target && section.root.contains(target)) {
      target.setAttribute('data-toc-id', id)
      target.setAttribute('data-heading-hash', id)
    }
    toc.push({ id, title: item.title, level: item.level, sectionId: section.id })
  }
  if (!toc.length)
    for (const section of sections) {
      const id = epubAnchor(section.chapter.href),
        heading = section.root.querySelector('h1,h2,h3,h4,h5,h6')!
      heading.setAttribute('data-toc-id', id)
      heading.setAttribute('data-heading-hash', id)
      toc.push({ id, title: section.title, level: 1, sectionId: section.id })
    }
  let source = '# ' + input.title + '\n\n' + (input.author ? '作者：' + input.author + '\n\n' : '')
  const landmarks: SourceBlock[] = []
  function address(root: HTMLElement, kind: 'section' | 'note', id: string): void {
    searchBlocks(root).forEach((block, index) => {
      if (/^H[1-6]$/.test(block.tagName)) source += '#'.repeat(Number(block.tagName.slice(1))) + ' '
      const text = searchableText(block, true),
        from = source.length,
        key = 'i' + index
      source += text + '\n\n'
      const span = document.createElement('span')
      span.dataset.sourceInline = String(index)
      span.dataset.sourceBlock = key
      span.dataset.sourceFrom = String(from)
      span.dataset.sourceTo = String(from + text.length)
      span.append(...block.childNodes)
      block.append(span)
      landmarks.push({
        kind,
        id,
        key,
        from,
        to: from + text.length,
        tag: block.tagName.toLowerCase(),
        ...(kind === 'note' ? { label: id } : {})
      })
    })
  }
  for (const section of sections) address(section.root, 'section', section.id)
  const bodyChars = sections.reduce(
    (sum, section) => sum + searchableText(section.root, true).length,
    0
  )
  for (const note of notes) {
    source += '\n## 注释 ' + note.displayMark + '\n\n'
    const root = document.createElement('div')
    root.innerHTML = note.html
    root.className = 'epub-note-content'
    root.dataset.epubProjection = 'true'
    address(root, 'note', note.label)
    note.html = root.outerHTML
  }
  return {
    source,
    book: {
      title: input.title,
      toc,
      notes,
      sourceBlocks: landmarks,
      warnings: [],
      sections: sections.map((s) => ({
        id: s.id,
        level: 1,
        title: s.title,
        html: s.root.outerHTML,
        anchorIds: notes
          .filter((n) =>
            n.anchorSpots.some((spot) => spot.kind === 'body' && spot.sectionId === s.id)
          )
          .map((n) => n.id)
      })),
      stats: { chars: bodyChars, noteCount: notes.length, maxLevel: notes.length ? 1 : 0 }
    }
  }
}
