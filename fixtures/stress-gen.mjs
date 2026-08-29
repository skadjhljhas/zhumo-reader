#!/usr/bin/env node
/**
 * 朱墨压测书生成器（可重复执行，固定种子，输出逐字节一致）。
 *
 * 生成《压测书·五十万字》：约 50 万汉字中文学术正文 + 约 3000 条注释，
 * 专供解析与渲染性能压测（浏览器 ?book=stress-50w）。
 *
 * 结构要求：
 * - 书名 H1；正文章节 H1 共十章；每章四节（H2），章内另设两个小节（H3），
 *   保证 H1/H2/H3 层级齐备（解析器按 H1 分章、超 1.5 万字按 H2 二次切分）
 * - 注释 1–3 层嵌套（约 70% / 22% / 8%），六种类型，
 *   GFM `[^label]` / 中文注 `[注N]`·`【注N】` / 行内注 `^[……]` 三种写法混合
 * - 内联与块级 KaTeX 公式散布；约一成注释为多引（正文两至三处引用）
 * - 段落由模板句随机拼接组合，整段重复会被拒绝重造
 *
 * 用法：node fixtures/stress-gen.mjs [--out <file>]
 * 默认输出 public/demo/stress-50w.md，并打印体量与注释分布统计。
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 生成器脚本，无 TS 类型注解 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* 可复现伪随机（LCG，种子固定）                                        */
/* ------------------------------------------------------------------ */
let seed = 20260825
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)]
}
function randInt(a, b) {
  return a + Math.floor(rnd() * (b - a + 1))
}
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/* ------------------------------------------------------------------ */
/* 语料池（中文学术风；句中不含 []^$ 等标记字符）                       */
/* ------------------------------------------------------------------ */
const OPENERS = [
  '学界通说以为',
  '细读文本即可发现',
  '参照历代注疏的传统',
  '从语文学的角度看',
  '以思想史的纵深衡量',
  '若将视野放宽至整个时代',
  '把版本源流摊开对勘',
  '就论证的结构而言',
  '回到概念最初的用法',
  '比较诸家异说之后',
  '检视档案与抄本的残留',
  '沿目录学的线索追溯',
  '在训诂与义理的交汇处',
  '考察知识生产的制度背景',
  '从读者的接受史着眼',
  '综合前修时贤的研究',
  '避开现代成见的干扰',
  '将文本放回其写作现场',
  '检讨旧说的证据链',
  '对照译本与原文的差异'
]
const SUBJECTS = [
  '概念的内在张力',
  '方法的自觉',
  '文献的层累',
  '语词的流变',
  '制度的惯性',
  '叙事的褶皱',
  '证据的重量',
  '范畴的边界',
  '注疏的传统',
  '论证的骨架',
  '思想的分寸感',
  '史料的沉默处',
  '译名的取舍',
  '章节的分合',
  '体例的嬗递',
  '学派的对峙',
  '经典的正典化',
  '异文的谱系',
  '引文的变形',
  '术语的旅行',
  '语境的重构',
  '材料的密度',
  '判断的先设',
  '修辞的策略',
  '时间的层次'
]
const PREDICATES = [
  '并非凝固的实体，而是在具体语境中不断被重新赋义的活物',
  '只有在历史脉络的还原中才能获得恰当的估量',
  '远比目录学表象所暗示的更为错综',
  '往往在细节处显露出整体框架未曾言明的预设',
  '构成了任何宏大叙述都必须首先面对的硬约束',
  '经历了由边缘而中心、再由中心而边缘的往返运动',
  '其成立与否，取决于我们对证据完整性的耐心',
  '与其说被材料本身决定，不如说被提问方式悄悄塑造',
  '在抄本时代与印本时代呈现出截然不同的面貌',
  '提示我们语言的形式本身即是思想的形式',
  '使得单纯的直线进步叙事难以自圆其说',
  '恰恰是各家学说相互界定之后的剩余物',
  '需要同时容纳正例、反例与旁证三类材料的检验',
  '在译介过程中既有损耗也有意外的增殖',
  '从来不是中立的容器，而始终参与意义的生成'
]
const CONNECTIVES = [
  '然而',
  '进而言之',
  '要而言之',
  '由此观之',
  '反观旧说',
  '沿此线索',
  '不仅如此',
  '值得留意的是',
  '尤可注意者',
  '倘若放宽视野',
  '与此相应',
  '问题在于',
  '细究其故',
  '换一个角度看',
  '另一方面'
]
const CLOSERS = [
  '此点前人论之未详',
  '其义理脉络至此方显',
  '这一判断可以立足',
  '细节的考证此处从略',
  '其影响一直延伸到后世',
  '学界于此尚有争议',
  '此处仅能点到为止',
  '有待更充分的材料印证',
  '旧说之失正在于此',
  '此为其思想史意义所在'
]
const MATH_LEADS = [
  '不妨以简明的形式记之',
  '形式化之后一目了然',
  '其关系可以表述为',
  '试以下式概括',
  '数量关系约略如下'
]
const INLINE_MATH = [
  '$f(x)=\\alpha x^{2}+\\beta x+\\gamma$',
  '$\\Delta=b^{2}-4ac$',
  '$\\hat{\\theta}_{n}\\to\\theta$',
  '$\\int_{0}^{1}x^{k}\\,dx=\\frac{1}{k+1}$',
  '$e^{i\\pi}+1=0$',
  '$\\|A\\|_{2}\\le\\|A\\|_{F}$',
  '$\\sin^{2}\\theta+\\cos^{2}\\theta=1$',
  '$\\lim_{n\\to\\infty}(1+\\tfrac{1}{n})^{n}=e$',
  '$P(A\\mid B)=\\dfrac{P(B\\mid A)P(A)}{P(B)}$',
  '$\\sum_{k=0}^{n}\\binom{n}{k}=2^{n}$'
]
const BLOCK_MATH = [
  '$$\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}=\\frac{\\pi^{2}}{6}$$',
  '$$\\frac{\\partial u}{\\partial t}=D\\frac{\\partial^{2}u}{\\partial x^{2}}$$',
  '$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\\begin{pmatrix} x \\\\ y \\end{pmatrix}=\\begin{pmatrix} ax+by \\\\ cx+dy \\end{pmatrix}$$',
  '$$\\oint_{\\partial\\Omega}\\mathbf{F}\\cdot d\\mathbf{r}=\\iint_{\\Omega}(\\nabla\\times\\mathbf{F})\\cdot d\\mathbf{S}$$',
  '$$\\mathrm{Var}(\\bar{X})=\\frac{\\sigma^{2}}{n}$$',
  '$$\\int_{-\\infty}^{\\infty}e^{-x^{2}}\\,dx=\\sqrt{\\pi}$$'
]

