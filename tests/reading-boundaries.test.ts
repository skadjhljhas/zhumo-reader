import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'

describe('mathematics and note scanning stay separate', () => {
  it.each([
    String.raw`$\text{[^ghost] [注1] 【注2】 ^[inline]}$`,
    String.raw`\(\text{[^ghost] [注1] 【注2】 ^[inline]}\)`,
    String.raw`$$
\text{[^ghost] [注1] 【注2】 ^[inline]}
$$`,
    String.raw`\[
\text{[^ghost] [注1] 【注2】 ^[inline]}
\]`
  ])('does not create phantom notes inside %s', (math) => {
    const book = parseBook(`# 数学\n\n${math}\n\n正文[^real]\n\n[^real]: 真实注释`)
    expect(book.notes.map((note) => note.label)).toEqual(['real'])
    expect(book.warnings).toEqual([])
    expect(book.sections.map((section) => section.html).join('')).toContain('[^ghost]')
  })
  it('keeps multiline formula content from becoming a note definition or a heading', () => {
    const book = parseBook(String.raw`# 真正标题

$$
[^ghost]: \text{literal}
# phantom
$$

正文[^real]

[^real]: 注释`)
    expect(book.toc.map((item) => item.title)).toEqual(['真正标题'])
    expect(book.notes.map((note) => note.label)).toEqual(['real'])
    expect(book.sections[0].html).toContain('[^ghost]')
  })
  it('protects a formula within an inline note without swallowing its closing bracket', () => {
    const book = parseBook(String.raw`正文^[公式 $\text{[注1]}$ 完毕] 后续[^real]

[^real]: 真注释`)
    expect(book.notes).toHaveLength(2)
    expect(book.notes[0].html).toContain('data-math-source')
    expect(book.sections[0].html).toContain('后续')
    expect(book.notes[1].label).toBe('real')
  })
  it('does not interpret a dollar sign in code as the start of a later formula', () => {
    const book = parseBook(
      '`$` 正文[^a] 文本 $x^2$\n\n```\n$$\n```\n\n正文[^b]\n\n[^a]: 甲\n\n[^b]: 乙'
    )
    expect(book.notes.map((note) => note.label)).toEqual(['a', 'b'])
    expect(book.notes.every((note) => note.refCount === 1)).toBe(true)
  })
  it('leaves literal escaped dollars and private-use characters intact', () => {
    const book = parseBook(String.raw`价格 \$30，正文[^a]。` + '\ue000\ue001\n\n[^a]: 注释')
    expect(book.notes[0].label).toBe('a')
    expect(book.sections[0].html).toContain('\ue000\ue001')
  })
})

describe('safe document chunks', () => {
  it('divides a long single-heading essay without losing text or reference-style links', () => {
    const paragraphs = Array.from(
      { length: 800 },
      (_, index) => `段落${index} ${'长文内容。'.repeat(25)} [参考][source]`
    )
    const book = parseBook(
      '# 长篇\n\n' + paragraphs.join('\n\n') + '\n\n[source]: https://example.com/source'
    )
    expect(book.sections.length).toBeGreaterThan(4)
    expect(book.sections.every((section) => section.html.length < 30000)).toBe(true)
    const html = book.sections.map((section) => section.html).join('')
    expect(html.match(/href="https:\/\/example.com\/source"/g)).toHaveLength(800)
    for (let index = 0; index < 800; index++) expect(html).toContain(`段落${index} `)
    expect(book.toc).toHaveLength(1)
  })
  it('does not divide a fenced code block containing hundreds of blank lines', () => {
    const code = Array.from({ length: 350 }, (_, index) => `const n${index} = ${index};`).join(
      '\n\n'
    )
    const book = parseBook('```js\n' + code + '\n```\n\n后文。')
    const html = book.sections.map((section) => section.html).join('')
    expect(html.match(/<pre>/g)).toHaveLength(1)
    expect(html).toContain('const n349 = 349;')
    expect(html).toContain('<p><span data-source-inline="0">后文。</span></p>')
  })
  it('recognizes a setext title using Markdown block parsing', () => {
    const book = parseBook('书名\n====\n\n正文\n\n章节\n----\n\n内容')
    expect(book.title).toBe('书名')
    expect(book.toc.map((item) => item.title)).toEqual(['书名', '章节'])
  })
})
