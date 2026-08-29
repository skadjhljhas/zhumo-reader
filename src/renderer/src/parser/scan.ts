/**
 * Pass A 词法工具：注释标记识别、类型词表、代码保护切分、行分类。
 *
 * 全部为纯函数；被 preprocess（归一扫描）与 render（分章扫描）共用，
 * 保证两遍扫描对「什么算代码、什么算标题、什么算定义行」的判定一致。
 */
import type { NoteType } from './types'

/* ------------------------------------------------------------------ */
/* 类型词表（可导出扩展）                                               */
/* ------------------------------------------------------------------ */

/**
 * 注释类型词表：label 冒号前缀与定义首词两来源共用。
 * 匹配时按词长降序（最长词优先），可通过 registerNoteTypeWord 扩展。
 */
export const NOTE_TYPE_WORDS: Record<NoteType, string[]> = {
  translator: ['译者注', '译注', '译者', '译者按', '译按'],
  editor: ['编者注', '编注', '校注', '编者', '编者按'],
  textual: ['考据注', '考证注', '考据', '考证'],
  original: ['原注', '原文注'],
  commentary: ['按', '案', '疏'],
  plain: []
}

/** 运行期向词表注册新词（扩展点），如 registerNoteTypeWord('editor', '辑注') */
export function registerNoteTypeWord(type: NoteType, word: string): void {
  const list = NOTE_TYPE_WORDS[type]
  if (list && word && !list.includes(word)) list.push(word)
  sortedWordEntries = null // 失效缓存
}

/** 词 -> 类型 的最长优先匹配序列（缓存） */
let sortedWordEntries: Array<{ word: string; type: NoteType }> | null = null

function getSortedWordEntries(): Array<{ word: string; type: NoteType }> {
  if (!sortedWordEntries) {
    const entries: Array<{ word: string; type: NoteType }> = []
    for (const [type, words] of Object.entries(NOTE_TYPE_WORDS) as Array<[NoteType, string[]]>) {
      for (const word of words) entries.push({ word, type })
    }
    // 最长词优先；同长度保持词表声明顺序（稳定排序）
    entries.sort((a, b) => b.word.length - a.word.length)
    sortedWordEntries = entries
  }
  return sortedWordEntries
}

/** 类型识别结果：type 供配色与统计，word 为命中的实际词（供徽标原样显示） */
export interface DetectedNoteType {
  type: NoteType
  /** 命中的实际词：词表命中词；或 label 前缀存在但词表未命中时的自定义前缀词；
   *  无任何类型语义时为 null */
  word: string | null
}

/**
 * 类型识别（详细版）：label 冒号前缀（如 `译者:序1` 的「译者」）优先，
 * 其次定义首词（如「译者注：」）；两者均未命中但 label 带前缀时，
 * 保留作者的自定义前缀词（type 落 plain，word = 前缀），
 * 徽标据此显示作者实际用词而不丢弃语义。
 */
export function detectNoteTypeDetailed(label: string, contentLines: string[]): DetectedNoteType {
  // 来源一：label 前缀（半角/全角冒号均可作类型前缀分隔符）
  const sep = label.search(/[:：]/)
  if (sep > 0) {
    const prefix = label.slice(0, sep)
    for (const { word, type } of getSortedWordEntries()) {
      if (word === prefix) return { type, word: prefix }
    }
  }
  // 来源二：定义首词，最长词优先；词后须跟冒号或空白
  const content = contentLines.join('\n').replace(/^[\s]+/, '')
  for (const { word, type } of getSortedWordEntries()) {
    if (content.startsWith(word)) {
      const rest = content.slice(word.length)
      if (rest === '' || /^[：:\s]/.test(rest)) return { type, word }
    }
  }
  // 两来源均未命中：带前缀则保留自定义词（type=plain），否则无类型语义
  if (sep > 0) return { type: 'plain', word: label.slice(0, sep) }
  return { type: 'plain', word: null }
}

/** 类型识别：仅取枚举（兼容旧调用方） */
export function detectNoteType(label: string, contentLines: string[]): NoteType {
  return detectNoteTypeDetailed(label, contentLines).type
}

