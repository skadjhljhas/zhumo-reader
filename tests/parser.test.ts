/**
 * 朱墨注释解析内核测试（vitest，node 环境）。
 *
 * 覆盖：三层嵌套、环封顶、missing/orphan/duplicate、中文 label、多段落定义、
 * 三种代码保护、行内注归一、中文注标记归一、类型词表（前缀+首词+最长优先）、
 * 层级上限、KaTeX 混排、分章瀑布、notes 文档序、多引聚合、降级兑底、
 * T8 修复：未闭合 ^[ 围栏/定义行抢断与跨行上限（M4）、环上 orderKey 缓存不污染（M5）、
 * 围栏 info 含反引号不视为围栏（M6）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import { computeDisplayMark, matchFenceOpen } from '../src/renderer/src/parser/scan'
import type { NoteRecord, ParsedBook } from '../src/shared/types'

const fixture = readFileSync(
  fileURLToPath(new URL('../fixtures/phg-sample.md', import.meta.url)),
  'utf-8'
)

const byLabel = (book: ParsedBook, label: string): NoteRecord | undefined =>
  book.notes.find((n) => n.label === label)

const warnKinds = (book: ParsedBook): string[] => book.warnings.map((w) => w.kind)

const docOf = (label: string, content: string): string =>
  `引[^${label}]文。\n\n[^${label}]: ${content}`

/* ================================================================== */
/* 演示书 phg-sample                                                    */
/* ================================================================== */

