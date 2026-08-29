/**
 * Pass C —— 渲染。
 *
 * - markdown-it 实例（html: false）+ @mdit/plugin-katex（$...$ 与 $$...$$）
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
import type { StateInline } from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import { katex } from '@mdit/plugin-katex'
import type { NoteAnchorSpot, Section, TocItem } from '../../../shared/types'
import type { NoteGraph, NoteNode, RenderedBook } from './types'
import {
  indentOf,
  isBlankLine,
  isFenceClose,
  matchFenceOpen,
  matchHeading,
  stripRefMarkers,
  type FenceInfo
} from './scan'

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

function createRenderer(graph: NoteGraph): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: false })
  md.use(katex, { logger: (): 'ignore' => 'ignore' })
  // T9：放宽 CJK 邻接定界符的侧翼判定，让「**标题。**正文」这类
  // 段首内嵌式加粗正常闭合（CommonMark 默认把 CJK 标点当标点，
  // 闭合 ** 前「。」后 CJK 文字不构成 right-flanking → 星号字面输出）。
  // 同一实例同时服务正文与注释体渲染，一处接入全覆盖。
  md.use(cjkFriendly)

  md.inline.ruler.before(
    'link',
    'zmu_ref',
    (state: StateInline, silent: boolean): boolean => {
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
        // 超长标号的 CSS 裁切（max-width+ellipsis，见 notes.css），title 提供全文
        const mark = escapeHtml(node.displayMark)
        token.content = `<sup class="zmu-ref" data-note-id="${node.id}" data-level="${node.level}" title="${mark}"><span class="zmu-ref-mark">${mark}</span></sup>`
      }
      state.pos = i + 1
      return true
    }
  )
  return md
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

function scanHeadings(lines: string[]): HeadingInfo[] {
  const result: HeadingInfo[] = []
  let fence: FenceInfo | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      if (isFenceClose(line, fence)) fence = null
      continue
    }
    if (isBlankLine(line) || indentOf(line) >= 4) continue
    const fo = matchFenceOpen(line)
    if (fo) {
      fence = fo
      continue
    }
    const h = matchHeading(line)
    if (h) result.push({ line: i, level: h.level, text: h.text })
  }
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

function buildChunks(lines: string[], headings: HeadingInfo[]): Chunk[] {
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
    return chunkByParagraphs(lines)
  }
  let chunks = splitByLevel(1, { start: 0, end: Math.max(0, lines.length - 1) }, {
    level: 1,
    title: '',
    hasHeading: false
  })
  chunks = refine(chunks, 2)
  chunks = refine(chunks, 3)
  return chunks
}

function chunkByParagraphs(lines: string[]): Chunk[] {
  const paras: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < lines.length) {
    if (isBlankLine(lines[i])) {
      i++
      continue
    }
    const start = i
    while (i < lines.length && !isBlankLine(lines[i])) i++
    paras.push({ start, end: i - 1 })
  }
  if (paras.length === 0) {
    return [{ start: 0, end: Math.max(0, lines.length - 1), level: 1, title: '§1', hasHeading: false }]
  }
  const chunks: Chunk[] = []
  for (let p = 0; p < paras.length; p += PARAGRAPH_CHUNK_SIZE) {
    const group = paras.slice(p, p + PARAGRAPH_CHUNK_SIZE)
    chunks.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      level: 1,
      title: `§${chunks.length + 1}`,
      hasHeading: false
    })
  }
  return chunks
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

export function renderBook(bodyLines: string[], graph: NoteGraph): RenderedBook {
  const md = createRenderer(graph)
  const headings = scanHeadings(bodyLines)
  const chunks = buildChunks(bodyLines, headings)

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
    const src = trimmed ? bodyLines.slice(trimmed.start, trimmed.end + 1).join('\n') : ''
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
      html: md.render(src),
      anchorIds
    }
  })

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
    noteHtml.set(
      node.label,
      node.hasDef ? md.render(node.contentLines.join('\n')) : ''
    )
    // T23 引用地图：正文引用带章标题（「见于·〈章名〉」），注内引用带父注身份
    // （「注于·〈父注标号〉」）；正文在前按 order 升序，注内随其后按父注文档序
    const bodySpots = node.bodyHits.map((hit) => ({
      kind: 'body' as const,
      sectionId: sectionIdOfLine(hit.line),
      order: hit.order,
      sectionTitle: sectionTitleOfLine(hit.line)
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

  return { title, toc, sections, noteHtml, anchorSpots }
}
