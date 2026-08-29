/**
 * Pass A —— 归一与扫描。
 *
 * 行状态机处理原始文本，产出三样东西：
 *   1. 净化正文（定义区已移除；`[注N]`/`【注N】` 已归一为 `[^注N]`；行内注 `^[...]`
 *      已折叠为 `[^auto-N]` 占位并抽出定义）
 *   2. 定义集合（GFM 定义行、`注N:` 定义行、行内注自动定义；首行 + 4 空格缩进续行，
 *      支持多段落）
 *   3. 正文引用位置表 + 注内引用表
 *
 * 代码保护：fenced code block（``` / ~~~）、indented code block（4 空格）、
 * 行内 code span（反引号）中的任何「类注释」写法都原样保留、不参与归一。
 */
import type { ParseWarning } from '../../../shared/types'
import type { BodyRefHit, NoteRefHit, PreprocessResult, RawDefinition } from './types'
import {
  createTextTokenRegex,
  indentOf,
  isBlankLine,
  isFenceClose,
  matchDefStart,
  matchFenceOpen,
  splitCodeSpans,
  stripIndent,
  type FenceInfo
} from './scan'

/** 行内注跨行上限：超过则强制闭合（未闭合的 ^[ 会把后续正文成片吞入注内） */
const MAX_INLINE_NOTE_LINES = 50

/* ------------------------------------------------------------------ */
/* 流式重写器                                                           */
/* ------------------------------------------------------------------ */

interface RewriterHooks {
  /** 文本中识别到一次注释引用（label 已归一，如 `译者:序1` / `注1` / `auto-2`） */
  onRef(label: string): void
  /** 行内注闭合：注册定义并返回归一 label */
  createAutoNote(content: string): string
}

/**
 * 把一段文本流（正文或某条注释体）重写为归一形式：
 * - 代码 span 原样透传；
 * - `[注N]` / `【注N】` → `[^注N]` 并记录引用；
 * - `[^label]` 透传并记录引用；
 * - `^[...]` 行内注（可跨行，括号深度配对，代码段不参与配对）折叠为 `[^auto-N]`。
 */
class StreamRewriter {
  private out: string[] = []
  private cur = ''
  private note: { buf: string; depth: number } | null = null

  constructor(private readonly hooks: RewriterHooks) {}

  hasOpenNote(): boolean {
    return this.note !== null
  }

  /** 当前未落盘输出行的行号（即 cur 最终落入 out 的下标） */
  get currentLineIndex(): number {
    return this.out.length
  }

  /** 处理一行普通文本（含行尾换行语义） */
  feedTextLine(line: string): void {
    if (this.note) {
      this.scanNoteText(line)
    } else {
      this.feedCore(line)
    }
    this.endLine()
  }

  /** 原样透传一行（代码行）。若行内注未闭合则并入注内容（防御路径）；
   *  行内注刚被抢断闭合时当前行尚未落盘（跨行注的正文前缀悬在 cur），
   *  先落盘悬行再透传，保证行序不乱（M4 场景：^…^[ 后跟围栏）。 */
  emitRaw(line: string): void {
    if (this.note) {
      this.scanNoteText(line)
      this.endLine()
      return
    }
    if (this.cur !== '') {
      this.out.push(this.cur)
      this.cur = ''
    }
    this.out.push(line)
  }

  /** 强制闭合当前行内注（定义行抢占 / 流结束时调用） */
  closeOpenNote(): void {
    if (!this.note) return
    const content = this.note.buf.replace(/\n+$/, '')
    this.note = null
    const label = this.hooks.createAutoNote(content)
    this.hooks.onRef(label)
    this.cur += `[^${label}]`
  }

  /** 输入流结束：闭合未完的行内注，落盘残余行 */
  finish(): string[] {
    if (this.note) this.closeOpenNote()
    if (this.cur !== '') {
      this.out.push(this.cur)
      this.cur = ''
    }
    return this.out
  }

  private endLine(): void {
    if (this.note) {
      this.note.buf += '\n'
    } else {
      this.out.push(this.cur)
      this.cur = ''
    }
  }

