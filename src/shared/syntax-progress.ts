import type { SyntaxAnalysis } from './ai-types'
export interface SyntaxProgressInput {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  analysis: SyntaxAnalysis | null
  reasoning: string
  outputChars: number
  error: string
}
/** Thinking tokens are not executable annotation; distinguish every blank-page cause. */
export function syntaxProgressMessage(entry: SyntaxProgressInput, rendered = 0): string {
  if (entry.error) return entry.error
  if (entry.analysis?.version === 4) {
    if (entry.analysis.marks?.length)
      return rendered
        ? entry.status === 'running'
          ? '字色与荧光已显现，模型正在继续标注'
          : '当前正文已有可见标注'
        : '已收到着色记录，正在对应正文位置'
    return entry.status === 'running'
      ? '正在接收第一条完整着色记录'
      : '模型完成了本段阅读，未选择需要着色的词句'
  }
  const anchored =
    entry.analysis?.spans.some((s) => !s.implicit && s.start >= 0) &&
    (entry.analysis.version !== 2 || Boolean(entry.analysis.relations?.length))
  if (entry.status === 'running') {
    if (anchored)
      return rendered ? '关系已显影，模型正在补充后续结构' : '已收到结构，正在对应正文位置'
    if (entry.outputChars) return '正式结构正在抵达，等待第一批完整关系'
    if (entry.reasoning) return '模型正在思考，尚未交付正式结构；正文暂不标注'
    return '已发送句段，等待模型响应'
  }
  if (entry.status === 'done') {
    if (!anchored) return '模型已完成，但没有交付可绘制的关系；本句未生成光效'
    return rendered ? '当前正文已有可见标注' : '已收到分析，当前没有可绘制片段'
  }
  return entry.status === 'cancelled' ? '本次分析已暂停，已有关系保留' : '等待句段分析'
}
