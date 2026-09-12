/**
 * Pass C —— 渲染。
 *
 * - markdown-it 实例（html: false）+ KaTeX / MathJax 公式排版
 *   + markdown-it-cjk-friendly（CJK 邻接强调：闭合 ** 前是 CJK 标点、后紧跟
 *   CJK 文字时仍可闭合，修复「段首内嵌式加粗标题」星号字面输出，T9）
 * - 自写 inline rule `zmu_ref`：注册在 `link` 之前（backticks 规则更早，行内代码
 *   中的 `[^x]` 不会被误伤），把 `[^label]` 渲染为
 *   `<sup class="zmu-ref" data-note-id data-level><span class="zmu-ref-mark">作者标号</span></sup>`
 *   （T23：sup 内容从文档序号改为作者标号 displayMark，正文锚点与注内锚点统一；
 *   内层 span 承载超长标号的 CSS 裁切，HTML 转义防 label 注入）
 * - 分章：按 H1 切章；单章超 1.5 万字按 H2 二次切分，仍超按 H3；
 *   全书无 H1–H3 标题时每约 150 段固定切块（title「§N」）
 * - TOC 抽 H1–H3；每条注释体独立 md.render（注内引用同样锚点化）
 */
import MarkdownIt from 'markdown-it'
import { noteRanges } from '../../../shared/note-range'
import type { StateInline, Token } from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import { tex } from '@mdit/plugin-tex'
import { createMathRenderer } from './math'
import { markdownExtensions } from './markdown-extensions'
import { diagramPlaceholder } from './diagram'
import { SourceMapBuilder, type RenderProvenance } from './source-map'
import type { NoteAnchorSpot, Section, TocItem } from '../../../shared/types'
import type { NoteGraph, NoteNode, RenderedBook } from './types'
import { isBlankLine, stripRefMarkers } from './scan'

const SECTION_CHAR_LIMIT = 15000
const PARAGRAPH_CHUNK_SIZE = 150

/* ------------------------------------------------------------------ */
/* 渲染器                                                               */
/* ------------------------------------------------------------------ */

/** ASCII 空白判断（与扫描器的宽松 label 规则保持一致即可） */
function isAsciiSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d)
}

