import type { ParsedBook, TocItem } from '../../../shared/types'

export interface ChapterSlice {
  sectionId: string
  from: number
  to: number
}
export interface PanoramaChapter {
  id: string
  title: string
  level: number
  heading?: TocItem
  ancestors: string[]
  children: string[]
  slices: ChapterSlice[]
  noteIds: string[]
  references: number
}

/** Only parser-owned H1–H3 boundaries make chapters. Rendering chunks never do. */
export function panoramaChapters(book: ParsedBook): PanoramaChapter[] {
  const headings = new Map(book.toc.map((item) => [item.id, item]))
  const chapters: PanoramaChapter[] = []
  const stack: PanoramaChapter[] = []
  let current: PanoramaChapter | undefined
  function start(heading?: TocItem): PanoramaChapter {
    const level = heading?.level ?? 0
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    const chapter: PanoramaChapter = {
      id: heading?.id ?? 'panorama-opening',
      title: heading ? heading.title || '无题' : book.toc.length ? '卷首' : book.title || '正文',
      level,
      heading,
      ancestors: heading ? stack.map((parent) => parent.id) : [],
      children: [],
      slices: [],
      noteIds: [],
      references: 0
    }
    if (heading && stack.length) stack[stack.length - 1].children.push(chapter.id)
    if (heading) stack.push(chapter)
    chapters.push(chapter)
    return chapter
  }
  for (const section of book.sections) {
    let from = 0
    // Raw HTML is disabled and code is escaped by the renderer. Only its top-level
    // headings receive this attribute; quoted headings and code cannot divide the book.
    for (const match of section.html.matchAll(/<h[1-3]\b[^>]*\bdata-toc-id="([^"]+)"[^>]*>/g)) {
      const heading = headings.get(match[1])
      if (!heading) continue
      const to = match.index!
      if (to > from && section.html.slice(from, to).trim()) {
        current ??= start()
        current.slices.push({ sectionId: section.id, from, to })
      }
      current = start(heading)
      from = to
    }
    if (section.html.slice(from).trim()) {
      current ??= start()
      current.slices.push({ sectionId: section.id, from, to: section.html.length })
    }
  }
  if (!chapters.length && book.sections.length) {
    start().slices.push({ sectionId: book.sections[0].id, from: 0, to: 0 })
  }
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  const opening = byId.get('panorama-opening')
  const entries = new Map<string, Array<{ id: string; order: number }>>()
  for (const note of book.notes) {
    for (const spot of note.anchorSpots) {
      if (spot.kind !== 'body') continue
      const chapter = (spot.headingId && byId.get(spot.headingId)) || opening
      if (!chapter) continue
      chapter.references++
      if (!entries.has(chapter.id)) entries.set(chapter.id, [])
      entries.get(chapter.id)!.push({ id: note.id, order: spot.order })
    }
  }
  for (const chapter of chapters) {
    chapter.noteIds = [
      ...new Set(
        (entries.get(chapter.id) ?? []).sort((a, b) => a.order - b.order).map((hit) => hit.id)
      )
    ]
  }
  return chapters
}

/** A fixed neighborhood, including both ends; the whole book stays reachable by index. */
export function panoramaWindow<T>(items: T[], index: number, radius = 3): T[] {
  const center = Math.max(0, Math.min(items.length - 1, Math.floor(index)))
  const distance = Math.max(0, Math.floor(radius))
  return items.slice(Math.max(0, center - distance), center + distance + 1)
}

export function panoramaPosition(
  chapters: PanoramaChapter[],
  headingId: string,
  sectionId: string
): number {
  const exact = chapters.findIndex((chapter) => chapter.id === headingId)
  if (exact >= 0) return exact
  const section = chapters.findIndex((chapter) =>
    chapter.slices.some((slice) => slice.sectionId === sectionId)
  )
  return Math.max(0, section)
}
