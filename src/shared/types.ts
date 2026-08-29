/**
 * 朱墨 ZhuMo —— 解析内核对外数据契约。
 *
 * 本文件是解析器（渲染进程 Worker）与 UI 层之间的唯一契约，
 * 字段名与语义由架构约定，UI 层按此消费，修改须双方同步。
 */

/** 目录项：由正文 H1–H3 标题生成 */
export interface TocItem {
  id: string
  level: number
  title: string
  sectionId: string
}

/** 分章后的正文片段，html 为该章完整渲染结果（含标题） */
export interface Section {
  id: string
  level: number
  title: string
  html: string
  /** 章内出现的注释 id（按出现序） */
  anchorIds: string[]
}

/** 正文锚点位置（引用地图条目，T23）：注在正文中的某处引用 */
export interface NoteBodySpot {
  kind: 'body'
  sectionId: string
  /** 正文引用全局序（文档序） */
  order: number
  /** 所在章标题（「见于·〈章名〉」展示用） */
  sectionTitle: string
}

/** 注内锚点位置（引用地图条目，T23）：某条父注的注释体引用了本注 */
export interface NoteParentSpot {
  kind: 'note'
  /** 父注 = 引用本注的那条注释 */
  parentNoteId: string
  /** 父注的作者标号（「注于·〈父注标号〉」展示用） */
  parentDisplayMark: string
  /** 父注类型徽标词（可选；「注于·3·考据」式补充展示） */
  parentTypeLabel?: string
}

/** 注释锚点位置：正文引用或注内引用（判别字段 kind） */
export type NoteAnchorSpot = NoteBodySpot | NoteParentSpot

/** 单条注释的完整记录 */
export interface NoteRecord {
  id: string
  label: string
  type: 'translator' | 'editor' | 'textual' | 'original' | 'commentary' | 'plain'
  /** 作者实际使用的类型词（词表命中词或自定义前缀词，原样保留）；
   *  无类型时缺省。UI 徽标显示此词，type 枚举仅决定配色与统计 */
  typeLabel?: string
  /** 作者标号（T23）：锚点 sup 与卡片头显示的标记——`[注3]`→`3`、
   *  纯数字 label 原样、带类型前缀的剥前缀取余部（如「确定性」）、
   *  无可识别标号时回退文档序号。锚点与卡片的对应由它建立 */
  displayMark: string
  /** 1..cap，正文引用=1，注内引用=父注+1；多处引用取最浅 */
  level: number
  /** 注释体独立渲染（注内引用已锚点化为 sup） */
  html: string
  /** 锚点位置（可多处）：正文引用在前（order 升序），注内引用随其后（父注文档序） */
  anchorSpots: NoteAnchorSpot[]
  /** 包含指向本注之引用的注释 id 列表（正文直接引用则为空） */
  parentIds: string[]
  refCount: number
  /** 引用了未定义的注释 */
  missing?: boolean
  /** 定义从未被引用 */
  orphan?: boolean
  /** 注释互引成环且自正文不可达（同一连通分量内全部成员都带此标志） */
  cycle?: boolean
}

/** 解析警告 */
export interface ParseWarning {
  kind: 'missing' | 'orphan' | 'duplicate' | 'cycle' | 'level-cap' | 'parse-fallback'
  message: string
  label?: string
}

/** 解析产物 */
export interface ParsedBook {
  /** 首个 H1 文本，无则空串 */
  title: string
  /** H1–H3 */
  toc: TocItem[]
  sections: Section[]
  /** 按文档序（首次被引用位置序：正文引用按位置；注内引用排在其父注位置之后） */
  notes: NoteRecord[]
  warnings: ParseWarning[]
  /** chars=去除定义区后的正文字符数 */
  stats: { chars: number; noteCount: number; maxLevel: number }
}

/** 解析选项 */
export interface ParseOptions {
  /** 嵌套层级上限，默认 4 */
  levelCap?: number
}