/** HTML 转义（sup 内容与属性值用；标号来自作者 label，可能含 < > " &） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function createRenderer(
  graph: NoteGraph,
  positions?: SourceMapBuilder
): {
  md: InstanceType<typeof MarkdownIt>
  math: ReturnType<typeof createMathRenderer>
} {
  const md = new MarkdownIt({ html: false, linkify: true })
  // One transparent inline container gives selections a stable paragraph/cell
  // identity without wrapping individual glyphs or retaining source maps in DOM.
  const inlineIds = new WeakMap<
    Token[],
    { index: number; map: [number, number] | null; tag: string }
  >()
  const atoms = new WeakMap<Token, string>()
  md.core.ruler.push('zmu_reading_sources', (state) => {
    let index = 0
    const parents: Token[] = []
    state.tokens.forEach((token, tokenIndex) => {
      if (token.nesting < 0) parents.pop()
      if (token.nesting > 0) parents.push(token)
      if (token.type === 'inline' && token.children) {
        inlineIds.set(token.children, {
          index: index++,
          tag: parents.at(-1)?.tag ?? '',
          map: token.map ?? [...parents].reverse().find((parent) => parent.map)?.map ?? null
        })
      }
      if (token.map && ['fence', 'code_block', 'math_block'].includes(token.type))
        atoms.set(token, 'a' + tokenIndex)
    })
  })
  const renderInline = md.renderer.renderInline.bind(md.renderer)
  md.renderer.renderInline = (tokens, options, env) => {
    const html = renderInline(tokens, options, env)
    const info = inlineIds.get(tokens)
    const block = info && positions?.capture(info.map, 'i' + info.index, info.tag)
    return info === undefined
      ? html
      : '<span data-source-inline="' +
          info.index +
          '"' +
          (positions?.attributes(block) ?? '') +
          '>' +
          html +
          '</span>'
  }
  const renderMath = createMathRenderer({ deferred: true })
  md.use(tex, {
    delimiters: 'all',
    mathFence: true,
    render: (source: string, display: boolean) => renderMath(source, display)
  })
  // T9：放宽 CJK 邻接定界符的侧翼判定，让「**标题。**正文」这类
  // 段首内嵌式加粗正常闭合（CommonMark 默认把 CJK 标点当标点，
  // 闭合 ** 前「。」后 CJK 文字不构成 right-flanking → 星号字面输出）。
  // 同一实例同时服务正文与注释体渲染，一处接入全覆盖。
  md.use(cjkFriendly)
  md.use(markdownExtensions)
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index]
    return token.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid'
      ? diagramPlaceholder(token.content)
      : fence(tokens, index, options, env, renderer)
  }
  for (const name of ['fence', 'code_block', 'math_block']) {
    const render = md.renderer.rules[name]!
    md.renderer.rules[name] = (tokens, index, options, env, renderer) => {
      const token = tokens[index],
        key = atoms.get(token)
      const html = render(tokens, index, options, env, renderer)
      return positions && key ? positions.atom(html, token.map, key, token.type) : html
    }
  }

  md.inline.ruler.before('link', 'zmu_ref', (state: StateInline, silent: boolean): boolean => {
    const src = state.src
    const pos = state.pos
    if (pos + 2 >= state.posMax) return false
    if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5e /* ^ */) {
      return false
    }
    let i = pos + 2
    while (i < state.posMax) {
      const code = src.charCodeAt(i)
      if (code === 0x5d /* ] */) break
      if (code === 0x5b /* [ */ || isAsciiSpace(code)) return false
      i++
    }
    if (i >= state.posMax || i === pos + 2) return false // 未闭合或空 label
    const label = src.slice(pos + 2, i)
    const node = graph.byLabel.get(label)
    if (!node) return false // 非本书记录的标记（如代码、示例占位）按普通文本
    if (!silent) {
      const token = state.push('html_inline', '', 0)
      // T23：显示作者标号（displayMark）而非文档序号；内层 span 承载
      // 超长标号的 CSS 裁切（max-width+ellipsis，见 notes.css），可访问名称保留完整标号
      const mark = escapeHtml(node.displayMark)
      token.content = `<sup class="zmu-ref" data-note-id="${node.id}" data-level="${node.level}" tabindex="0" role="button" aria-label="阅读注释 ${mark}"><span class="zmu-ref-mark">${mark}</span></sup>`
    }
    state.pos = i + 1
    return true
  })
  return { md, math: renderMath }
}

/* ------------------------------------------------------------------ */
/* 分章                                                                 */
/* ------------------------------------------------------------------ */

interface HeadingInfo {
  line: number
  level: number
  text: string
}

interface Chunk {
  start: number
  end: number
  level: number
  title: string
  hasHeading: boolean
}

function scanHeadings(md: InstanceType<typeof MarkdownIt>, lines: string[]): HeadingInfo[] {
  const tokens = md.parse(lines.join('\n'), {})
  return tokens.flatMap((token, index) =>
    token.type === 'heading_open' && token.level === 0 && token.map
      ? [
          {
            line: token.map[0],
            level: Number(token.tag.slice(1)),
            text: tokens[index + 1]?.content ?? ''
          }
        ]
      : []
  )
}

/** Top-level Markdown block boundaries never split a list, table, code fence or formula. */
function blockStarts(
  md: InstanceType<typeof MarkdownIt>,
  lines: string[],
  start: number,
  end: number
): number[] {
  const tokens = md.parse(lines.slice(start, end + 1).join('\n'), {})
  return [
    ...new Set(
      tokens
        .filter((token) => token.level === 0 && token.map && token.nesting !== -1)
        .map((token) => start + token.map![0])
    )
  ]
}

