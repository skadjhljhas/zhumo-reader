import type { ParsedBook } from '../../../shared/types'
import type { PanoramaChapter } from './bookPanorama'
import { searchBlocks, searchableText } from './searchText'

export interface ChapterMeasure {
  chars: number
  excerpt: string
}

/** Short-lived DOM projections: no extra full-book tree is retained or mounted. */
export function createPanoramaProjection(book: ParsedBook): {
  measure: (chapter: PanoramaChapter) => ChapterMeasure
  preview: (chapter: PanoramaChapter) => { html: string; abbreviated: boolean }
} {
  const sections = new Map(book.sections.map((section) => [section.id, section]))
  function fragment(chapter: PanoramaChapter, index: number): DocumentFragment {
    const slice = chapter.slices[index]
    const template = document.createElement('template')
    template.innerHTML = sections.get(slice.sectionId)!.html.slice(slice.from, slice.to)
    return template.content
  }
  return {
    measure(chapter) {
      let chars = 0,
        excerpt = ''
      chapter.slices.forEach((_, index) => {
        const root = fragment(chapter, index)
        root.querySelectorAll('[data-toc-id],.zmu-ref').forEach((node) => node.remove())
        const box = document.createElement('div')
        box.append(root)
        const text = searchableText(box).replace(/\s+/g, ' ').trim()
        chars += Array.from(text.replace(/\s/g, '')).length
        if (excerpt.length < 180)
          excerpt += (excerpt ? ' ' : '') + text.slice(0, 180 - excerpt.length)
      })
      return { chars, excerpt }
    },
    preview(chapter) {
      const result = document.createElement('div')
      let remaining = 7,
        abbreviated = false
      for (let i = 0; i < chapter.slices.length; i++) {
        const root = fragment(chapter, i)
        root.querySelectorAll('[data-toc-id]').forEach((node) => node.remove())
        const blocks = searchBlocks(root)
        if (blocks.length > remaining) {
          const range = document.createRange()
          range.selectNodeContents(root)
          range.setEndAfter(blocks[remaining - 1])
          result.append(range.cloneContents())
          abbreviated = true
          break
        }
        result.append(root)
        remaining -= blocks.length
        if (remaining <= 0) {
          abbreviated = i < chapter.slices.length - 1
          break
        }
      }
      // An extremely large single paragraph/code block is represented by its beginning.
      // Ordinary prose and formulas keep their complete rendered structure.
      for (const block of searchBlocks(result)) {
        if (
          (block.textContent?.length ?? 0) > 6000 &&
          !block.matches('.zmu-diagram') &&
          !block.querySelector('.zmu-math')
        ) {
          block.textContent = block.textContent!.slice(0, 6000) + '…'
          abbreviated = true
        }
      }
      result.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
      return { html: result.innerHTML, abbreviated }
    }
  }
}