/**
 * 作者标号计算（T23）：锚点 sup 与卡片头显示的标记，取代内部文档序号。
 *
 * 优先级：
 * 1. 行内注 auto-N → N（作者未提供标号，自动序号是唯一合理填充）
 * 2. 中文注归一产物 注N → N（作者写在 [注3] / 【注3】里的 3）
 * 3. 纯数字（半角）label → 原样（作者自己的编号，分章跳号时忠实保留）
 * 4. label 含类型词（typeWord 非空 = 类型识别已消费该词）：
 *    - 纯类型词 label（如 `[^按]`）→ 剥后为空 → 回退文档序号；
 *      「类型词[:：]余部」结构（如 `译者:确定性`）→ 余部即作者标号，
 *      余部为空同样回退；
 *    - 类型词来自定义首词而非 label 结构 → label 原样（标号与类型无关）
 * 5. 其余自由 label（如 `序言-确定性`）→ label 原样：整个标签文字就是
 *    作者给这条注起的名字
 *
 * 纯函数（label, docNumber, typeWord → mark），可单测。
 */
export function computeDisplayMark(
  label: string,
  docNumber: number,
  typeWord?: string | null
): string {
  const auto = /^auto-([0-9]+)$/.exec(label)
  if (auto) return auto[1]
  const zh = /^注([0-9]+)$/.exec(label)
  if (zh) return zh[1]
  if (/^[0-9]+$/.test(label)) return label
  if (typeWord) {
    // 纯类型词 label：类型语义已消费，无余部可作标号 → 回退文档序
    if (label === typeWord) return String(docNumber)
    // 结构性前缀「类型词[:：]」：余部即作者标号（译者:确定性 → 确定性）
    const m = new RegExp(`^${typeWord}\\s*[:：]`).exec(label)
    if (m) return label.slice(m[0].length) || String(docNumber)
  }
  // 自由 label：整个标签文字即作者标号（序言-确定性 → 序言-确定性）
  return label
}

/* ------------------------------------------------------------------ */
/* 自定义类型词容错                                                      */
/* ------------------------------------------------------------------ */

/** 徽标自定义词上限（UTF-16 码元；中文即 12 字），超出不显示徽标防撑爆侧栏 */
const TYPE_LABEL_MAX_LEN = 12
/** 标记类字符（HTML/Markdown 语义符）与控制/格式字符：出现即不显示徽标 */
const TYPE_LABEL_UNSAFE_RE = /[<>`"'&\\]|[\p{C}]/u

/**
 * 校验自定义类型词是否适合作为徽标显示：
 * 非空、≤12 字符、不含标记类与控制字符、至少含一个字母/数字/汉字。
 * 词表命中的内置词（≤3 字、纯汉字）必然通过；仅约束作者自定义词。
 */
export function isValidTypeLabelWord(word: string | null): word is string {
  if (!word) return false
  if (word.length > TYPE_LABEL_MAX_LEN) return false
  if (TYPE_LABEL_UNSAFE_RE.test(word)) return false
  return /[\p{L}\p{N}]/u.test(word)
}

/* ------------------------------------------------------------------ */
/* 标记识别                                                             */
/* ------------------------------------------------------------------ */

/**
 * 宽松 label 规则：非空、不含空白与方括号的字符序列；
 * 冒号允许出现（保留给类型前缀），全角冒号同样允许。
 */
export const REF_LABEL_SOURCE = String.raw`[^\s\[\]]+`

/** GFM 脚注引用 `[^label]` */
export const REF_SOURCE = String.raw`\[\^(${REF_LABEL_SOURCE})\]`

/** 中文注引用 `[注N]` / `【注N】` */
export const ZH_REF_SOURCE = String.raw`[【\[]注([0-9]+)[】\]]`

/** 文本内三类标记的联合扫描（引用 / 中文注引用 / 行内注开头 ^[） */
const TEXT_TOKEN_RE = new RegExp(`${REF_SOURCE}|${ZH_REF_SOURCE}|\\^\\[`, 'g')

/** GFM 定义行：行首（≤3 空格缩进）`[^label]: 内容`，冒号接受半角/全角 */
const DEF_GFM_RE = new RegExp(`^ {0,3}\\[\\^(${REF_LABEL_SOURCE})\\][:：][ \\t]?(.*)$`)

/** 中文注定义行：行首 `注N: 内容` / `注N：内容` */
const DEF_ZH_RE = /^ {0,3}(注[0-9]+)[:：][ \t]?(.*)$/

export interface DefStartMatch {
  label: string
  /** 定义行冒号后的首行内容 */
  content: string
}

/** 识别行首定义行；不匹配返回 null */
export function matchDefStart(line: string): DefStartMatch | null {
  const gfm = DEF_GFM_RE.exec(line)
  if (gfm) return { label: gfm[1], content: gfm[2] }
  const zh = DEF_ZH_RE.exec(line)
  if (zh) return { label: zh[1], content: zh[2] }
  return null
}

/* ------------------------------------------------------------------ */
/* 行内 code span 切分                                                  */
/* ------------------------------------------------------------------ */

export interface CodeSpanSegment {
  text: string
  /** true 表示该段为反引号 code span，须原样保护 */
  code: boolean
}

/**
 * 将一行文本按 CommonMark code span 规则切分：
 * 长度为 n 的反引号串与之后最近的等长反引号串配对，中间为代码；
 * 未配对的反引号视为普通文本。
 */
export function splitCodeSpans(text: string): CodeSpanSegment[] {
  const segments: CodeSpanSegment[] = []
  let textStart = 0
  let i = 0
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x60 /* ` */) {
      i++
      continue
    }
    let openLen = 1
    while (text.charCodeAt(i + openLen) === 0x60) openLen++
    // 向后寻找等长反引号串
    let j = i + openLen
    let closeAt = -1
    while (j < text.length) {
      if (text.charCodeAt(j) === 0x60) {
        let runLen = 1
        while (text.charCodeAt(j + runLen) === 0x60) runLen++
        if (runLen === openLen) {
          closeAt = j
          break
        }
        j += runLen
      } else {
        j++
      }
    }
    if (closeAt < 0) {
      i += openLen // 未闭合：按普通文本继续
      continue
    }
    if (i > textStart) segments.push({ text: text.slice(textStart, i), code: false })
    segments.push({ text: text.slice(i, closeAt + openLen), code: true })
    i = closeAt + openLen
    textStart = i
  }
  if (textStart < text.length) segments.push({ text: text.slice(textStart), code: false })
  return segments
}