function splitLargeChunk(
  md: InstanceType<typeof MarkdownIt>,
  lines: string[],
  chunk: Chunk
): Chunk[] {
  if (countChars(lines, chunk.start, chunk.end) <= 30000) return [chunk]
  const boundaries = blockStarts(md, lines, chunk.start, chunk.end)
  const result: Chunk[] = []
  let start = chunk.start
  for (const boundary of boundaries.slice(1)) {
    if (countChars(lines, start, boundary - 1) < SECTION_CHAR_LIMIT) continue
    result.push({
      ...chunk,
      start,
      end: boundary - 1,
      hasHeading: result.length === 0 && chunk.hasHeading
    })
    start = boundary
  }
  result.push({ ...chunk, start, hasHeading: result.length === 0 && chunk.hasHeading })
  return result
}

function countChars(lines: string[], start: number, end: number): number {
  let n = 0
  for (let i = start; i <= end; i++) n += Array.from(lines[i]).length + 1
  return n
}

/** 去除首尾空行后的行范围；全空返回 null */
function trimRange(
  lines: string[],
  start: number,
  end: number
): { start: number; end: number } | null {
  let s = start
  let e = end
  while (s <= e && isBlankLine(lines[s])) s++
  while (e >= s && isBlankLine(lines[e])) e--
  if (s > e) return null
  return { start: s, end: e }
}

function buildChunks(
  md: InstanceType<typeof MarkdownIt>,
  lines: string[],
  headings: HeadingInfo[]
): Chunk[] {
  const untitled = { n: 0 }

  /** 按指定层级标题切分 range；导语块继承父块标题（无标题则 §N） */
  const splitByLevel = (
    level: number,
    range: { start: number; end: number },
    parent: { level: number; title: string; hasHeading: boolean }
  ): Chunk[] => {
    const marks = headings.filter(
      (h) => h.level === level && h.line >= range.start && h.line <= range.end
    )
    const leadTitle = parent.hasHeading ? parent.title : `§${++untitled.n}`
    const chunks: Chunk[] = []
    if (marks.length === 0) {
      const trimmed = trimRange(lines, range.start, range.end)
      if (!trimmed) return []
      chunks.push({ ...trimmed, level: parent.level, title: leadTitle, hasHeading: false })
      return chunks
    }
    // 标题之前的导语块
    if (marks[0].line > range.start) {
      const trimmed = trimRange(lines, range.start, marks[0].line - 1)
      if (trimmed) {
        chunks.push({ ...trimmed, level: parent.level, title: leadTitle, hasHeading: false })
      }
    }
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].line
      const end = i + 1 < marks.length ? marks[i + 1].line - 1 : range.end
      chunks.push({
        start,
        end,
        level,
        title: stripRefMarkers(marks[i].text),
        hasHeading: true
      })
    }
    return chunks
  }

  const refine = (chunks: Chunk[], level: number): Chunk[] => {
    const out: Chunk[] = []
    for (const c of chunks) {
      if (countChars(lines, c.start, c.end) > SECTION_CHAR_LIMIT) {
        const hasDeeper = headings.some(
          (h) => h.level === level && h.line >= c.start && h.line <= c.end
        )
        if (hasDeeper) {
          out.push(...splitByLevel(level, { start: c.start, end: c.end }, c))
          continue
        }
      }
      out.push(c)
    }
    return out
  }

  if (!headings.some((h) => h.level <= 3)) {
    return chunkByParagraphs(md, lines)
  }
  let chunks = splitByLevel(
    1,
    { start: 0, end: Math.max(0, lines.length - 1) },
    {
      level: 1,
      title: '',
      hasHeading: false
    }
  )
  chunks = refine(chunks, 2)
  chunks = refine(chunks, 3)
  return chunks.flatMap((chunk) => splitLargeChunk(md, lines, chunk))
}

