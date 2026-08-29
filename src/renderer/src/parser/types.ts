/**
 * 解析内核内部类型（不对外暴露，对外契约见 src/shared/types.ts）。
 */
import type { NoteAnchorSpot, NoteRecord, ParseWarning } from '../../../shared/types'

export type NoteType = NoteRecord['type']

/** Pass A 产物：原始定义块（内容行尚未做引用归一） */
export interface RawDefinition {
  label: string
  /** 首行为定义行冒号后的内容；续行已剥去 4 空格缩进 */
  lines: string[]
  /** 定义在文档中的出现序 */
  defIndex: number
}

/** 正文引用命中（文档序） */
export interface BodyRefHit {
  label: string
  /** 引用所在行在净化正文中的行号 */
  line: number
  /** 正文引用全局序（0 起，按文档序递增） */
  order: number
}

/** 注释体内引用命中 */
export interface NoteRefHit {
  /** 被引用的注释 label */
  target: string
  /** 所在注释的 label */
  parent: string
  /** 在该注释体内的局部序（0 起） */
  localOrder: number
}

/** Pass A 产物 */
export interface PreprocessResult {
  /** 净化正文（定义区已移除、写法已归一、行内注已折叠为 [^auto-N]） */
  bodyLines: string[]
  /** 首个定义（重复定义只保留首个，其余记录在 warnings） */
  definitions: RawDefinition[]
  bodyRefs: BodyRefHit[]
  noteRefs: NoteRefHit[]
  warnings: ParseWarning[]
}

/** Pass B 产物：注释图节点（已完成层级、类型、排序） */
export interface NoteNode {
  id: string
  /** 注释在 notes 文档序中的位次（1 起），同时用于回退序号（无可识别标号时） */
  number: number
  /** 作者标号（T23）：computeDisplayMark 的产物，sup 与卡头显示用 */
  displayMark: string
  label: string
  hasDef: boolean
  type: NoteType
  /** 作者实际使用的类型词（词表命中词或自定义前缀词）；仅有效时存在 */
  typeLabel?: string
  /** 1..cap */
  level: number
  /** 指向本注的注释所在注释的 label（按首次出现去重） */
  parents: string[]
  refCount: number
  /** 排序键：首次被引用位置的路径（正文第 i 个引用=[i]；注内引用=父注路径+[局部序]）；无路径（纯环/孤儿）为 null */
  orderKey: number[] | null
  /** 正文命中（按 order 升序） */
  bodyHits: { line: number; order: number }[]
  /** 归一后的注释内容行（missing 为空数组） */
  contentLines: string[]
  orphan: boolean
  /** 自正文不可达的环连通分量成员（含附庸） */
  cycle: boolean
}

/** Pass B 产物 */
export interface NoteGraph {
  /** 已按文档序排序并赋予 id/number */
  nodes: NoteNode[]
  byLabel: Map<string, NoteNode>
  warnings: ParseWarning[]
  cap: number
}

/** Pass C 产物 */
export interface RenderedBook {
  title: string
  toc: import('../../../shared/types').TocItem[]
  sections: import('../../../shared/types').Section[]
  /** label -> 注释体 html */
  noteHtml: Map<string, string>
  /** label -> 锚点位置（正文引用在前按 order 升序，注内引用随其后按父注文档序，T23） */
  anchorSpots: Map<string, NoteAnchorSpot[]>
}