/* ------------------------------------------------------------------ */
/* 行分类：缩进 / 空行 / 围栏 / 标题                                     */
/* ------------------------------------------------------------------ */

/** 空行（仅空白） */
export function isBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

/** 行首缩进宽度（制表符按 4 计；超过 4 一律按代码缩进处理） */
export function indentOf(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') n++
    else if (ch === '\t') return 4
    else break
    if (n >= 4) return 4
  }
  return n
}

/** 剥去行首至多 n 空格缩进（或一个制表符） */
export function stripIndent(line: string, n: number): string {
  if (line.startsWith('\t')) return line.slice(1)
  let i = 0
  while (i < n && line[i] === ' ') i++
  return line.slice(i)
}

export interface FenceInfo {
  ch: '`' | '~'
  len: number
}

/** 识别围栏代码块起始行（``` 或 ~~~，≥3 个）。
 *  CommonMark：反引号围栏的 info string 不得含反引号，否则该行不是围栏
 *  （与 markdown-it 的行判定一致，避免两遍扫描对同一行的定性分歧）。 */
export function matchFenceOpen(line: string): FenceInfo | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return null
  const s = m[1]
  if (s[0] === '`' && m[2].includes('`')) return null
  return { ch: s[0] as '`' | '~', len: s.length }
}

/** 判断 line 是否为 open 围栏的闭合行（同字符、长度不小于开栏） */
export function isFenceClose(line: string, open: FenceInfo): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  if (!m) return false
  const s = m[1]
  return s[0] === open.ch && s.length >= open.len
}

export interface HeadingMatch {
  level: number
  /** 原始标题文本（未去除注释标记） */
  text: string
}

/** 识别 ATX 标题（# 至 ######），去掉尾部闭合 # 串 */
export function matchHeading(line: string): HeadingMatch | null {
  const m = /^ {0,3}(#{1,6})([ \t]+(.*))?$/.exec(line)
  if (!m) return null
  let text = m[3] ?? ''
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '')
  return { level: m[1].length, text }
}

/** 去除文本中的注释标记（用于标题/书名净化） */
export function stripRefMarkers(text: string): string {
  return text
    .replace(new RegExp(REF_SOURCE, 'g'), '')
    .replace(new RegExp(ZH_REF_SOURCE, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 供 preprocess 的 StreamRewriter 使用：联合标记正则（每次调用重置 lastIndex 由调用方管理） */
export function createTextTokenRegex(): RegExp {
  return new RegExp(TEXT_TOKEN_RE.source, 'g')
}