const CHAPTER_TITLES = [
  '概念的分野',
  '方法的谱系',
  '文献的地层',
  '语词的迁徙',
  '制度的重量',
  '叙事的构造',
  '注疏的接力',
  '译介的得失',
  '论证的经纬',
  '余论：整体的远景'
]
const SECTION_TITLES = [
  '通说与疑点',
  '材料的限度',
  '线索的整理',
  '个案的剖析',
  '异说的对勘',
  '时段的切分',
  '术语的界定',
  '结构的重估',
  '旁证的搜集',
  '结论的收敛'
]
const SUBSECTION_TITLES = ['一个待决的细节', '方法论的省思', '与旧说的对话', '补记一则例证']

/* 注释类型词（定义首词，与扫描器词表一致；plain 无词，注意 plain 首词避开类型词） */
const TYPE_OPENERS = {
  translator: ['译者注：', '译按：'],
  editor: ['编者按：', '编注：', '校注：'],
  textual: ['考据：', '考证：'],
  original: ['原注：'],
  commentary: ['按：', '疏：', '案：'],
  plain: ['']
}

/* ------------------------------------------------------------------ */
/* 注释计划                                                            */
/* ------------------------------------------------------------------ */
/* 数量：GFM L1 1500（含多引 150）、L2 660、L3 240；中文注 400；行内注 200 → 共 3000 */
const COUNT_L1_GFM = 1500
const COUNT_L2 = 660
const COUNT_L3 = 240
const COUNT_ZH = 400
const COUNT_INLINE = 200
const COUNT_MULTI = 150
const TARGET_HAN = 500_000

