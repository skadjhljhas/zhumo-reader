/**
 * Pass B —— 注释图。
 *
 * 以正文为虚拟根建图：
 *   - 正文引用 → 出边（层级 1）；注内引用 → 嵌套边（父注层级 + 1）
 *   - BFS 求每注最浅层级；超过 cap 封顶并告警
 *   - BFS 不可达的互引子图（纯环及其附庸）整体封顶为 cap 并记 cycle 警告
 *   - 文档序 = 「首次被引用位置路径」字典序（注内引用排在其父注之后），
 *     孤儿与纯环成员按创建序殿后
 *
 * 容错：引用无定义 → missing（html 为空）；定义无引用 → orphan（层级 1）；
 * 重复定义已在 Pass A 取首个并告警。
 */
import type { ParseWarning } from '../../../shared/types'
import type { NoteGraph, NoteNode, PreprocessResult } from './types'
import { computeDisplayMark, detectNoteTypeDetailed, isValidTypeLabelWord } from './scan'

type PathHit = { bodyOrder: number } | { parent: string; localOrder: number }

function lexCompare(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length // 前缀路径排在扩展路径之前
}

export function buildGraph(pre: PreprocessResult, cap: number): NoteGraph {
  const warnings: ParseWarning[] = []
  const nodes: NoteNode[] = []
  const byLabel = new Map<string, NoteNode>()
  const seqOf = new Map<string, number>()

  const createNode = (label: string, hasDef: boolean, contentLines: string[]): NoteNode => {
    // 类型识别：type 供配色/统计，typeLabel 为作者实际用词（词表命中词或自定义前缀词）
    const detected = hasDef ? detectNoteTypeDetailed(label, contentLines) : null
    const word = detected?.word ?? null
    const node: NoteNode = {
      id: '',
      number: 0,
      displayMark: '',
      label,
      hasDef,
      type: detected?.type ?? 'plain',
      typeLabel: isValidTypeLabelWord(word) ? word : undefined,
      level: 0,
      parents: [],
      refCount: 0,
      orderKey: null,
      bodyHits: [],
      contentLines,
      orphan: false,
      cycle: false
    }
    seqOf.set(label, nodes.length)
    byLabel.set(label, node)
    nodes.push(node)
    return node
  }

  // 1. 定义节点
  for (const def of pre.definitions) {
    if (!byLabel.has(def.label)) createNode(def.label, true, def.lines)
  }

  // 2. 引用命中：入边表（含正文命中）、出边表、父注、refCount
  const inHits = new Map<string, PathHit[]>()
  const outEdges = new Map<string, string[]>()
  const ensure = (label: string): NoteNode => byLabel.get(label) ?? createNode(label, false, [])

  for (const hit of pre.bodyRefs) {
    const node = ensure(hit.label)
    node.refCount++
    node.bodyHits.push({ line: hit.line, order: hit.order })
    const list = inHits.get(hit.label)
    if (list) list.push({ bodyOrder: hit.order })
    else inHits.set(hit.label, [{ bodyOrder: hit.order }])
  }
  for (const ref of pre.noteRefs) {
    const node = ensure(ref.target)
    node.refCount++
    if (!node.parents.includes(ref.parent)) node.parents.push(ref.parent)
    const list = inHits.get(ref.target)
    if (list) list.push({ parent: ref.parent, localOrder: ref.localOrder })
    else inHits.set(ref.target, [{ parent: ref.parent, localOrder: ref.localOrder }])
    let outs = outEdges.get(ref.parent)
    if (!outs) {
      outs = []
      outEdges.set(ref.parent, outs)
    }
    outs.push(ref.target)
  }

  // 3. missing 警告
  for (const node of nodes) {
    if (!node.hasDef) {
      warnings.push({
        kind: 'missing',
        label: node.label,
        message: `引用了未定义的注释，锚点保留但注释体为空：「${node.label}」`
      })
    }
  }

  // 4. BFS 层级：正文引用与孤儿同为 1 级根，取最浅
  const levels = new Map<string, number>()
  const queue: string[] = []
  for (const hit of pre.bodyRefs) {
    if (!levels.has(hit.label)) {
      levels.set(hit.label, 1)
      queue.push(hit.label)
    }
  }
  for (const node of nodes) {
    if (
      node.hasDef &&
      node.bodyHits.length === 0 &&
      node.parents.length === 0 &&
      !levels.has(node.label)
    ) {
      node.orphan = true
      levels.set(node.label, 1)
      queue.push(node.label)
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const label = queue[qi]
    const lvl = levels.get(label) ?? 0
    for (const target of outEdges.get(label) ?? []) {
      if (!levels.has(target)) {
        levels.set(target, lvl + 1)
        queue.push(target)
      }
    }
  }

  // 5. 不可达子图（纯环及其附庸）：封顶 cap，按连通分量记 cycle 警告；
  //    分量内全体成员（含附庸）都置 cycle 标志，供 UI 逐卡标记
  const unreachable = nodes.filter((n) => !levels.has(n.label))
  if (unreachable.length > 0) {
    for (const n of unreachable) {
      n.level = cap
      n.cycle = true
    }
    const adj = new Map<string, string[]>()
    const link = (a: string, b: string): void => {
      let la = adj.get(a)
      if (!la) adj.set(a, (la = []))
      let lb = adj.get(b)
      if (!lb) adj.set(b, (lb = []))
      la.push(b)
      lb.push(a)
    }
    for (const ref of pre.noteRefs) {
      if (!levels.has(ref.parent) && !levels.has(ref.target)) link(ref.parent, ref.target)
    }
    const seen = new Set<string>()
    for (const n of unreachable) {
      if (seen.has(n.label)) continue
      const comp: string[] = []
      const stack = [n.label]
      seen.add(n.label)
      while (stack.length > 0) {
        const cur = stack.pop() as string
        comp.push(cur)
        for (const nb of adj.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb)
            stack.push(nb)
          }
        }
      }
      warnings.push({
        kind: 'cycle',
        label: comp[0],
        message: `注释互引成环（自正文不可达），层级封顶为 ${cap}：${comp.join('、')}`
      })
    }
  }

  // 6. 层级赋值与封顶告警；孤儿警告
  for (const node of nodes) {
    const lvl = levels.get(node.label)
    if (lvl === undefined) continue // 不可达子图已封顶
    if (lvl > cap) {
      node.level = cap
      warnings.push({
        kind: 'level-cap',
        label: node.label,
        message: `注释层级超过上限 ${cap}，已封顶：「${node.label}」`
      })
    } else {
      node.level = lvl
    }
    if (node.orphan) {
      warnings.push({
        kind: 'orphan',
        label: node.label,
        message: `注释定义从未被引用：「${node.label}」`
      })
    }
  }

  // 7. 文档序：首次被引用位置路径（带环保护的递归最小字典序路径）
  const keyMemo = new Map<string, number[]>()
  const nullMemo = new Set<string>()
  /** 递归结果：key = 可用最小路径（null = 确无正文可达路径）；
   *  dirty = 本次计算经过环剪枝，key 可能因此偏大（次优）。 */
  interface KeyOutcome {
    key: number[] | null
    dirty: boolean
  }
  const computeKey = (label: string, visiting: Set<string>): KeyOutcome => {
    const memo = keyMemo.get(label)
    if (memo) return { key: memo, dirty: false }
    if (nullMemo.has(label)) return { key: null, dirty: false }
    if (visiting.has(label)) return { key: null, dirty: true } // 环上路径：不终止于正文，作废
    visiting.add(label)
    let best: number[] | null = null
    let dirty = false
    for (const hit of inHits.get(label) ?? []) {
      let cand: number[] | null
      if ('bodyOrder' in hit) {
        cand = [hit.bodyOrder]
      } else {
        const pk = computeKey(hit.parent, visiting)
        dirty = dirty || pk.dirty // 子树碰环：本次 best 可能非最优，不得写入 memo
        cand = pk.key === null ? null : pk.key.concat(hit.localOrder)
      }
      if (cand !== null && (best === null || lexCompare(cand, best) < 0)) best = cand
    }
    visiting.delete(label)
    if (!dirty) {
      // M5：仅干净（未碰环）的结果才可 memo——环剪枝期间算出的次优 key
      // 一旦被缓存，后续顶层命中会永久拿到错误排序键
      if (best !== null) keyMemo.set(label, best)
      else if (visiting.size === 0) nullMemo.add(label) // 顶层判定：确无正文可达路径
    }
    return { key: best, dirty }
  }
  for (const node of nodes) {
    node.orderKey = computeKey(node.label, new Set()).key
  }

  // 8. 排序：有路径者按路径；无路径者（孤儿/纯环）按创建序殿后
  const ordered = [...nodes].sort((a, b) => {
    if (a.orderKey && b.orderKey) return lexCompare(a.orderKey, b.orderKey)
    if (a.orderKey) return -1
    if (b.orderKey) return 1
    return (seqOf.get(a.label) ?? 0) - (seqOf.get(b.label) ?? 0)
  })
  ordered.forEach((n, i) => {
    n.number = i + 1
    n.id = `note-${i + 1}`
    n.displayMark = computeDisplayMark(n.label, i + 1, n.typeLabel) // T23：作者标号
  })

  return { nodes: ordered, byLabel, warnings, cap }
}