  private feedCore(text: string): void {
    for (const seg of splitCodeSpans(text)) {
      // 行内注开启期间：代码段与文本段统一交给注内容扫描（代码原样入注）
      if (this.note) {
        this.scanNoteText(seg.text)
        continue
      }
      if (seg.code) {
        this.cur += seg.text
      } else {
        this.scanTextSegment(seg.text)
      }
    }
  }

  private scanTextSegment(text: string): void {
    const re = createTextTokenRegex()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      this.cur += text.slice(last, m.index)
      if (m[1] !== undefined) {
        this.hooks.onRef(m[1])
        this.cur += m[0]
      } else if (m[2] !== undefined) {
        const label = `注${m[2]}`
        this.hooks.onRef(label)
        this.cur += `[^${label}]`
      } else {
        // `^[` 行内注开头，其后内容进入注缓冲
        this.note = { buf: '', depth: 1 }
        this.scanNoteText(text.slice(m.index + 2))
        return
      }
      last = m.index + m[0].length
    }
    this.cur += text.slice(last)
  }

  /** 行内注内容扫描：代码段原样入注；文本段做括号深度配对 */
  private scanNoteText(text: string): void {
    for (const seg of splitCodeSpans(text)) {
      if (!this.note) {
        this.feedCore(seg.text)
        continue
      }
      if (seg.code) {
        this.note.buf += seg.text
        continue
      }
      const s = seg.text
      let i = 0
      while (i < s.length && this.note) {
        const ch = s[i]
        if (ch === '[') {
          this.note.depth++
          this.note.buf += ch
          i++
        } else if (ch === ']') {
          this.note.depth--
          if (this.note.depth <= 0) {
            this.closeOpenNote()
            this.feedCore(s.slice(i + 1))
            break
          }
          this.note.buf += ch
          i++
        } else {
          this.note.buf += ch
          i++
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

export function preprocess(source: string): PreprocessResult {
  const rawLines = source.split(/\r\n|\r|\n/)
  const definitions: RawDefinition[] = []
  const warnings: ParseWarning[] = []
  const labelSet = new Set<string>()
  const bodyRefs: BodyRefHit[] = []
  const noteRefs: NoteRefHit[] = []
  let autoSeq = 1

  /** 注册行内注定义（label 跳过与作者手写 label 的冲突） */
  const registerAutoNote = (content: string): string => {
    let label = ''
    do {
      label = `auto-${autoSeq++}`
    } while (labelSet.has(label))
    labelSet.add(label)
    definitions.push({ label, lines: content.split('\n'), defIndex: definitions.length })
    return label
  }

  const bodyRW = new StreamRewriter({
    onRef: (label) => {
      bodyRefs.push({ label, line: bodyRW.currentLineIndex, order: bodyRefs.length })
    },
    createAutoNote: registerAutoNote
  })

  let fence: FenceInfo | null = null
  let curDef: { label: string; lines: string[]; dup: boolean } | null = null
  let pendingBlank = false
  /** 当前未闭合行内注已吞入的行数（超限强制闭合，M4 保险） */
  let openNoteLines = 0

  const closeDef = (): void => {
    if (!curDef) return
    const lines = curDef.lines
    while (lines.length > 0 && lines[0] === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (!curDef.dup) {
      definitions.push({ label: curDef.label, lines, defIndex: definitions.length })
    }
    curDef = null
    pendingBlank = false
  }

  for (const line of rawLines) {
    // 1. 正文行内注续行：整行并入注内容；定义行与围栏起始行可抢占（先行闭合，M4）。
    //    未闭合的 ^[ 若不抢先闭合，围栏起始行会被 feedTextLine 吞入注缓冲，
    //    fence 永不置位，后续代码块与正文成片进入注内容。
    if (bodyRW.hasOpenNote()) {
      if (!fence && indentOf(line) <= 3 && (matchDefStart(line) || matchFenceOpen(line))) {
        bodyRW.closeOpenNote()
        openNoteLines = 0
      } else {
        openNoteLines++
        if (openNoteLines > MAX_INLINE_NOTE_LINES) {
          bodyRW.closeOpenNote()
          openNoteLines = 0
          console.warn(
            `[zhumo] 行内注跨行超过 ${MAX_INLINE_NOTE_LINES} 行，已强制闭合（后续行回归正文）`
          )
          bodyRW.feedTextLine(line) // 当前行回归正文处理
          continue
        }
        bodyRW.feedTextLine(line)
        continue
      }
    } else {
      openNoteLines = 0
    }
    // 2. 围栏代码块内容
    if (fence) {
      if (isFenceClose(line, fence)) fence = null
      bodyRW.emitRaw(line)
      continue
    }
    // 3. 定义块收集中：空行挂起；缩进 ≥4 为续行；其余收块
    if (curDef) {
      if (isBlankLine(line)) {
        pendingBlank = true
        continue
      }
      if (indentOf(line) >= 4) {
        if (pendingBlank) {
          curDef.lines.push('')
          pendingBlank = false
        }
        curDef.lines.push(stripIndent(line, 4))
        continue
      }
      closeDef()
    }
    // 4. 空行
    if (isBlankLine(line)) {
      bodyRW.feedTextLine('')
      continue
    }
    // 5. 缩进代码块（4 空格）
    if (indentOf(line) >= 4) {
      bodyRW.emitRaw(line)
      continue
    }
    // 6. 定义行（GFM / 中文注标记；重复定义取首个）
    const ds = matchDefStart(line)
    if (ds) {
      if (labelSet.has(ds.label)) {
        warnings.push({
          kind: 'duplicate',
          label: ds.label,
          message: `重复的注释定义，已采用首个：「${ds.label}」`
        })
        curDef = { label: ds.label, lines: [ds.content], dup: true }
      } else {
        labelSet.add(ds.label)
        curDef = { label: ds.label, lines: [ds.content], dup: false }
      }
      continue
    }
    // 7. 围栏代码块起始
    const fo = matchFenceOpen(line)
    if (fo) {
      fence = fo
      bodyRW.emitRaw(line)
      continue
    }
    // 8. 正文文本行
    bodyRW.feedTextLine(line)
  }
  closeDef()
  const bodyLines = bodyRW.finish()

  // 定义内容归一：识别注内引用、提取注内行内注（队列式处理，注内注亦有定义）
  for (let i = 0; i < definitions.length; i++) {
    const def = definitions[i]
    let localOrder = 0
    let defFence: FenceInfo | null = null
    let defOpenNoteLines = 0
    const rw = new StreamRewriter({
      onRef: (label) => {
        noteRefs.push({ target: label, parent: def.label, localOrder: localOrder++ })
      },
      createAutoNote: registerAutoNote
    })
    for (const line of def.lines) {
      // 与正文同规则（M4）：注内未闭合 ^[ 遇围栏起始行先闭合，跨行超限强制闭合
      if (rw.hasOpenNote()) {
        if (matchFenceOpen(line)) {
          rw.closeOpenNote()
          defOpenNoteLines = 0
        } else {
          defOpenNoteLines++
          if (defOpenNoteLines > MAX_INLINE_NOTE_LINES) {
            rw.closeOpenNote()
            defOpenNoteLines = 0
            console.warn(
              `[zhumo] 注「${def.label}」内行内注跨行超过 ${MAX_INLINE_NOTE_LINES} 行，已强制闭合`
            )
            rw.feedTextLine(line)
            continue
          }
          rw.feedTextLine(line)
          continue
        }
      } else {
        defOpenNoteLines = 0
      }
      if (defFence) {
        if (isFenceClose(line, defFence)) defFence = null
        rw.emitRaw(line)
        continue
      }
      if (isBlankLine(line)) {
        rw.feedTextLine('')
        continue
      }
      if (indentOf(line) >= 4) {
        rw.emitRaw(line)
        continue
      }
      const fo = matchFenceOpen(line)
      if (fo) {
        defFence = fo
        rw.emitRaw(line)
        continue
      }
      rw.feedTextLine(line)
    }
    def.lines = rw.finish()
  }

  return { bodyLines, definitions, bodyRefs, noteRefs, warnings }
}