const TYPE_KEYS = ['translator', 'editor', 'textual', 'original', 'commentary', 'plain']
/** GFM label 前缀 → 类型（「压」为无类型词的普通注前缀） */
const GFM_PREFIX = {
  translator: '译者',
  editor: '编者',
  textual: '考据',
  original: '原文',
  commentary: '疏',
  plain: '压'
}
const counters = {}
function nextLabel(prefix) {
  counters[prefix] = (counters[prefix] ?? 0) + 1
  return `${prefix}:${counters[prefix]}`
}

const NOTE_SENTS = [
  '此点在初版的页边批语中已有提示，惜未引起足够注意',
  '参校两种重排本之后，此处文字应当从旧钞',
  '编者最初拟删此句，后经商量予以保留',
  '术语在此处的用法与通行义不同，读者宜随文留意',
  '该例证后来被多处转引，文字已有小幅讹变',
  '相关档案现藏于两地，整理本尚未汇合',
  '旧译于此失之太实，今改从虚译，以存语气',
  '注疏史上对此段的理解曾有过一次重要的转向',
  '此语的出处久已不明，近来方有学者考得',
  '同类例子尚有三四处，兹不备举',
  '按原书体例，此类说明本应入凡例，今姑系于此',
  '这一点承审读人指出，谨致谢忱',
  '抄本此处有朱笔校改，笔迹与正文不同',
  '译文初稿与定稿在此处分歧最大',
  '后人续写的部分与原本已有程度不等的混合'
]

/** 注释体：类型词 + 1–3 句 + 可选行内公式；少量双段（4 空格缩进续行） */
function noteBody(type, withMath) {
  const opener = pick(TYPE_OPENERS[type])
  const sents = []
  const n = randInt(1, 3)
  for (let i = 0; i < n; i++) sents.push(pick(NOTE_SENTS))
  let first = opener + sents.shift()
  if (withMath && rnd() < 0.4) first += '。又，' + pick(MATH_LEADS) + '：' + pick(INLINE_MATH)
  const lines = [first + '。']
  if (rnd() < 0.12) {
    lines.push('', '    ' + pick(NOTE_SENTS) + '，' + pick(NOTE_SENTS) + '。')
  }
  return lines
}

function makeGfmNote(type, level) {
  const label = nextLabel(GFM_PREFIX[type])
  return { label, kind: 'gfm', type, level, body: null, childRefs: [] }
}

function buildNotes() {
  const l1 = []
  const l2 = []
  const l3 = []
  for (let i = 0; i < COUNT_L1_GFM; i++) l1.push(makeGfmNote(TYPE_KEYS[i % 6], 1))
  for (let i = 0; i < COUNT_L2; i++) l2.push(makeGfmNote(pick(TYPE_KEYS), 2))
  for (let i = 0; i < COUNT_L3; i++) l3.push(makeGfmNote(pick(TYPE_KEYS), 3))
  // 嵌套链：每条 L2 挂到一个 L1 父；每条 L3 挂到一个 L2 父
  for (const child of l2) pick(l1).childRefs.push(child.label)
  for (const child of l3) pick(l2).childRefs.push(child.label)
  // 注释体：L1/L2 体末追加子注引用（形成 2/3 层嵌套）；L3 无子
  for (const note of [...l1, ...l2, ...l3]) {
    note.body = noteBody(note.type, rnd() < 0.15)
    if (note.childRefs.length > 0) {
      const refs = note.childRefs.map((c) => `[^${c}]`).join('、')
      note.body[0] = note.body[0].slice(0, -1) + '（相关讨论见 ' + refs + '。）'
    }
  }
  // 中文注：注1..注N；定义首词决定类型（plain 略多）
  const zh = []
  for (let i = 1; i <= COUNT_ZH; i++) {
    const type = rnd() < 0.45 ? 'plain' : pick(TYPE_KEYS)
    zh.push({ label: `注${i}`, kind: 'zh', type, level: 1, body: noteBody(type, rnd() < 0.1) })
  }
  return { l1, l2, l3, zh }
}

/* ------------------------------------------------------------------ */
/* 句子与段落                                                          */
/* ------------------------------------------------------------------ */
const seenPara = new Set()

function makeSentence() {
  const useOpener = rnd() < 0.45
  const useCloser = rnd() < 0.25
  return (
    (useOpener ? pick(OPENERS) + '，' : '') +
    pick(SUBJECTS) +
    pick(PREDICATES) +
    (useCloser ? '——' + pick(CLOSERS) : '') +
    '。'
  )
}

