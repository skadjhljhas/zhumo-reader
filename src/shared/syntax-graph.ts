import type {
  SyntaxAnalysis,
  SyntaxLayer,
  SyntaxQuote,
  SyntaxRelation,
  SyntaxRole,
  SyntaxSpan,
  SyntaxStatus
} from './ai-types'

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('句法对象格式不完整。')
  return value as Record<string, unknown>
}
function text(value: unknown, name: string, max = 1200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw Error(`句法${name}缺失或过长。`)
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw Error('句法单位或关系 ID 不合法。')
  return value
}
function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw Error(`句法${name}列表缺失或过大。`)
  return value
}
function status(value: unknown): SyntaxStatus {
  if (!['supported', 'possible', 'unresolved'].includes(value as string))
    throw Error('句法证据状态不合法。')
  return value as SyntaxStatus
}
function references(value: unknown, known: Set<string>, name: string, max: number): string[] {
  const ids = list(value, name, max).map(id)
  if (new Set(ids).size !== ids.length || ids.some((key) => !known.has(key)))
    throw Error(`句法${name}含重复或不存在的 ID。`)
  return ids
}
export function locateSyntaxQuote(value: unknown, selected: string): SyntaxQuote {
  const anchor = object(value),
    quote = text(anchor.quote, '原文片段', 12000)
  if (
    !Number.isInteger(anchor.occurrence) ||
    Number(anchor.occurrence) < 1 ||
    Number(anchor.occurrence) > selected.length
  )
    throw Error('句法片段出现次数不正确。')
  let start = -1
  for (let i = 0; i < Number(anchor.occurrence); i++) {
    start = selected.indexOf(quote, start + 1)
    if (start < 0) throw Error('句法片段无法在原句中逐字对应，未应用光效。')
  }
  const end = start + quote.length
  // Exact string matching must also respect surrogate pairs.
  if (
    (start > 0 &&
      /[\uDC00-\uDFFF]/.test(selected[start]) &&
      /[\uD800-\uDBFF]/.test(selected[start - 1])) ||
    (end < selected.length &&
      /[\uDC00-\uDFFF]/.test(selected[end]) &&
      /[\uD800-\uDBFF]/.test(selected[end - 1]))
  )
    throw Error('句法锚点切开了一个 Unicode 字符。')
  return { quote, occurrence: Number(anchor.occurrence), start, end }
}
export function parseSyntaxGraph(
  raw: Record<string, unknown>,
  selected: string,
  roles: Record<string, string>
): SyntaxAnalysis {
  if (raw.text !== selected) throw Error('句法结果与所选原句不一致，未应用光效。')
  const unitIds = new Set<string>()
  let anchorsCount = 0
  const spans = list(raw.units, '单位', 96).map((value) => {
    const u = object(value),
      key = id(u.id)
    if (unitIds.has(key)) throw Error('句法单位 ID 重复。')
    unitIds.add(key)
    if (
      !['syntax', 'meaning', 'discourse'].includes(u.layer as string) ||
      !Object.hasOwn(roles, String(u.role))
    )
      throw Error('句法分析层或角色不合法。')
    if (u.implicit !== undefined && typeof u.implicit !== 'boolean')
      throw Error('隐含单位标志不合法。')
    const anchors = list(u.anchors, '锚点', 6).map((a) => locateSyntaxQuote(a, selected))
    if ((u.implicit === true && anchors.length) || (u.implicit !== true && !anchors.length))
      throw Error('显式与隐含单位的原文锚点不一致。')
    for (let i = 1; i < anchors.length; i++)
      if (anchors[i].start < anchors[i - 1].end) throw Error('同一单位的锚点应按原文顺序且不重叠。')
    anchorsCount += anchors.length
    if (anchorsCount > 256) throw Error('句法锚点过多，请缩小选区。')
    const label = text(u.label, '标签', 64)
    return {
      id: key,
      layer: u.layer as SyntaxLayer,
      role: u.role as SyntaxRole,
      label,
      anchors,
      implicit: u.implicit === true,
      status: status(u.status),
      evidence: text(u.evidence, '依据'),
      explanation: text(u.explanation, '解释'),
      quote: anchors.map((a) => a.quote).join(' … ') || label,
      occurrence: anchors[0]?.occurrence ?? 1,
      start: anchors[0]?.start ?? -1,
      end: anchors.at(-1)?.end ?? -1,
      depth: 0
    } satisfies SyntaxSpan
  })
  const relationIds = new Set<string>()
  const relations = list(raw.relations, '关系', 128).map((value) => {
    const r = object(value),
      key = id(r.id),
      from = id(r.from)
    if (relationIds.has(key)) throw Error('句法关系 ID 重复。')
    relationIds.add(key)
    if (
      ![
        'dependency',
        'scope',
        'reference',
        'control',
        'ellipsis',
        'contrast',
        'perspective',
        'focus'
      ].includes(r.kind as string)
    )
      throw Error('句法关系类型不合法。')
    const to = references(r.to, unitIds, '关系目标', 12)
    if (!unitIds.has(from) || !to.length || to.includes(from))
      throw Error('句法关系起点或终点不合法。')
    return {
      id: key,
      kind: r.kind as SyntaxRelation['kind'],
      ...(r.within !== undefined ? { within: id(r.within) } : {}),
      from,
      to,
      label: text(r.label, '关系名称', 80),
      explanation: text(r.explanation, '关系解释'),
      evidence: text(r.evidence, '关系依据'),
      status: status(r.status)
    }
  })
  const readingIds = new Set<string>()
  const scopeKinds = new Set(['scope', 'perspective'])
  for (const relation of relations) {
    const seen = new Set([relation.id])
    let cursor = relation
    while (cursor.within) {
      const parent = relations.find((r) => r.id === cursor.within)
      if (
        !parent ||
        !scopeKinds.has(parent.kind) ||
        !scopeKinds.has(cursor.kind) ||
        seen.has(parent.id)
      )
        throw Error('辖域嵌套必须指向已存在的作用域或视角，且不能成环。')
      seen.add(parent.id)
      cursor = parent
    }
  }
  const readings = list(raw.readings, '候选读法', 4).map((value) => {
    const r = object(value),
      key = id(r.id)
    if (readingIds.has(key)) throw Error('候选读法 ID 重复。')
    readingIds.add(key)
    return {
      id: key,
      label: text(r.label, '读法名称', 80),
      units: references(r.units, unitIds, '候选单位', 96),
      relations: references(r.relations, relationIds, '候选关系', 128),
      explanation: text(r.explanation, '读法解释'),
      conditions: text(r.conditions, '区分条件')
    }
  })
  if (readings.length === 1) throw Error('只有一种读法时应将分析放入共享部分，readings 留空。')
  const branchUnits = new Set(readings.flatMap((r) => r.units)),
    branchRelations = new Set(readings.flatMap((r) => r.relations))
  for (const reading of readings) {
    const availableRelations = new Set(
      relations
        .filter((r) => !branchRelations.has(r.id) || reading.relations.includes(r.id))
        .map((r) => r.id)
    )
    const allowed = new Set(
      [...unitIds].filter((key) => !branchUnits.has(key) || reading.units.includes(key))
    )
    for (const relation of relations.filter(
      (r) => !branchRelations.has(r.id) || reading.relations.includes(r.id)
    )) {
      if ([relation.from, ...relation.to].some((key) => !allowed.has(key)))
        throw Error('候选关系引用了另一读法的单位，未混合显示。')
      if (relation.within && !availableRelations.has(relation.within))
        throw Error('辖域嵌套引用了另一候选的环境，未混合显示。')
    }
  }
  return {
    version: 2,
    text: selected,
    summary: text(raw.summary, '摘要', 8000),
    language: raw.language === undefined ? undefined : text(raw.language, '语言', 80),
    spans,
    relations,
    readings
  }
}
