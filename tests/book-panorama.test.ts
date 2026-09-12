import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import {
  panoramaChapters,
  panoramaPosition,
  panoramaWindow
} from '../src/renderer/src/composables/bookPanorama'

describe('book panorama based on manuscript boundaries', () => {
  it('preserves repeated titles, hierarchy and exact body-reference order', () => {
    const book = parseBook(
      '卷首[^前]。\n\n# 书\n\n总起。\n\n## 同题\n\n第一处[^甲]，再次[^甲]。\n\n### 内页\n\n内页[^乙]。\n\n## 同题\n\n第二处[^甲]。\n\n[^前]: 前言。\n\n[^甲]: 参见[^乙]。\n\n[^乙]: 解释。\n\n[^孤]: 未引用。'
    )
    const before = JSON.stringify(book)
    const chapters = panoramaChapters(book)
    expect(chapters.map((chapter) => chapter.title)).toEqual(['卷首', '书', '同题', '内页', '同题'])
    expect(chapters.map((chapter) => chapter.ancestors)).toEqual([
      [],
      [],
      ['toc-1'],
      ['toc-1', 'toc-2'],
      ['toc-1']
    ])
    expect(chapters[1].children).toEqual(['toc-2', 'toc-4'])
    expect(chapters[2].references).toBe(2)
    expect(chapters[2].noteIds).toEqual([book.notes.find((note) => note.label === '甲')!.id])
    expect(chapters[3].noteIds).toEqual([book.notes.find((note) => note.label === '乙')!.id])
    expect(chapters[4].references).toBe(1)
    expect(panoramaPosition(chapters, 'toc-4', chapters[1].slices[0].sectionId)).toBe(4)
    expect(JSON.stringify(book)).toBe(before)
  })

  it('joins all continuation chunks without manufacturing chapters or losing content', () => {
    const source =
      '# 一部长卷\n\n' +
      Array.from(
        { length: 500 },
        (_, i) => `第${i}段。${'文字延伸到后来的页中。'.repeat(18)}`
      ).join('\n\n') +
      '\n\n## 收束\n\n末段。'
    const book = parseBook(source)
    expect(book.sections.length).toBeGreaterThan(3)
    const chapters = panoramaChapters(book)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].slices.length).toBeGreaterThan(3)
    const sections = new Map(book.sections.map((section) => [section.id, section]))
    expect(
      chapters
        .flatMap((chapter) =>
          chapter.slices.map((slice) =>
            sections.get(slice.sectionId)!.html.slice(slice.from, slice.to)
          )
        )
        .join('')
    ).toBe(book.sections.map((section) => section.html).join(''))
    expect(panoramaPosition(chapters, '', chapters[0].slices.at(-1)!.sectionId)).toBe(0)
  })

  it('ignores quoted, fenced, inline-code and H4 headings as chapter boundaries', () => {
    const book = parseBook(
      '# 开端\n\n> ## 引文里的标题\n\n```html\n<h2 data-toc-id="toc-2">伪装</h2>\n```\n\n`## 代码`\n\n#### 段内小题\n\n## 后来\n\n正文。'
    )
    const chapters = panoramaChapters(book)
    expect(chapters.map((chapter) => chapter.title)).toEqual(['开端', '后来'])
    expect(chapters[0].id).not.toBe(chapters[1].id)
  })

  it('represents an unheaded manuscript as one continuous body and handles an empty book', () => {
    const book = parseBook(
      Array.from({ length: 320 }, () => '没有标题的文字，仍有自己的展开。').join('\n\n')
    )
    expect(book.sections.length).toBeGreaterThan(1)
    const chapters = panoramaChapters(book)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].title).toBe('正文')
    expect(chapters[0].slices).toHaveLength(book.sections.length)
    expect(panoramaChapters(parseBook(''))).toHaveLength(1)
    expect(panoramaChapters({ ...book, sections: [] })).toEqual([])
  })

  it('keeps an authored empty heading separate from an untitled opening', () => {
    const chapters = panoramaChapters(parseBook('卷首。\n\n#\n\n空题之下。\n\n## 收束\n\n末段。'))
    expect(chapters.map((chapter) => chapter.title)).toEqual(['卷首', '无题', '收束'])
    expect(chapters[1].heading?.id).toBe('toc-1')
  })

  it('keeps far chapters reachable with a bounded neighborhood and does not mutate its input', () => {
    const items = Array.from({ length: 1500 }, (_, i) => i)
    expect(panoramaWindow(items, 1499)).toEqual([1496, 1497, 1498, 1499])
    expect(panoramaWindow(items, 710, 2)).toEqual([708, 709, 710, 711, 712])
    expect(panoramaWindow(items, -100)).toEqual([0, 1, 2, 3])
    expect(panoramaWindow([], 0)).toEqual([])
    expect(items).toHaveLength(1500)
  })
})
