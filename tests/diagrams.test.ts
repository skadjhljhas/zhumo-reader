import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'

describe('diagram source and Markdown boundaries', () => {
  it('preserves escaped source and protects apparent notes, math and headings inside the fence', () => {
    const source = 'flowchart LR\n  A["<b>原文</b> & [^假注] $x$"] --> B["# 仍是图中文字"]\n'
    const book = parseBook('# 图解\n\n```mermaid\n' + source + '```\n\n围栏外的文字。')
    expect(book.notes).toHaveLength(0)
    expect(book.toc.map((item) => item.title)).toEqual(['图解'])
    expect(book.sections[0].html).toContain('data-diagram-state="pending"')
    expect(book.sections[0].html).toContain('&lt;b&gt;原文&lt;/b&gt; &amp; [^假注] $x$')
    expect(book.sections[0].html).not.toContain('class="zmu-math')
    expect(book.sections[0].html).toContain('围栏外的文字。')
    expect(book.warnings).toEqual([])
  })
  it('uses the same renderer in nested annotations, including tilde fences and info suffixes', () => {
    const book = parseBook(
      '一句话。[^理由]\n\n[^理由]: 先看关系。[^条件]\n\n    ~~~Mermaid title\n    flowchart LR\n      A[前提] --> B[结论]\n    ~~~\n\n[^条件]: 条件的展开。\n\n    ```mermaid\n    sequenceDiagram\n      读者->>文本: 再读一次\n    ```'
    )
    expect(book.notes).toHaveLength(2)
    for (const note of book.notes) expect(note.html).toContain('class="zmu-diagram"')
    expect(book.notes[1].parentIds).toEqual([book.notes[0].id])
    expect(book.warnings).toEqual([])
  })
  it('keeps quoted Markdown examples, ordinary code and math fences on their own paths', () => {
    const book = parseBook(
      '````markdown\n```mermaid\nflowchart LR\nA --> B\n```\n````\n\n```javascript\nconst mermaid = 1\n```\n\n```math\nx^2+y^2=1\n```\n\n`mermaid`\n'
    )
    const html = book.sections[0].html
    expect(html).not.toContain('class="zmu-diagram"')
    expect(html).toContain('language-markdown')
    expect(html).toContain('language-javascript')
    expect(html).toContain('class="zmu-math')
    expect(html).toContain('<code>mermaid</code>')
  })
  it('keeps malformed Mermaid as complete source for the interactive error fallback', () => {
    const book = parseBook(
      '```mermaid\nnot a diagram "</code></pre><script>example()</script>"\n```'
    )
    expect(book.sections[0].html).toContain('not a diagram &quot;&lt;/code&gt;')
    expect(book.sections[0].html).not.toContain('<script>')
    expect(book.warnings).toEqual([])
  })
})