/** 生成一个段落（3–6 句；连接词起句增加变化）；整段重复返回 null 重造 */
function makePara() {
  const n = randInt(3, 6)
  const parts = []
  for (let i = 0; i < n; i++) {
    if (i > 0 && rnd() < 0.5) parts.push(pick(CONNECTIVES) + '，' + makeSentence())
    else parts.push(makeSentence())
  }
  const text = parts.join('')
  if (seenPara.has(text)) return null
  seenPara.add(text)
  return text
}

/** 在句号后插入引用标记（避免截断标记；兜底追加到段首/段尾） */
function insertRefs(para, markers) {
  if (markers.length === 0) return para
  const positions = []
  for (let i = 0; i < para.length; i++) if (para[i] === '。') positions.push(i)
  if (positions.length === 0) return para + markers.join('')
  let out = para
  let inserted = 0
  for (let k = positions.length - 1; k >= 0 && markers.length > 0; k--) {
    const p = positions[k]
    if (rnd() < 0.6) {
      const m = markers.pop()
      out = out.slice(0, p + 1) + m + out.slice(p + 1)
      inserted++
    }
  }
  while (markers.length > 0 && inserted < 2) {
    const m = markers.pop()
    out = out + m
    inserted++
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 组书                                                                */
/* ------------------------------------------------------------------ */
function hanCount(s) {
  return (s.match(/[\u4e00-\u9fff]/g) || []).length
}

function buildBook() {
  const { l1, l2, l3, zh } = buildNotes()
  const lines = []

  // —— 正文引用标记池：L1 GFM + 中文注（写法混合）+ 多引额外出现 ——
  const markers = []
  for (const n of l1) markers.push(`[^${n.label}]`)
  for (const n of zh) markers.push(rnd() < 0.5 ? `[${n.label}]` : `【${n.label}】`)
  const multi = shuffle(l1).slice(0, COUNT_MULTI)
  for (const n of multi) {
    const extra = randInt(1, 2)
    for (let i = 0; i < extra; i++) markers.push(`[^${n.label}]`)
  }
  const markerPool = shuffle(markers)

  // 注释体汉字先计入总量，正文目标 = 目标 - 注释体 - 导语
  let noteHan = 0
  for (const n of [...l1, ...l2, ...l3, ...zh]) for (const l of n.body) noteHan += hanCount(l)

  lines.push('# 压测书·五十万字', '')
  lines.push(
    '本书为朱墨阅读器的性能压测用书：十章正文、约三千条注释、公式与嵌套注齐备。文本由模板句随机组合而成，不表达任何实际观点。',
    ''
  )
  const introHan = 60
  const perChapter = Math.floor((TARGET_HAN - noteHan - introHan) / 10)
  let inlineLeft = COUNT_INLINE

  for (let c = 0; c < 10; c++) {
    lines.push(`# 第${'一二三四五六七八九十'[c]}章\u3000${CHAPTER_TITLES[c]}`, '')
    if (c % 2 === 0) {
      lines.push(pick(MATH_LEADS) + '：', '', pick(BLOCK_MATH), '')
    }
    // 本章标记配额：均分剩余标记
    const chapterMarkers = markerPool.splice(0, Math.ceil(markerPool.length / (10 - c)))
    const sections = shuffle(SECTION_TITLES).slice(0, 4)
    for (let s = 0; s < 4; s++) {
      lines.push(`## ${s + 1}\u3000${sections[s]}`, '')
      const sub = s === 1 || s === 3 ? pick(SUBSECTION_TITLES) : null
      const secTarget = Math.ceil(perChapter / 4)
      let wrote = 0
      let inSub = false
      while (wrote < secTarget) {
        if (sub && !inSub && wrote > secTarget * 0.4) {
          lines.push(`### ${sub}`, '')
          inSub = true
        }
        let para = makePara()
        if (para === null) continue
        // 标记投放概率自适应：剩余标记 / 估算剩余段落，保证全部消化
        const parasLeft = Math.max(1, Math.ceil((secTarget - wrote) / 110))
        const p = Math.min(1, chapterMarkers.length / parasLeft)
        if (chapterMarkers.length > 0 && rnd() < p) {
          const take = rnd() < 0.15 && chapterMarkers.length > 1 ? 2 : 1
          para = insertRefs(para, chapterMarkers.splice(-take))
        }
        // 行内注（预算内、三成概率）：段末附 ^[类型词：……]
        if (inlineLeft > 0 && rnd() < 0.3) {
          const opener = pick(['疏：', '按：', '译者按：', '案：'])
          para = para + '^[' + opener + pick(NOTE_SENTS) + '。]'
          inlineLeft--
        }
        // 行内公式：首个句号后插入数学句
        if (rnd() < 0.16) {
          const m = pick(MATH_LEADS) + '：' + pick(INLINE_MATH) + '。'
          const idx = para.indexOf('。') + 1
          para = para.slice(0, idx) + m + para.slice(idx)
        }
        lines.push(para, '')
        wrote += hanCount(para)
      }
      if (rnd() < 0.35) {
        lines.push(pick(MATH_LEADS) + '：', '', pick(BLOCK_MATH), '')
      }
    }
    // 章末兜底：未消化的标记补段落投放，避免产生非预期孤儿注释
    while (chapterMarkers.length > 0) {
      let para = makePara()
      if (para === null) continue
      para = insertRefs(para, chapterMarkers.splice(-Math.min(2, chapterMarkers.length)))
      lines.push(para, '')
    }
  }

  // —— 定义区（文末统一存放；中文注按编号序，GFM 按 L1→L2→L3 分组）——
  lines.push('---', '')
  const defNote = (n) => {
    lines.push(`[^${n.label}]: ${n.body[0]}`)
    for (const r of n.body.slice(1)) lines.push(r)
    lines.push('')
  }
  const defZh = (n) => {
    lines.push(`${n.label}: ${n.body[0]}`)
    for (const r of n.body.slice(1)) lines.push(r)
    lines.push('')
  }
  for (const n of zh) defZh(n)
  for (const n of l1) defNote(n)
  for (const n of l2) defNote(n)
  for (const n of l3) defNote(n)

  return { text: lines.join('\n') + '\n', notes: { l1, l2, l3, zh }, multi, inlineLeft }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const out =
  outIdx >= 0 && args[outIdx + 1]
    ? resolve(args[outIdx + 1])
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'renderer',
        'public',
        'demo',
        'stress-50w.md'
      )

const { text, notes, multi, inlineLeft } = buildBook()
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, text, 'utf8')

const han = hanCount(text)
const h1 = (text.match(/^# /gm) || []).length
const h2 = (text.match(/^## /gm) || []).length
const h3 = (text.match(/^### /gm) || []).length
const noteTotal =
  notes.l1.length + notes.l2.length + notes.l3.length + notes.zh.length + COUNT_INLINE
const typeDist = {}
for (const n of [...notes.l1, ...notes.l2, ...notes.l3, ...notes.zh]) {
  typeDist[n.type] = (typeDist[n.type] ?? 0) + 1
}
const blockMath = (text.match(/^\$\$.+?\$\$/gm) || []).length
const inlineMath = (text.replace(/^\$\$.+?\$\$/gm, '').match(/\$[^$\n]+\$/g) || []).length

console.log('压测书已生成 →', out)
console.log(
  `全书总字符：${text.length}（UTF-8 ${(Buffer.byteLength(text, 'utf8') / 1024 / 1024).toFixed(2)} MB）`
)
console.log(`汉字数：${han}`)
console.log(
  `注释总数：${noteTotal}（GFM-L1 ${notes.l1.length} / GFM-L2 ${notes.l2.length} / GFM-L3 ${notes.l3.length} / 中文注 ${notes.zh.length} / 行内注 ${COUNT_INLINE - inlineLeft}）`
)
console.log(
  `层级分布：L1 ${notes.l1.length + notes.zh.length + (COUNT_INLINE - inlineLeft)} / L2 ${notes.l2.length} / L3 ${notes.l3.length}`
)
console.log(
  `类型分布：${Object.entries(typeDist)
    .map(([k, v]) => `${k} ${v}`)
    .join('，')}（另加行内注）`
)
console.log(`多引注释：${multi.length} 条（正文两至三处引用）`)
console.log(`标题：H1 ${h1} / H2 ${h2} / H3 ${h3}`)
console.log(`KaTeX：行内 ${inlineMath} 处，块级 ${blockMath} 处`)
if (inlineLeft > 0) console.log(`（行内注预算剩余 ${inlineLeft}）`)
