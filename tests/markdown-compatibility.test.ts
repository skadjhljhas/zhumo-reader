import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
const body = (source: string): string =>
  parseBook(source)
    .sections.map((s) => s.html)
    .join('\n')
describe('Markdown and mathematical reading compatibility', () => {
  it('supports a nested GFM task list without changing checked-looking prose or code', () => {
    const html = body(
      '# Tasks\n\n- [x] 完成 **推导**\n  - [ ] 核对 $x^2$\n\n正文 [x] 不是任务。\n\n`- [x] source`'
    )
    expect(html.match(/class="zmu-task-checkbox"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="已完成" checked')
    expect(html).toContain('正文 [x] 不是任务。')
    expect(html).toContain('<code>- [x] source</code>')
  })
  it('renders tables, escaped pipes, strikethrough, nested lists, CJK emphasis, autolinks and references', () => {
    const html = body(
      '# 书\n\n| 名称 | 内容 |\n| :--- | ---: |\n| a\\|b | **中文。**接续 $x^2$ |\n\n~~旧说~~ https://example.org/read\n\n> 引用\n>\n> 1. 第一项\n>    - 嵌套\n\n[出处][ref]\n\n[ref]: https://example.org/source "原始材料"'
    )
    for (const fragment of [
      '<table>',
      'a|b',
      '<strong>中文。</strong>',
      '<s>旧说</s>',
      'href="https://example.org/read"',
      '<blockquote>',
      '<ol>',
      '<ul>',
      'title="原始材料"'
    ])
      expect(html).toContain(fragment)
  })
  it.each(['equation', 'equation*', 'align', 'align*', 'gather', 'multline', 'eqnarray'])(
    'renders a complete bare %s environment',
    (env) => {
      const html = body('# Math\n\n\\begin{' + env + '}\nx^2 = 1\n\\end{' + env + '}\n\n下一段。')
      expect(html).toContain('data-math-engine=')
      expect(html).not.toContain('data-math-error')
      expect(html).toContain('下一段。')
    }
  )
  it('recognizes nested complete environments, formula notes and a later equation reference', () => {
    const book = parseBook(String.raw`# 场
参见 $\eqref{cases}$。[^a]

\begin{equation}
f(x)=\begin{cases}x & x\geq0\\-x&x<0\end{cases}\label{cases}
\end{equation}

[^a]: \(\left\langle x,y\right\rangle\)
`)
    expect(book.sections[0].html).toContain('#mjx-eqn%3Acases')
    expect(book.sections[0].html).toContain('id="mjx-eqn:cases"')
    expect(book.notes[0].html).toContain('data-math-engine=')
  })
  it.each([
    String.raw`\dfrac{1}{1+\cfrac{1}{x}}`,
    String.raw`\left.\frac{d}{dx}f(x)\right|_{x=0}`,
    String.raw`\begin{alignedat}{2}a&=b+c&\qquad d&=e+f\\x&=y&z&=w\end{alignedat}`,
    String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`,
    String.raw`\qty(\dv{f}{x})`,
    String.raw`\newcommand{\pair}[2]{\left\langle #1,#2\right\rangle}\pair{x}{y}`,
    String.raw`\overset{\mathrm{def}}{=}\quad\underbrace{a+\cdots+a}_{n\text{ 次}}`
  ])('accepts extended TeX %s', (tex) => {
    const html = body('# TeX\n\n\\[\n' + tex + '\n\\]')
    expect(html).toContain('data-math-engine=')
    expect(html).not.toContain('data-math-error')
  })
  it('keeps incomplete or mismatched environments readable and never consumes following chapters', () => {
    const html = body('# Before\n\n\\begin{align}\na&=b\n\\end{gather}\n\n# After\n\n完整保留。')
    expect(html).toContain('完整保留。')
    expect(html).toContain('begin{align}')
  })
  it('preserves math-looking code, literal HTML, money, escapes and unknown TeX without execution', () => {
    const html = body(
      '# Safe\n\n```tex\n\\begin{align}x=y\\end{align}\n```\n\nPrice $5 and $10.\n\n<script>alert(1)</script>\n\n$\\notACommand{x}$'
    )
    expect(html).toContain('language-tex')
    expect(html).toContain('Price $5 and $10.')
    expect(html).not.toContain('<script>')
    expect(html).toContain('data-math-error="true"')
  })
})
