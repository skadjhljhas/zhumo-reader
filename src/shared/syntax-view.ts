import type { SyntaxAnalysis, SyntaxRelation, SyntaxSpan } from './ai-types'
export const syntaxUnitId = (span: SyntaxSpan, index: number): string =>
  span.id ?? `legacy-${index}`
export function syntaxProjection(
  analysis: SyntaxAnalysis,
  readingId = ''
): {
  units: Array<{ span: SyntaxSpan; index: number; id: string }>
  relations: SyntaxRelation[]
  reading: NonNullable<SyntaxAnalysis['readings']>[number] | undefined
} {
  const readings = analysis.readings ?? []
  const reading = readings.find((item) => item.id === readingId) ?? readings[0]
  const branchedUnits = new Set(readings.flatMap((item) => item.units))
  const branchedRelations = new Set(readings.flatMap((item) => item.relations))
  return {
    reading,
    units: analysis.spans
      .map((span, index) => ({ span, index, id: syntaxUnitId(span, index) }))
      .filter((item) => !branchedUnits.has(item.id) || reading?.units.includes(item.id)),
    relations: (analysis.relations ?? []).filter(
      (item) => !branchedRelations.has(item.id) || reading?.relations.includes(item.id)
    )
  }
}
export function syntaxReport(analysis: SyntaxAnalysis): string {
  if (analysis.version === 4)
    return [
      '# 细读着色',
      '',
      analysis.text,
      '',
      analysis.summary,
      '',
      ...(analysis.marks ?? []).map(
        (mark) =>
          `- ${mark.quote}（第${mark.occurrence}次）：字色 ${mark.textColor} · 荧光 ${mark.glowColor}${mark.note ? '；' + mark.note : ''}`
      )
    ].join('\n')
  const units = new Map(analysis.spans.map((span, index) => [syntaxUnitId(span, index), span]))
  const quoted = analysis.text
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n')
  const lines = ['# 句法之光', '', quoted, '', analysis.summary, '']
  const views = analysis.readings?.length ? analysis.readings : [undefined]
  for (const reading of views) {
    const projection = syntaxProjection(analysis, reading?.id)
    if (reading)
      lines.push(
        '## ' + reading.label,
        '',
        reading.explanation,
        '',
        '区分条件：' + reading.conditions,
        ''
      )
    for (const r of projection.relations) {
      lines.push(
        '### ' + r.label,
        '',
        `${units.get(r.from)?.quote} → ${r.to.map((id) => units.get(id)?.quote).join('、')}`,
        '',
        r.explanation,
        '',
        '依据：' + r.evidence,
        ...(r.within
          ? [
              '所处环境：' +
                (projection.relations.find((parent) => parent.id === r.within)?.label ?? r.within)
            ]
          : []),
        ''
      )
    }
    lines.push('### 成分', '')
    for (const { span } of projection.units)
      lines.push(
        `- ${span.implicit ? '〔隐含〕' : ''}${span.quote} · ${span.label}：${span.explanation}${span.evidence ? ' 依据：' + span.evidence : ''}`
      )
    lines.push('')
  }
  return lines.join('\n')
}
