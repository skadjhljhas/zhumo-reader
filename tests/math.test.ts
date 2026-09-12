import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import { createMathRenderer } from '../src/renderer/src/parser/math'
describe('Extended mathematics', () => {
  it('renders dollar, bracket, math fences and notes without changing code', () => {
    const source =
      String.raw`# Math
Inline $x^2$ and \(y^2\).[^a]

\[
\begin{aligned}a&=b\\c&=d\end{aligned}
\]

` +
      '```math\n\\frac{a}{b}\n```\n\n' +
      '`$unrendered$`\n\n[^a]: ' +
      String.raw`\(e^{i\pi}+1=0\)`
    const book = parseBook(source),
      html = book.sections.map((s) => s.html).join('')
    expect((html.match(/data-math-engine="katex"/g) ?? []).length).toBe(4)
    expect(book.notes[0].html).toContain('data-math-engine="katex"')
    expect(html).toContain('<code>$unrendered$</code>')
  })
  it.each([
    String.raw`\ce{2H2 + O2 -> 2H2O}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\int_0^\infty e^{-x}\,dx`
  ])('renders %s using the fast engine', (formula) => {
    expect(createMathRenderer()(formula, true)).toContain('data-math-engine="katex"')
  })
  it.each([
    String.raw`\pdv[2]{f}{x}`,
    String.raw`\begin{CD} A @>f>> B \\ @VgVV @VVhV \\ C @>>k> D \end{CD}`,
    String.raw`\begin{numcases}{f(x)=} x & $x>0$ \\ -x & $x<0$ \end{numcases}`
  ])('uses SVG fallback for %s', (formula) => {
    const html = createMathRenderer()(formula, true)
    expect(html).toMatch(/data-math-engine="(mathjax|katex)"/)
    expect(html).toContain('<svg')
    expect(html).not.toContain('data-math-error')
  })
  it('keeps macros within one book, across sections and notes', () => {
    const render = createMathRenderer()
    render(String.raw`\gdef\RR{\mathbb{R}}`, false)
    expect(render(String.raw`x\in\RR`, false)).toContain('data-math-engine="katex"')
    expect(createMathRenderer()(String.raw`x\in\RR`, false)).toContain('data-math-error')
  })
  it('retains unsupported source and prevents markup injection', () => {
    const html = createMathRenderer()(String.raw`\notACommand{<img src=x onerror="attack">}`, true)
    expect(html).toContain('data-math-error')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
  it('does not enable HTML extensions or network loading', () => {
    const render = createMathRenderer()
    for (const formula of [
      String.raw`\require{html}`,
      String.raw`\class{unsafe}{x}`,
      String.raw`\htmlStyle{position:fixed}{x}`
    ]) {
      expect(render(formula, false)).toContain('data-math-error')
    }
  })
  it('resolves forward equation references across sections and into annotations', () => {
    const book = parseBook(String.raw`# First
See $\eqref{energy}$ and $\eqref{in-note}$.[^a]

# Later
\[
\begin{equation}E=mc^2\label{energy}\end{equation}
\]

[^a]: The second equation:

    \[
    \begin{equation}a=b\label{in-note}\end{equation}
    \]
`)
    expect(book.sections[0].html).toContain('#mjx-eqn%3Aenergy')
    expect(book.sections[0].html).toContain('#mjx-eqn%3Ain-note')
    expect(book.sections[0].html).not.toContain('data-c="3F"')
    expect(book.notes[0].html).toContain('id="mjx-eqn:in-note"')
  })
  it('numbers repeated automatic equations independently', () => {
    const equation = String.raw`\[\begin{equation}x=y\end{equation}\]`
    const html = parseBook(`# Numbers\n\n${equation}\n\n${equation}`).sections[0].html
    const ids = [...html.matchAll(/id="mjx-eqn:([^"]+)"/g)].map((match) => match[1])
    expect(ids).toEqual(['1', '2'])
  })
  it('does not reuse an unresolved reference after its label is defined', () => {
    const book = parseBook(String.raw`# References
$\eqref{same}$

\[\begin{equation}x=y\label{same}\end{equation}\]

$\eqref{same}$
`)
    expect(book.sections[0].html.match(/#mjx-eqn%3Asame/g)).toHaveLength(2)
  })
  it('does not cache numbered environments hidden inside custom commands', () => {
    const book = parseBook(String.raw`# Commands
$\newcommand{\numbered}{\begin{equation}x=y\end{equation}}$

\[\numbered\]

\[\numbered\]
`)
    const ids = [...book.sections[0].html.matchAll(/id="mjx-eqn:([^"]+)"/g)].map(
      (match) => match[1]
    )
    expect(ids).toEqual(['1', '2'])
  })
  it('resolves a forward reference without applying later macro redefinitions to earlier text', () => {
    const book = parseBook(String.raw`# Meaning in order
$\newcommand{\letter}{\mathrm{a}}$

$\eqref{later}+\letter$

$\renewcommand{\letter}{\mathrm{b}}$

$\eqref{later}+\letter$

\[\begin{equation}x=y\label{later}\end{equation}\]
`)
    expect(book.sections[0].html.match(/data-c="61"/g)).toHaveLength(1)
    expect(book.sections[0].html.match(/data-c="62"/g)).toHaveLength(1)
    expect(book.sections[0].html.match(/#mjx-eqn%3Alater/g)).toHaveLength(2)
  })
  it('retains malformed deferred source while later equations still render', () => {
    const book = parseBook(String.raw`# A damaged expression
\[\notACommand{<img src=x onerror="attack">}\]

\[\begin{equation}x=y\label{safe}\end{equation}\]
`)
    expect(book.sections[0].html).toContain('data-math-error="true"')
    expect(book.sections[0].html).toContain('id="mjx-eqn:safe"')
    expect(book.sections[0].html).not.toContain('<img')
    expect(book.sections[0].html).not.toContain('zmu-math-slot')
  })
})

it('recognizes a UTF-8 BOM heading without changing the input', () => {
  const source = '\uFEFF# 中文标题\r\n\r\n正文'
  const book = parseBook(source)
  expect(book.title).toBe('中文标题')
  expect(book.toc[0].title).toBe('中文标题')
  expect(book.warnings).toEqual([])
})