describe('演示书 phg-sample', () => {
  const book = parseBook(fixture)

  it('标题、目录层级与分章', () => {
    expect(book.title).toBe('精神现象学·序言')
    expect(book.toc.map((t) => t.level)).toEqual([1, 2, 2, 3, 2, 1])
    expect(book.toc.map((t) => t.title)).toEqual([
      '精神现象学·序言',
      '一、论科学的体系性',
      '二、数学证明的限度',
      '证例的增补',
      '三、从现象到绝对',
      '译注凡例'
    ])
    expect(book.sections).toHaveLength(2)
    expect(book.sections[0].title).toBe('精神现象学·序言')
    expect(book.sections[1].title).toBe('译注凡例')
    // 目录项指向所属章
    expect(book.toc[4].sectionId).toBe('sec-1')
    expect(book.toc[5].sectionId).toBe('sec-2')
  })

  it('注释规模、层级与零警告', () => {
    expect(book.notes.length).toBe(18)
    expect(book.warnings).toEqual([])
    expect(book.stats.noteCount).toBe(18)
    expect(book.stats.maxLevel).toBe(3)
  })

  it('notes 文档序（注内引用排在其父注之后）', () => {
    expect(book.notes.map((n) => n.label)).toEqual([
      '译者:序-1',
      '译者:确定性',
      '考据:确定性考',
      '编者:校记一',
      '序言-确定性',
      '注1',
      'auto-1',
      'auto-2',
      '原文:黑格尔原注',
      '考据:版本源流',
      '注2',
      '校注:页码',
      'auto-3',
      '注3',
      '译按:概念',
      '序言-概念说明',
      '编注:术语表',
      '编者:符号说明'
    ])
    expect(book.notes.map((n) => n.id)).toEqual(
      Array.from({ length: 18 }, (_, i) => `note-${i + 1}`)
    )
    // 作者标号写入 sup（T23）：译者:确定性 → 「确定性」（剥类型前缀取余部）
    expect(book.sections[0].html).toContain(
      `<sup class="zmu-ref" data-note-id="${byLabel(book, '译者:确定性')?.id}" data-level="1" title="确定性"><span class="zmu-ref-mark">确定性</span></sup>`
    )
  })

  it('三层嵌套：正文 → 译者注 → 考据注 → 编者注', () => {
    expect(byLabel(book, '译者:确定性')?.level).toBe(1)
    expect(byLabel(book, '考据:确定性考')?.level).toBe(2)
    expect(byLabel(book, '编者:校记一')?.level).toBe(3)
    expect(byLabel(book, '考据:确定性考')?.parentIds).toEqual([byLabel(book, '译者:确定性')?.id])
    expect(byLabel(book, '编者:校记一')?.parentIds).toEqual([byLabel(book, '考据:确定性考')?.id])
    // 注内引用锚点化：考据注的 html 内有指向编者注的 sup（层级 3）
    expect(byLabel(book, '考据:确定性考')?.html).toContain('data-level="3"')
    expect(byLabel(book, '考据:确定性考')?.html).toContain(
      `data-note-id="${byLabel(book, '编者:校记一')?.id}"`
    )
  })

  it('六类注释类型齐备', () => {
    const expected: Record<string, NoteRecord['type']> = {
      '译者:序-1': 'translator',
      '译者:确定性': 'translator',
      '考据:确定性考': 'textual',
      '编者:校记一': 'editor',
      '序言-确定性': 'plain',
      注1: 'translator',
      'auto-1': 'commentary',
      'auto-2': 'original',
      '原文:黑格尔原注': 'original',
      '考据:版本源流': 'textual',
      注2: 'editor',
      '校注:页码': 'editor',
      'auto-3': 'translator',
      注3: 'textual',
      '译按:概念': 'translator',
      '序言-概念说明': 'plain',
      '编注:术语表': 'editor',
      '编者:符号说明': 'editor'
    }
    for (const [label, type] of Object.entries(expected)) {
      expect(byLabel(book, label)?.type, `label=${label}`).toBe(type)
    }
  })

  it('多引聚合一注：refCount / anchorSpots（含章标题）/ 双锚点', () => {
    const note = byLabel(book, '译者:确定性')
    expect(note?.refCount).toBe(2)
    expect(note?.anchorSpots).toEqual([
      { kind: 'body', sectionId: 'sec-1', order: 1, sectionTitle: '精神现象学·序言' },
      { kind: 'body', sectionId: 'sec-1', order: 10, sectionTitle: '精神现象学·序言' }
    ])
    const id = note?.id as string
    const html = book.sections.map((s) => s.html).join('')
    expect(html.split(`data-note-id="${id}"`).length - 1).toBe(2)
    // 作者标号与层级写入 sup（T23）：译者:确定性 → 「确定性」、1 级
    expect(html).toContain(
      `<sup class="zmu-ref" data-note-id="${id}" data-level="1" title="确定性"><span class="zmu-ref-mark">确定性</span></sup>`
    )
  })

  it('多段落定义（缩进续行）', () => {
    const html = byLabel(book, '注1')?.html ?? ''
    expect(html).toContain('<p>译者注：种子之喻屡见于黑格尔著作')
    expect(html).toContain('<p>《精神现象学》序言中')
    expect((html.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // 全角冒号定义行（编注:术语表）
    expect(byLabel(book, '编注:术语表')?.html).toContain('六类脚注的标记方式')
  })

  it('代码中的假注不产生任何 NoteRecord（fenced / indented / span）', () => {
    expect(book.notes.some((n) => n.label.includes('fake'))).toBe(false)
    expect(book.notes.some((n) => n.label === '注9')).toBe(false)
    expect(book.warnings).toEqual([])
    const html = book.sections.map((s) => s.html).join('')
    expect(html).toContain('[^fake]')
  })

  it('KaTeX：正文行内/块级与注内公式', () => {
    expect(book.sections[0].html).toContain('class="katex"')
    expect(book.sections[0].html).toContain('katex-block')
    expect(byLabel(book, '编者:符号说明')?.html).toContain('class="katex"')
  })

  it('章内锚点集合', () => {
    // 注内引用（考据:确定性考、编者:校记一）的锚点在注释体内，不计入正文章节
    expect(book.sections[0].anchorIds).toHaveLength(14)
    expect(book.sections[1].anchorIds).toEqual([
      byLabel(book, '编注:术语表')?.id,
      byLabel(book, '编者:符号说明')?.id
    ])
  })

  it('stats.chars 为去除定义区后的正文字符数', () => {
    expect(book.stats.chars).toBeGreaterThan(1000)
    expect(book.stats.chars).toBeLessThan(fixture.length)
  })
})

/* ================================================================== */
/* 数据契约形状                                                         */
/* ================================================================== */

describe('数据契约', () => {
  const book = parseBook(fixture)

  it('ParsedBook / Section / TocItem / NoteRecord 字段', () => {
    expect(Object.keys(book).sort()).toEqual([
      'notes',
      'sections',
      'stats',
      'title',
      'toc',
      'warnings'
    ])
    expect(Object.keys(book.sections[0]).sort()).toEqual([
      'anchorIds',
      'html',
      'id',
      'level',
      'title'
    ])
    expect(Object.keys(book.toc[0]).sort()).toEqual(['id', 'level', 'sectionId', 'title'])
    const note = book.notes[0]
    expect(Object.keys(note).sort()).toEqual([
      'anchorSpots',
      'displayMark',
      'html',
      'id',
      'label',
      'level',
      'parentIds',
      'refCount',
      'type',
      'typeLabel'
    ])
    expect(note.anchorSpots[0] ? Object.keys(note.anchorSpots[0]).sort() : []).toEqual([
      'kind',
      'order',
      'sectionId',
      'sectionTitle'
    ])
  })

  it('stats.chars 精确剔除定义区', () => {
    const book2 = parseBook('正文字。[^n]\n\n[^n]: 定义内容不计数。')
    // 净化正文 = "正文字。[^n]\n"
    expect(book2.stats.chars).toBe(9)
  })

  it('标题净化：标题内的引用不进入 title，但锚点保留在渲染中', () => {
    const book3 = parseBook('# 标题[^n]\n\n正文。\n\n[^n]: 注。')
    expect(book3.title).toBe('标题')
    expect(book3.toc[0].title).toBe('标题')
    expect(book3.sections[0].title).toBe('标题')
    expect(book3.sections[0].html).toContain('<h1>标题<sup')
  })
})

/* ================================================================== */
/* 图结构与容错                                                         */
/* ================================================================== */

describe('注释图', () => {
  it('环（A 引 B、B 引 A，正文不可达）封顶 + cycle 警告', () => {
    const src = [
      '正文引用[^a]。',
      '',
      '[^a]: 甲注，参见[^b]。',
      '',
      '[^b]: 乙注，参见[^a]。',
      '',
      '[^c]: 丙注，参见[^d]。',
      '',
      '[^d]: 丁注，参见[^c]。'
    ].join('\n')
    const book = parseBook(src)
    expect(byLabel(book, 'a')?.level).toBe(1)
    expect(byLabel(book, 'b')?.level).toBe(2)
    expect(byLabel(book, 'c')?.level).toBe(4)
    expect(byLabel(book, 'd')?.level).toBe(4)
    expect(book.warnings.filter((w) => w.kind === 'cycle')).toHaveLength(1)
    expect(book.warnings.find((w) => w.kind === 'cycle')?.label).toBe('c')
    expect(book.stats.maxLevel).toBe(4)
    // 自定义上限
    const capped = parseBook(src, { levelCap: 2 })
    expect(byLabel(capped, 'c')?.level).toBe(2)
    expect(byLabel(capped, 'd')?.level).toBe(2)
    expect(warnKinds(capped)).toContain('cycle')
  })

  it('环连通分量成员全部带 cycle 标志', () => {
    // c↔d 纯环自正文不可达：分量内每个成员都带标志；
    // a→b（正文可达）与可达环成员不带
    const src = [
      '正文引用[^a]。',
      '',
      '[^a]: 甲注，参见[^b]。',
      '',
      '[^b]: 乙注，参见[^a]。',
      '',
      '[^c]: 丙注，参见[^d]。',
      '',
      '[^d]: 丁注，参见[^c]。'
    ].join('\n')
    const book = parseBook(src)
    expect(byLabel(book, 'c')?.cycle).toBe(true)
    expect(byLabel(book, 'd')?.cycle).toBe(true)
    expect(byLabel(book, 'a')?.cycle).toBeUndefined()
    expect(byLabel(book, 'b')?.cycle).toBeUndefined()

    const reach = parseBook('正文[^x]。\n\n[^x]: 甲引[^y]。\n\n[^y]: 乙引[^x]。')
    expect(byLabel(reach, 'x')?.cycle).toBeUndefined()
    expect(byLabel(reach, 'y')?.cycle).toBeUndefined()
  })

  it('正文可达的互引不算环', () => {
    const book = parseBook('正文[^x]。\n\n[^x]: 甲引[^y]。\n\n[^y]: 乙引[^x]。')
    expect(byLabel(book, 'x')?.level).toBe(1)
    expect(byLabel(book, 'y')?.level).toBe(2)
    expect(book.warnings).toEqual([])
  })

  it('孤儿引用（missing）：锚点保留、html 为空', () => {
    const book = parseBook('这里引用[^ghost]了一个未定义的注释。')
    const ghost = byLabel(book, 'ghost')
    expect(ghost?.missing).toBe(true)
    expect(ghost?.orphan).toBeUndefined()
    expect(ghost?.html).toBe('')
    expect(ghost?.level).toBe(1)
    expect(ghost?.refCount).toBe(1)
    expect(ghost?.anchorSpots).toHaveLength(1)
    expect(warnKinds(book)).toContain('missing')
    expect(book.warnings.find((w) => w.kind === 'missing')?.label).toBe('ghost')
    const id = ghost?.id as string
    expect(book.sections[0].html).toContain(`data-note-id="${id}"`)
    expect(book.sections[0].anchorIds).toContain(id)
  })

  it('未引用定义（orphan）：层级 1 + 警告', () => {
    const book = parseBook('正文没有引用。\n\n[^孤注]: 从未被引用的注释。')
    const note = byLabel(book, '孤注')
    expect(note?.orphan).toBe(true)
    expect(note?.missing).toBeUndefined()
    expect(note?.level).toBe(1)
    expect(note?.refCount).toBe(0)
    expect(warnKinds(book)).toEqual(['orphan'])
    expect(book.warnings[0].label).toBe('孤注')
  })

  it('重复定义取首个 + duplicate 警告，重复块从正文移除', () => {
    const book = parseBook('引用[^d]。\n\n[^d]: 第一个定义。\n\n[^d]: 第二个定义。')
    expect(book.notes.filter((n) => n.label === 'd')).toHaveLength(1)
    expect(byLabel(book, 'd')?.html).toContain('第一个定义')
    expect(byLabel(book, 'd')?.html).not.toContain('第二个定义')
    expect(book.sections[0].html).not.toContain('第二个定义')
    expect(warnKinds(book)).toEqual(['duplicate'])
    expect(book.warnings[0].label).toBe('d')
  })

  it('层级上限截断（默认 4 与自定义）', () => {
    const chain = [
      '正文[^n1]。',
      '',
      '[^n1]: 一层，引[^n2]。',
      '',
      '[^n2]: 二层，引[^n3]。',
      '',
      '[^n3]: 三层，引[^n4]。',
      '',
      '[^n4]: 四层，引[^n5]。',
      '',
      '[^n5]: 五层。'
    ].join('\n')
    const book = parseBook(chain)
    expect(byLabel(book, 'n1')?.level).toBe(1)
    expect(byLabel(book, 'n2')?.level).toBe(2)
    expect(byLabel(book, 'n3')?.level).toBe(3)
    expect(byLabel(book, 'n4')?.level).toBe(4)
    expect(byLabel(book, 'n5')?.level).toBe(4)
    const caps = book.warnings.filter((w) => w.kind === 'level-cap')
    expect(caps).toHaveLength(1)
    expect(caps[0].label).toBe('n5')

    const book2 = parseBook(chain, { levelCap: 2 })
    expect(byLabel(book2, 'n3')?.level).toBe(2)
    expect(byLabel(book2, 'n4')?.level).toBe(2)
    expect(byLabel(book2, 'n5')?.level).toBe(2)
    expect(book2.warnings.filter((w) => w.kind === 'level-cap')).toHaveLength(3)
  })

  it('notes 文档序（A/C/B/D 嵌套交错）', () => {
    const src = [
      '先引[^A]，再引[^B]。',
      '',
      '[^A]: 甲注，内引[^C]。',
      '',
      '[^B]: 乙注，内引[^D]。',
      '',
      '[^C]: 丙注。',
      '',
      '[^D]: 丁注。'
    ].join('\n')
    const book = parseBook(src)
    expect(book.notes.map((n) => n.label)).toEqual(['A', 'C', 'B', 'D'])
    // 作者标号（T23）：plain 自由词 label 原样作为标号 —— A→A、B→B
    const html = book.sections[0].html
    expect(html).toContain(
      `data-note-id="${book.notes[0]?.id}" data-level="1" title="A"><span class="zmu-ref-mark">A</span></sup>`
    )
    expect(html).toContain(
      `data-note-id="${book.notes[2]?.id}" data-level="1" title="B"><span class="zmu-ref-mark">B</span></sup>`
    )
    expect(book.notes.map((n) => n.level)).toEqual([1, 2, 1, 2])
  })
})

/* ================================================================== */
/* Pass A 归一                                                          */
/* ================================================================== */

describe('归一与代码保护', () => {
  it('三种代码形态中的假注不误伤', () => {
    const src = [
      '围栏代码：',
      '',
      '```md',
      '代码块里的[^fake]和[注8]都不算',
      '```',
      '',
      '缩进代码：',
      '',
      '    缩进代码里的[^fake2]不算',
      '',
      '行内代码 `[^fake3]` 不算，真实引用[^real]算。',
      '',
      '[^real]: 真注。'
    ].join('\n')
    const book = parseBook(src)
    expect(book.notes.map((n) => n.label)).toEqual(['real'])
    expect(book.warnings).toEqual([])
    const html = book.sections[0].html
    expect(html).toContain('[^fake]')
    expect(html).toContain('[^fake2]')
    expect(html).toContain('[^fake3]')
    expect(html).toContain(`data-note-id="${byLabel(book, 'real')?.id}"`)
  })

  it('行内注归一为 auto-N（N 从 1 递增）', () => {
    const book = parseBook('一^[甲注]二^[乙注]。')
    expect(book.notes.map((n) => n.label)).toEqual(['auto-1', 'auto-2'])
    expect(book.notes[0]?.level).toBe(1)
    expect(book.notes[0]?.html).toContain('甲注')
    expect(book.sections[0].html).toContain(`data-note-id="${book.notes[0]?.id}"`)
    expect(book.sections[0].html).not.toContain('^[')
  })

  it('行内注可跨行，换行保留', () => {
    const book = parseBook('前文^[跨行注\n第二行]后文。')
    expect(book.notes).toHaveLength(1)
    expect(book.notes[0]?.html).toContain('跨行注')
    expect(book.notes[0]?.html).toContain('第二行')
    expect(book.sections[0].html).toContain('前文')
    expect(book.sections[0].html).toContain('后文')
  })

  it('行内注内可嵌套引用与代码记号', () => {
    const src = '正文^[见[^内]与 `[^code]` 说明]尾。'
    const book = parseBook(src)
    // auto-1 内容含 [^内] → 注内引用；代码记号原样保留
    const auto = byLabel(book, 'auto-1')
    expect(auto).toBeDefined()
    expect(byLabel(book, '内')).toBeDefined()
    expect(book.notes.map((n) => n.label)).toContain('内')
    expect(auto?.html).toContain('[^code]')
    expect(byLabel(book, '内')?.parentIds).toEqual([auto?.id])
    expect(byLabel(book, '内')?.level).toBe(2)
  })

  it('中文注标记归一：[注N] / 【注N】 引用与 注N： 定义', () => {
    const src = '正文引[注1]，又引【注2】。\n\n注1：译者注：第一个。\n\n注2：编者按：第二个。'
    const book = parseBook(src)
    expect(book.notes.map((n) => n.label)).toEqual(['注1', '注2'])
    expect(byLabel(book, '注1')?.type).toBe('translator')
    expect(byLabel(book, '注2')?.type).toBe('editor')
    expect(byLabel(book, '注1')?.html).toContain('第一个')
    expect(byLabel(book, '注2')?.html).toContain('第二个')
    expect(book.sections[0].html).toContain(`data-note-id="${byLabel(book, '注1')?.id}"`)
    expect(book.sections[0].html).toContain(`data-note-id="${byLabel(book, '注2')?.id}"`)
  })

  it('GFM 中文 label（含连字符）', () => {
    const book = parseBook('正文[^序言-确定性]。\n\n[^序言-确定性]: 定义体。')
    const note = byLabel(book, '序言-确定性')
    expect(note).toBeDefined()
    expect(note?.missing).toBeUndefined()
    expect(note?.type).toBe('plain')
    expect(note?.html).toContain('定义体')
  })

  it('定义支持 4 空格缩进续行与多段落', () => {
    const book = parseBook('引[^mp]文。\n\n[^mp]: 第一段。\n\n    第二段续行。')
    const html = byLabel(book, 'mp')?.html ?? ''
    expect(html).toContain('<p>第一段。</p>')
    expect(html).toContain('<p>第二段续行。</p>')
    expect(book.sections[0].html).not.toContain('第二段续行')
  })
})

/* ================================================================== */
/* 类型词表                                                             */
/* ================================================================== */

describe('类型词表', () => {
  it('来源一：label 冒号前缀', () => {
    const cases: Array<[string, NoteRecord['type']]> = [
      ['译者:a', 'translator'],
      ['译按:b', 'translator'],
      ['编者:c', 'editor'],
      ['编注:d', 'editor'],
      ['校注:e', 'editor'],
      ['考据:f', 'textual'],
      ['原文注:g', 'original']
    ]
    for (const [label, type] of cases) {
      expect(byLabel(parseBook(docOf(label, '内容。')), label)?.type, `label=${label}`).toBe(type)
    }
  })

  it('前缀分隔符支持全角冒号', () => {
    const book = parseBook('引[^编者：h]文。\n\n[^编者：h]: 内容。')
    expect(byLabel(book, '编者：h')?.type).toBe('editor')
  })

  it('来源二：定义首词（最长词优先）', () => {
    const cases: Array<[string, NoteRecord['type']]> = [
      ['译者注：内容。', 'translator'],
      ['译者按：内容。', 'translator'],
      ['编者按：内容。', 'editor'], // 最长优先：编者按 → editor，而非「按」→ commentary
      ['编者注：内容。', 'editor'],
      ['考据注：内容。', 'textual'],
      ['原注：内容。', 'original'],
      ['原文注：内容。', 'original'],
      ['考证：内容。', 'textual'],
      ['按：内容。', 'commentary'],
      ['案：内容。', 'commentary'],
      ['疏：内容。', 'commentary'],
      ['无类型词的普通内容。', 'plain']
    ]
    for (const [content, type] of cases) {
      expect(byLabel(parseBook(docOf('g', content)), 'g')?.type, `content=${content}`).toBe(type)
    }
  })

  it('前缀不认识的 label 落到定义首词', () => {
    expect(byLabel(parseBook(docOf('神秘:g', '按：内容。')), '神秘:g')?.type).toBe('commentary')
  })
})

/* ================================================================== */
/* typeLabel：徽标显示作者实际用词（词表定色，词原样保留）                 */
/* ================================================================== */

describe('typeLabel：徽标显示作者实际用词', () => {
  const demoBook = parseBook(fixture)

  it('词表命中（label 前缀）：type=translator 且 typeLabel=命中词「译者按」', () => {
    const book = parseBook('序言[^a]。\n\n[^译者按:a]: 内容。')
    const note = byLabel(book, '译者按:a')
    expect(note?.type).toBe('translator')
    expect(note?.typeLabel).toBe('译者按')
  })

  it('词表命中（定义首词）：typeLabel=「译者注」', () => {
    const book = parseBook(docOf('x', '译者注：内容。'))
    const note = byLabel(book, 'x')
    expect(note?.type).toBe('translator')
    expect(note?.typeLabel).toBe('译者注')
  })

  it('最长优先：编者按 → typeLabel=编者按（而非「按」）', () => {
    const book = parseBook(docOf('x', '编者按：内容。'))
    expect(byLabel(book, 'x')?.type).toBe('editor')
    expect(byLabel(book, 'x')?.typeLabel).toBe('编者按')
  })

  it('自定义词：[^疏证:某概念] → type=plain 且 typeLabel=疏证（前缀语义不丢弃）', () => {
    const book = parseBook('正文[^a]。\n\n[^疏证:某概念]: 内容。')
    const note = byLabel(book, '疏证:某概念')
    expect(note?.type).toBe('plain')
    expect(note?.typeLabel).toBe('疏证')
    // label 本身不受影响：原样保留整体
    expect(note?.label).toBe('疏证:某概念')
  })

  it('全角冒号前缀的自定义词同样保留', () => {
    const book = parseBook('正文[^a]。\n\n[^辨析：概念]: 内容。')
    expect(byLabel(book, '辨析：概念')?.type).toBe('plain')
    expect(byLabel(book, '辨析：概念')?.typeLabel).toBe('辨析')
  })

  it('前缀未命中但定义首词命中：typeLabel=首词命中词', () => {
    const book = parseBook(docOf('神秘:g', '按：内容。'))
    expect(byLabel(book, '神秘:g')?.type).toBe('commentary')
    expect(byLabel(book, '神秘:g')?.typeLabel).toBe('按')
  })

  it('无类型：普通注 typeLabel 缺省（无徽标，与现状一致）', () => {
    const book = parseBook(docOf('x', '普通内容。'))
    expect(byLabel(book, 'x')?.type).toBe('plain')
    expect(byLabel(book, 'x')?.typeLabel).toBeUndefined()
  })

  it('容错：超长自定义词（>12 字符）不作为徽标', () => {
    const book = parseBook('正文[^a]。\n\n[^一二三四五六七八九十百千万:概念]: 内容。')
    const note = byLabel(book, '一二三四五六七八九十百千万:概念')
    expect(note?.type).toBe('plain')
    expect(note?.typeLabel).toBeUndefined()
  })

  it('容错：含标记类字符的自定义词不作为徽标', () => {
    const book = parseBook('正文[^a]。\n\n[^<概念>:x]: 内容。')
    expect(byLabel(book, '<概念>:x')?.type).toBe('plain')
    expect(byLabel(book, '<概念>:x')?.typeLabel).toBeUndefined()
  })

  it('missing 注无定义：typeLabel 缺省', () => {
    const book = parseBook('引[^ghost]。')
    expect(byLabel(book, 'ghost')?.typeLabel).toBeUndefined()
  })

  it('演示书：徽标词忠实于作者（「译者:序-1」显示「译者」而非固定「译者注」）', () => {
    expect(byLabel(demoBook, '译者:序-1')?.typeLabel).toBe('译者')
    expect(byLabel(demoBook, '译按:概念')?.typeLabel).toBe('译按')
    expect(byLabel(demoBook, '考据:确定性考')?.typeLabel).toBe('考据')
    // 定义首词命中的：typeLabel = 首词
    expect(byLabel(demoBook, '注1')?.typeLabel).toBe('译者注')
    // 无类型：缺省
    expect(byLabel(demoBook, '序言-确定性')?.typeLabel).toBeUndefined()
  })
})

/* ================================================================== */
/* Pass C 渲染                                                          */
/* ================================================================== */

describe('渲染', () => {
  it('KaTeX 混排：正文与注内', () => {
    const src = [
      '正文公式 $a^2+b^2=c^2$ 与引用[^k]。',
      '',
      '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
      '',
      '[^k]: 注内公式 $x_1 + x_2 = 2$。'
    ].join('\n')
    const book = parseBook(src)
    expect(book.sections[0].html).toContain('class="katex"')
    expect(book.sections[0].html).toContain('katex-block')
    expect(byLabel(book, 'k')?.html).toContain('class="katex"')
    expect(book.warnings).toEqual([])
  })

  it('未知 label 的 [^x] 按普通文本渲染', () => {
    const book = parseBook('这里是 `[^未知]` 代码里的记号。')
    expect(book.notes).toEqual([])
    expect(book.sections[0].html).toContain('[^未知]')
  })

  it('html: false —— 原始 HTML 被转义', () => {
    const book = parseBook('段落 <script>alert(1)</script> 结束。')
    expect(book.sections[0].html).not.toContain('<script>')
    expect(book.sections[0].html).toContain('&lt;script&gt;')
  })
})

/* ================================================================== */
/* 分章规则                                                             */
/* ================================================================== */

describe('分章规则', () => {
  const para = '这一段大约二十个字符，用来堆积篇幅。'.repeat(10)
  const big = Array.from({ length: 80 }, (_, i) => `第${i}段。${para}`).join('\n\n')
  const small = Array.from({ length: 20 }, (_, i) => `第${i}段。${para}`).join('\n\n')

  it('按 H1 切章', () => {
    const book = parseBook('# 甲\n\n甲文。\n\n# 乙\n\n乙文。')
    expect(book.sections.map((s) => s.title)).toEqual(['甲', '乙'])
    expect(book.sections.map((s) => s.level)).toEqual([1, 1])
    expect(book.toc.map((t) => t.title)).toEqual(['甲', '乙'])
    expect(book.title).toBe('甲')
  })

  it('H1 → H2 瀑布切分（超 1.5 万字才切）', () => {
    const src = `# 巨章\n\n${small}\n\n## 小节一\n\n${small}\n\n## 小节二\n\n${small}\n\n${big}`
    const book = parseBook(src)
    expect(book.sections.map((s) => s.title)).toEqual(['巨章', '小节一', '小节二'])
    expect(book.sections.map((s) => s.level)).toEqual([1, 2, 2])
    expect(book.toc.map((t) => t.sectionId)).toEqual(['sec-1', 'sec-2', 'sec-3'])
    // 未超限的等结构文档不切分
    const tiny = '# 巨章\n\n## 小节一\n\n短文。\n\n## 小节二\n\n短文。'
    expect(parseBook(tiny).sections).toHaveLength(1)
  })

  it('H2 → H3 二次瀑布', () => {
    const src = `# 章\n\n## 节\n\n${big}\n\n### 细一\n\n${small}\n\n### 细二\n\n${small}`
    const book = parseBook(src)
    // 「# 章」标题行单独成导语块，继承父标题「章」；正文不丢
    expect(book.sections.map((s) => s.title)).toEqual(['章', '节', '细一', '细二'])
    expect(book.sections.map((s) => s.level)).toEqual([1, 2, 3, 3])
    expect(book.sections[0].html).toContain('<h1>章</h1>')
    expect(book.toc.map((t) => [t.level, t.sectionId])).toEqual([
      [1, 'sec-1'],
      [2, 'sec-2'],
      [3, 'sec-3'],
      [3, 'sec-4']
    ])
  })

  it('全书无标题：每约 150 段固定切块（§N）', () => {
    const paras = Array.from({ length: 300 }, (_, i) => `第${i}段。内容文字。`).join('\n\n')
    const book = parseBook(paras)
    expect(book.sections).toHaveLength(2)
    expect(book.sections.map((s) => s.title)).toEqual(['§1', '§2'])
    expect(book.title).toBe('')
    expect(book.toc).toEqual([])
    // 每块约 150 段
    expect(book.sections[0].html.match(/<p>/g)?.length).toBe(150)
    expect(book.sections[1].html.match(/<p>/g)?.length).toBe(150)
  })
})

/* ================================================================== */
/* 降级兜底                                                             */
/* ================================================================== */

describe('降级兜底', () => {
  it('非法输入不抛错，产出单 section 纯文本渲染', () => {
    const book = parseBook(null as unknown as string)
    expect(warnKinds(book)).toEqual(['parse-fallback'])
    expect(book.sections).toHaveLength(1)
    expect(book.notes).toEqual([])
    expect(book.stats.noteCount).toBe(0)
    expect(book.toc).toEqual([])
  })

  it('对象输入：正文不丢失且 HTML 转义', () => {
    const evil = { toString: (): string => '段落<bro>与"引号"继续' }
    const book = parseBook(evil as unknown as string)
    expect(warnKinds(book)).toEqual(['parse-fallback'])
    expect(book.sections[0].html).toContain('&lt;bro&gt;')
    expect(book.sections[0].html).not.toContain('<bro>')
    expect(book.sections[0].html).toContain('段落')
  })

  it('降级时尽力提取 H1 标题', () => {
    const withTitle = { toString: (): string => '# 书名\n\n正文段落。' }
    const book = parseBook(withTitle as unknown as string)
    expect(book.title).toBe('书名')
    expect(book.toc).toHaveLength(1)
    expect(book.sections[0].title).toBe('书名')
    expect(book.sections[0].html).toContain('正文段落')
  })

  it('正常输入永不产生 parse-fallback', () => {
    expect(warnKinds(parseBook(fixture))).not.toContain('parse-fallback')
    expect(warnKinds(parseBook(''))).not.toContain('parse-fallback')
    expect(parseBook('').sections).toHaveLength(1)
  })
})

/* ================================================================== */
/* T8-M4：未闭合 ^[ 不吞后续正文                                         */
/* ================================================================== */

describe('未闭合行内注抢断（M4）', () => {
  it('未闭合 ^[ 后跟代码块+标题：正文不丢、代码块按代码渲染', () => {
    const src = [
      '开头文字^[这个行内注没有闭合，后面直接跟代码块',
      '```md',
      '代码内容[^fake]',
      '```',
      '',
      '## 后续标题',
      '',
      '后续正文一句。'
    ].join('\n')
    const book = parseBook(src)
    // 行内注在围栏起始行前被强制闭合，内容完整入注
    expect(book.notes.map((n) => n.label)).toEqual(['auto-1'])
    expect(byLabel(book, 'auto-1')?.html).toContain('这个行内注没有闭合')
    expect(book.sections[0].html).toContain('开头文字')
    expect(book.sections[0].html).toContain(`data-note-id="${byLabel(book, 'auto-1')?.id}"`)
    // 代码块按代码渲染：假注不识别、代码文本原样保留、带语言类名
    expect(book.sections[0].html).toContain('language-md')
    expect(book.sections[0].html).toContain('[^fake]')
    // 标题与后续正文不丢
    expect(book.sections[0].html).toContain('<h2>后续标题</h2>')
    expect(book.sections[0].html).toContain('后续正文一句。')
    expect(warnKinds(book)).not.toContain('parse-fallback')
  })

  it('未闭合 ^[ 遇定义行先闭合，定义正常收集', () => {
    const src = ['起笔[^d]一句。', '正文^[未闭合注开头', '[^d]: 定义内容。'].join('\n')
    const book = parseBook(src)
    expect(book.notes.map((n) => n.label)).toEqual(['d', 'auto-1'])
    expect(byLabel(book, 'd')?.html).toContain('定义内容')
    expect(byLabel(book, 'd')?.missing).toBeUndefined()
    expect(byLabel(book, 'auto-1')?.html).toContain('未闭合注开头')
    expect(book.sections[0].html).toContain('正文')
    expect(book.sections[0].html).toContain(`data-note-id="${byLabel(book, 'auto-1')?.id}"`)
    expect(warnKinds(book)).not.toContain('parse-fallback')
  })

  it('行内注跨行超 50 行强制闭合 + 告警，后续行回归正文', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const lines = ['首句^[注开头']
      for (let i = 0; i < 60; i++) lines.push(`滚行${i}`)
      const book = parseBook(lines.join('\n'))
      const auto = byLabel(book, 'auto-1')
      // 首行 + 50 个续行入注（滚行0..滚行49）；第 51 个续行起回归正文
      expect(auto?.html).toContain('注开头')
      expect(auto?.html).toContain('滚行49')
      expect(auto?.html).not.toContain('滚行50')
      expect(book.sections[0].html).toContain('滚行50')
      expect(book.sections[0].html).toContain('滚行59')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('强制闭合')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

/* ================================================================== */
/* T8-M5：环上 orderKey 缓存不污染文档序                                 */
/* ================================================================== */

describe('环上 orderKey 缓存（M5）', () => {
  it('X↔Y 互引且 X 的正文引用晚于 Y：X 的 orderKey 符合首次引用路径', () => {
    // bodyOrder：Y=0、Z=1、X=2；X↔Y 互引；Y 定义先于 X（顶层先算 Y，
    // 递归中算 X 时 Y 路径被环剪枝——旧实现会把 X 的直接路径 [2] 写入缓存）。
    // 正确结果：X 的首次引用路径 = Y 路径的扩展 [0,0]（经 Y），排序 Y、X、Z；
    // 若缓存被次优 [2] 污染，X 会错排到 Z 之后。
    const src = [
      '先引[^Y]文。',
      '再引[^Z]文。',
      '后引[^X]文。',
      '',
      '[^Y]: Y 定义，参见[^X]。',
      '',
      '[^X]: X 定义，参见[^Y]。',
      '',
      '[^Z]: Z 定义。'
    ].join('\n')
    const book = parseBook(src)
    expect(book.notes.map((n) => n.label)).toEqual(['Y', 'X', 'Z'])
    expect(book.warnings).toEqual([]) // X↔Y 均自正文可达，不算环
    // 作者标号写入 sup（plain 自由词 label 原样，T23）：Y→Y、X→X、Z→Z
    const html = book.sections[0].html
    expect(html).toContain(
      `data-note-id="${byLabel(book, 'Y')?.id}" data-level="1" title="Y"><span class="zmu-ref-mark">Y</span></sup>`
    )
    expect(html).toContain(
      `data-note-id="${byLabel(book, 'X')?.id}" data-level="1" title="X"><span class="zmu-ref-mark">X</span></sup>`
    )
    expect(html).toContain(
      `data-note-id="${byLabel(book, 'Z')?.id}" data-level="1" title="Z"><span class="zmu-ref-mark">Z</span></sup>`
    )
  })
})

/* ================================================================== */
/* T8-M6：围栏 info string 含反引号                                     */
/* ================================================================== */

describe('围栏 info string（M6）', () => {
  it('反引号围栏 info 含反引号不视为围栏（CommonMark）', () => {
    expect(matchFenceOpen('``` js ` x')).toBeNull()
    expect(matchFenceOpen('```` ``` ````')).toBeNull()
    // 正常用例：无 info / 干净 info / 波浪线围栏 info 允许反引号
    expect(matchFenceOpen('```')).toEqual({ ch: '`', len: 3 })
    expect(matchFenceOpen('```js')).toEqual({ ch: '`', len: 3 })
    expect(matchFenceOpen('  ~~~ js ` x')).toEqual({ ch: '~', len: 3 })
  })

  it('info 含反引号的行不进入代码保护：后续引用正常识别', () => {
    const src = ['``` js ` x', '这里的[^n]是真引用。', '', '[^n]: 注。'].join('\n')
    const book = parseBook(src)
    const n = byLabel(book, 'n')
    expect(n).toBeDefined()
    expect(n?.missing).toBeUndefined()
    expect(book.sections[0].html).toContain(`data-note-id="${n?.id}"`)
    expect(warnKinds(book)).not.toContain('parse-fallback')
  })
})

/* ================================================================== */
/* T9：CJK 邻接强调（段首内嵌式加粗，侧翼规则放宽）                        */
/* ================================================================== */

describe('T9：CJK 邻接强调', () => {
  const htmlOf = (src: string): string => parseBook(src).sections.map((s) => s.html).join('')

  it('用户原句：段首内嵌式加粗（闭合 ** 前是 CJK 标点「。」、后紧跟正文）', () => {
    const html = htmlOf('**对位二：安提斯泰尼的反柏拉图命题。**安提斯泰尼将真理标准归于想象。')
    expect(html).toContain('<strong>对位二：安提斯泰尼的反柏拉图命题。</strong>')
    expect(html).not.toContain('**')
  })

  it('段中同款：闭合 ** 前是 CJK 标点', () => {
    const html = htmlOf('前文**中文。**后续')
    expect(html).toContain('<strong>中文。</strong>')
    expect(html).not.toContain('**')
  })

  it('模式矩阵：CJK 之间的成对强调', () => {
    const matrix: Array<[string, string]> = [
      ['**中文**中文', '<strong>中文</strong>中文'],
      ['中文**中文**中文', '中文<strong>中文</strong>中文'],
      ['**中文！**后续', '<strong>中文！</strong>后续'],
      [
        '**对位三：安提斯泰尼。**他将真理标准归于想象。',
        '<strong>对位三：安提斯泰尼。</strong>他将真理标准归于想象。'
      ],
      ['**标题：内容**正文继续。', '<strong>标题：内容</strong>正文继续。']
    ]
    for (const [src, expected] of matrix) {
      const html = htmlOf(src)
      expect(html, `src=${src}`).toContain(expected)
      expect(html, `src=${src}`).not.toContain('**')
    }
  })

  it('独立行加粗不回归', () => {
    expect(htmlOf('**中文加粗**')).toContain('<strong>中文加粗</strong>')
  })

  it('拉丁文场景：foo**bar**baz 保持 strong（纯拉丁行为不变）', () => {
    expect(htmlOf('foo**bar**baz')).toContain('<strong>bar</strong>')
  })

  it('数字乘号场景不破：纯数字间 * 维持基线 em', () => {
    expect(htmlOf('系数为 2×3*4*5 的计算')).toContain('2×3<em>4</em>5')
  })

  it('行内代码中的星号字面保留', () => {
    const html = htmlOf('乘号记号 `*` 与 `**` 保留')
    expect(html).toContain('<code>*</code>')
    expect(html).toContain('<code>**</code>')
  })

  it('注释定义体内同款模式：注释卡 html 中 strong', () => {
    const book = parseBook(
      '正文引用[^t9]。\n\n[^t9]: **对位二：安提斯泰尼的反柏拉图命题。**安提斯泰尼将真理标准归于想象。'
    )
    const html = byLabel(book, 't9')?.html ?? ''
    expect(html).toContain('<strong>对位二：安提斯泰尼的反柏拉图命题。</strong>')
    expect(html).not.toContain('**')
  })

  it('全角星号排查：＊＊ 不是 CommonMark 强调定界符，维持字面输出', () => {
    // 全角 ＊（U+FF0A）不参与强调解析；若用户源文档使用全角星号，
    // 属文档写法问题，不在本修复内归一化（见验收报告建议）。
    const html = htmlOf('＊＊对位二：安提斯泰尼的反柏拉图命题。＊＊后续')
    expect(html).toContain('＊＊对位二：安提斯泰尼的反柏拉图命题。＊＊')
    expect(html).not.toContain('<strong>')
  })
})

/* ================================================================== */
/* T23：displayMark 作者标号（锚点与卡头沿用作者标号，废内部序号）        */
/* ================================================================== */

describe('T23：displayMark 作者标号', () => {
  const markOf = (label: string): string | undefined =>
    parseBook(docOf(label, '定义。')).notes[0]?.displayMark

  it('归一产物分支：中文注数字与行内注 auto-N → 数字本身', () => {
    const cases: Array<[string, string]> = [
      ['注3', '3'],
      ['注12', '12'],
      ['auto-1', '1'],
      ['auto-9', '9']
    ]
    for (const [label, expected] of cases) {
      expect(markOf(label), `label=${label}`).toBe(expected)
    }
  })

  it('半角纯数字 label 原样；类型前缀剥离取余部（半角/全角冒号）', () => {
    expect(markOf('7')).toBe('7')
    expect(markOf('0')).toBe('0')
    expect(markOf('译者:确定性')).toBe('确定性')
    expect(markOf('编者：校记一')).toBe('校记一')
  })

  it('plain 自由词 label 原样作为标号；纯类型词回退文档序', () => {
    // 自由词：整个 label 即作者标号（含连字符与标点，超长时 UI 负责裁切）
    expect(markOf('序言-确定性')).toBe('序言-确定性')
    expect(markOf('a<b')).toBe('a<b')
    // label 是类型词但定义内容不含类型词（类型识别未命中）：原样
    expect(markOf('译者')).toBe('译者')
    // 纯函数直测：类型识别命中整词（label === typeWord）→ 回退文档序
    expect(computeDisplayMark('按', 3, '按')).toBe('3')
    // 纯函数直测：前缀后无内容同样回退（多档 docNumber）
    expect(computeDisplayMark('译者:', 3, '译者')).toBe('3')
    expect(computeDisplayMark('考据：', 7, '考据')).toBe('7')
    // 类型词来自定义首词而非 label 结构：label 原样（标号与类型无关）
    expect(computeDisplayMark('译者按语', 2, '译者')).toBe('译者按语')
    // 端到端回退：定义内容以类型词开头 → 整词被识别消费 → 回退文档序
    const book = parseBook('甲[^译者]引。\n\n[^译者]: 译者：一。\n\n[^编者]: 编者：二。')
    expect(byLabel(book, '译者')?.displayMark).toBe('1')
    expect(byLabel(book, '编者')?.displayMark).toBe('2')
  })

  it('演示书：作者标号可与文档序不一致（注3 → 「3」，文档序 14）', () => {
    const book = parseBook(fixture)
    const n3 = byLabel(book, '注3')
    expect(n3?.displayMark).toBe('3')
    expect(book.notes.findIndex((n) => n.id === n3?.id) + 1).toBe(14)
    expect(byLabel(book, '译者:确定性')?.displayMark).toBe('确定性')
    expect(byLabel(book, '序言-确定性')?.displayMark).toBe('序言-确定性')
  })

  it('标号写入 sup 并 HTML 转义（title 与内层 mark 双通道）', () => {
    const book = parseBook('正文[^a<b]引。\n\n[^a<b]: 定义。')
    const html = book.sections[0].html
    expect(html).toContain('title="a&lt;b"')
    expect(html).toContain('<span class="zmu-ref-mark">a&lt;b</span>')
    expect(html).not.toContain('<a<b')
  })
})

/* ================================================================== */
/* T23：anchorSpots 引用地图上下文（kind + 章标题 / 父注身份）              */
/* ================================================================== */

describe('T23：anchorSpots 引用地图上下文', () => {
  it('body spot 携带所在章标题（kind: body）', () => {
    const book = parseBook('# 甲章\n\n正文引[^n]一次。\n\n[^n]: 定义。')
    expect(byLabel(book, 'n')?.anchorSpots).toEqual([
      { kind: 'body', sectionId: 'sec-1', order: 0, sectionTitle: '甲章' }
    ])
  })

  it('嵌套注：注内引用产出 note spot（父注 id / 标号）', () => {
    const book = parseBook('# 章\n\n正文引[^a]。\n\n[^a]: 甲注参见[^b]。\n\n[^b]: 乙注。')
    const a = byLabel(book, 'a')
    const b = byLabel(book, 'b')
    // 父注 a 无类型词 → 无 parentTypeLabel 字段；displayMark = label 原样
    expect(b?.anchorSpots).toEqual([{ kind: 'note', parentNoteId: a?.id, parentDisplayMark: 'a' }])
    // 父注自身仍带 body spot（order 为全书正文引用全局序，0 起）
    expect(a?.anchorSpots).toEqual([
      { kind: 'body', sectionId: 'sec-1', order: 0, sectionTitle: '章' }
    ])
  })

  it('纯嵌套注（无正文锚）：anchorSpots 仅含 note 条目（死卡 → 可导航）', () => {
    const book = parseBook('# 章\n\n正文引[^a]。\n\n[^a]: 甲注参见[^b]。\n\n[^b]: 纯乙注。')
    const a = byLabel(book, 'a')
    expect(byLabel(book, 'b')?.anchorSpots).toEqual([
      { kind: 'note', parentNoteId: a?.id, parentDisplayMark: 'a' }
    ])
  })

  it('父注类型词传播：note spot 附带 parentTypeLabel', () => {
    const book = parseBook(
      '# 章\n\n正文引[^译者:c]。\n\n[^译者:c]: 译者注参见[^考据:d]。\n\n[^考据:d]: 考据注。'
    )
    const c = byLabel(book, '译者:c')
    expect(byLabel(book, '考据:d')?.anchorSpots).toEqual([
      { kind: 'note', parentNoteId: c?.id, parentDisplayMark: 'c', parentTypeLabel: '译者' }
    ])
  })

  it('多引混合：body 条目在前按 order 升序，note 条目在后', () => {
    const book = parseBook(
      '# 甲\n\n引[^m]一次。[^k]旁证。\n\n[^m]: 甲注，参见[^k]。\n\n[^k]: 乙注。\n\n引[^m]二次。\n\n# 乙\n\n引[^m]三次。'
    )
    const m = byLabel(book, 'm')
    const k = byLabel(book, 'k')
    expect(m?.anchorSpots).toEqual([
      { kind: 'body', sectionId: 'sec-1', order: 0, sectionTitle: '甲' },
      { kind: 'body', sectionId: 'sec-1', order: 2, sectionTitle: '甲' },
      { kind: 'body', sectionId: 'sec-2', order: 3, sectionTitle: '乙' }
    ])
    expect(k?.anchorSpots).toEqual([
      { kind: 'body', sectionId: 'sec-1', order: 1, sectionTitle: '甲' },
      { kind: 'note', parentNoteId: m?.id, parentDisplayMark: 'm' }
    ])
  })

  it('演示书：考据注 / 编者注的引用地图（父注标号与类型徽标词）', () => {
    const book = parseBook(fixture)
    const tr = byLabel(book, '译者:确定性')
    const kg = byLabel(book, '考据:确定性考')
    expect(byLabel(book, '考据:确定性考')?.anchorSpots).toEqual([
      { kind: 'note', parentNoteId: tr?.id, parentDisplayMark: '确定性', parentTypeLabel: '译者' }
    ])
    expect(byLabel(book, '编者:校记一')?.anchorSpots).toEqual([
      { kind: 'note', parentNoteId: kg?.id, parentDisplayMark: '确定性考', parentTypeLabel: '考据' }
    ])
  })
})