function chunkByParagraphs(md: InstanceType<typeof MarkdownIt>, lines: string[]): Chunk[] {
  const end = Math.max(0, lines.length - 1)
  const boundaries = blockStarts(md, lines, 0, end)
  if (!boundaries.length) return [{ start: 0, end, level: 1, title: '§1', hasHeading: false }]
  const chunks: Chunk[] = []
  let start = 0
  let count = 0
  for (const boundary of boundaries.slice(1)) {
    count++
    if (count < PARAGRAPH_CHUNK_SIZE && countChars(lines, start, boundary - 1) < 30000) continue
    chunks.push({
      start,
      end: boundary - 1,
      level: 1,
      title: `§${chunks.length + 1}`,
      hasHeading: false
    })
    start = boundary
    count = 0
  }
  chunks.push({ start, end, level: 1, title: `§${chunks.length + 1}`, hasHeading: false })
  return chunks
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/** Reading and on-demand source resolution share the same block boundaries. */
export function prepareBookRendering(
  bodyLines: string[],
  graph: NoteGraph,
  positions?: SourceMapBuilder
): {
  md: InstanceType<typeof MarkdownIt>
  math: ReturnType<typeof createMathRenderer>
  headings: HeadingInfo[]
  chunks: Chunk[]
} {
  const { md, math } = createRenderer(graph, positions)
  const headings = scanHeadings(md, bodyLines)
  const chunks = buildChunks(md, bodyLines, headings)
  return { md, math, headings, chunks }
}

export function renderBook(
  bodyLines: string[],
  graph: NoteGraph,
  provenance?: RenderProvenance
): RenderedBook {
  const positions = provenance ? new SourceMapBuilder(provenance.offset) : undefined
  const { md, math, headings, chunks } = prepareBookRendering(bodyLines, graph, positions)
  const documentHeadings = headings
    .map((heading, index) => ({
      ...heading,
      id: `toc-${index + 1}`,
      title: stripRefMarkers(heading.text)
    }))
    .filter((heading) => heading.level <= 3)
  const headingByLine = new Map(documentHeadings.map((heading) => [heading.line, heading]))
  let bodyStart: number | undefined
  md.renderer.rules.heading_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index]
    if (bodyStart !== undefined && token.level === 0 && token.map) {
      const heading = headingByLine.get(bodyStart + token.map[0])
      if (heading) token.attrSet('data-toc-id', heading.id)
    }
    return renderer.renderToken(tokens, index, options)
  }
  const headingOfLine = (line: number): (typeof documentHeadings)[number] | undefined => {
    let low = 0,
      high = documentHeadings.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (documentHeadings[middle].line <= line) low = middle + 1
      else high = middle
    }
    return documentHeadings[low - 1]
  }
  const renderEnv = {}
  // Reference-style links defined in another chunk remain available throughout the book.
  const bodyTokens = md.parse(bodyLines.join('\n'), renderEnv)
  const visibleLines = new Set<number>()
  for (const token of bodyTokens)
    if (token.map) for (let line = token.map[0]; line < token.map[1]; line++) visibleLines.add(line)
  const refs = (renderEnv as { references?: Record<string, { href?: string }> }).references ?? {}
  const selectionMetadataChars = bodyLines.reduce((sum, line, index) => {
    const match = /^\[([Zz][Hh][Uu][Mm][Oo]-[Rr][Aa][Nn][Gg][Ee]-[^\]]+)\]:/.exec(line)
    return !visibleLines.has(index) &&
      match &&
      refs[match[1].toUpperCase()]?.href === 'zhumo-range:v1'
      ? sum + Array.from(line).length
      : sum
  }, 0)

  // 行号 -> 章下标
  const sectionOfLine = new Array<number>(bodyLines.length).fill(-1)
  chunks.forEach((c, idx) => {
    for (let i = c.start; i <= c.end; i++) sectionOfLine[i] = idx
  })
  const sectionIdOfLine = (line: number): string => {
    const idx = sectionOfLine[line] >= 0 ? sectionOfLine[line] : chunks.length - 1
    return `sec-${Math.max(0, idx) + 1}`
  }
  /** 行号 -> 章标题（T23 引用地图 body spot 的「见于·〈章名〉」） */
  const sectionTitleOfLine = (line: number): string => {
    const idx = sectionOfLine[line] >= 0 ? sectionOfLine[line] : chunks.length - 1
    return chunks[Math.max(0, idx)]?.title ?? ''
  }

  // 全部正文命中（按 order 升序）
  const allHits: Array<{ line: number; order: number; node: NoteNode }> = []
  for (const node of graph.nodes) {
    for (const hit of node.bodyHits) allHits.push({ ...hit, node })
  }
  allHits.sort((a, b) => a.order - b.order)

  const sections: Section[] = chunks.map((c, idx) => {
    const trimmed = trimRange(bodyLines, c.start, c.end)
    bodyStart = trimmed?.start
    const src = trimmed ? bodyLines.slice(trimmed.start, trimmed.end + 1).join('\n') : ''
    if (positions && provenance)
      positions.scope = {
        kind: 'section',
        id: 'sec-' + (idx + 1),
        lines: trimmed ? provenance.body.slice(trimmed.start, trimmed.end + 1) : []
      }
    const anchorIds: string[] = []
    const seen = new Set<string>()
    for (const hit of allHits) {
      if (hit.line >= c.start && hit.line <= c.end && !seen.has(hit.node.id)) {
        seen.add(hit.node.id)
        anchorIds.push(hit.node.id)
      }
    }
    return {
      id: `sec-${idx + 1}`,
      level: c.level,
      title: c.title,
      html: md.render(src, renderEnv),
      anchorIds
    }
  })

  bodyStart = undefined
  const toc: TocItem[] = []
  headings.forEach((h, i) => {
    if (h.level > 3) return
    toc.push({
      id: `toc-${i + 1}`,
      level: h.level,
      title: stripRefMarkers(h.text),
      sectionId: sectionIdOfLine(h.line)
    })
  })

  const firstH1 = headings.find((h) => h.level === 1)
  const title = firstH1 ? stripRefMarkers(firstH1.text) : ''

  const noteHtml = new Map<string, string>()
  const anchorSpots = new Map<string, NoteAnchorSpot[]>()
  for (const node of graph.nodes) {
    if (positions && provenance) {
      const source = provenance.notes.get(node.label)
      positions.scope = { kind: 'note', id: node.id, label: node.label, lines: source?.lines ?? [] }
      if (source) positions.region(source.from, source.to)
    }
    noteHtml.set(node.label, node.hasDef ? md.render(node.contentLines.join('\n'), renderEnv) : '')
    // T23 引用地图：正文引用带章标题（「见于·〈章名〉」），注内引用带父注身份
    // （「注于·〈父注标号〉」）；正文在前按 order 升序，注内随其后按父注文档序
    const bodySpots = node.bodyHits.map((hit) => ({
      kind: 'body' as const,
      sectionId: sectionIdOfLine(hit.line),
      order: hit.order,
      sectionTitle: headingOfLine(hit.line)?.title ?? sectionTitleOfLine(hit.line),
      headingId: headingOfLine(hit.line)?.id
    }))
    const noteSpots = node.parents
      .map((p) => graph.byLabel.get(p))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => a.number - b.number)
      .map((p) => {
        const spot: NoteAnchorSpot = {
          kind: 'note',
          parentNoteId: p.id,
          parentDisplayMark: p.displayMark
        }
        if (p.typeLabel) spot.parentTypeLabel = p.typeLabel
        return spot
      })
    anchorSpots.set(node.label, [...bodySpots, ...noteSpots])
  }

  const finalize = (html: string): string =>
    positions ? positions.finalize(math.finalize(html)) : math.finalize(html)
  for (const section of sections) section.html = finalize(section.html)
  for (const [label, html] of noteHtml) noteHtml.set(label, finalize(html))
  return {
    title,
    selectionMetadataChars,
    selectionRanges: noteRanges((renderEnv as { references?: unknown }).references),
    toc,
    sections,
    noteHtml,
    anchorSpots,
    ...(positions ? { sourceBlocks: positions.blocks } : {})
  }
}
