import { expect, it } from 'vitest'
import { syntaxProgressMessage } from '../src/shared/syntax-progress'
it('does not mistake reasoning or an empty graph for visible annotation', () => {
  const entry = {
    status: 'running' as const,
    analysis: null,
    reasoning: '仍在推导',
    outputChars: 0,
    error: ''
  }
  expect(syntaxProgressMessage(entry)).toContain('尚未交付正式结构')
  expect(syntaxProgressMessage({ ...entry, outputChars: 30 })).toContain('等待第一批完整关系')
  expect(
    syntaxProgressMessage({
      ...entry,
      status: 'done',
      analysis: { text: '光', summary: '不足', spans: [] }
    })
  ).toContain('未生成光效')
  expect(syntaxProgressMessage({ ...entry, status: 'error', error: '原文无法对应' })).toBe(
    '原文无法对应'
  )
})
