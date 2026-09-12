import { defaultAiProfile, type AiEvent } from '../../../shared/ai-types'
import { isMockApi } from './api-mock'
import { SYNTAX_READING_EXAMPLES } from '../../../shared/syntax-reading-examples'

export const isSyntaxStreamDemo =
  isMockApi &&
  ['stream', 'meaning'].includes(new URLSearchParams(location.search).get('aiDemo') ?? '')
const meaning = new URLSearchParams(location.search).get('aiDemo') === 'meaning'
const sentence = '海风轻轻翻开书页，月光停在行间。'
const unit = (id: string, quote: string, role: string, label: string): Record<string, unknown> => ({
  id,
  layer: 'syntax',
  role,
  label,
  anchors: [{ quote, occurrence: 1 }],
  explanation: '本句中' + label + '所对应的成分。',
  evidence: '与核心谓词构成的关系。',
  status: 'supported'
})
const edge = (id: string, from: string, to: string[], label: string): Record<string, unknown> => ({
  id,
  from,
  to,
  kind: 'dependency',
  label,
  explanation: label,
  evidence: '此处是预写的关系，仅演示逐批显影。',
  status: 'supported'
})
if (isSyntaxStreamDemo && !window.ai) {
  const listeners = new Set<(event: AiEvent) => void>(),
    timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  const send = (event: AiEvent): void => listeners.forEach((fn) => fn(event))
  const settings = window.api.getSettings
  window.api.getSettings = async () => ({ ...(await settings()), automaticSyntax: true })
  window.ai = {
    async getProfiles() {
      const profile = {
        ...defaultAiProfile('syntax'),
        revision: 'fixed-stream-demo',
        endpoint: 'http://127.0.0.1/demo',
        model: '固定流式示意 · 未调用模型',
        context: 'selection' as const
      }
      return { reading: { ...defaultAiProfile('reading'), ...profile }, syntax: profile }
    },
    async saveProfile() {
      throw Error('此页是固定流式示意；模型与密钥请在桌面版配置。')
    },
    async start(request) {
      const jobs: ReturnType<typeof setTimeout>[] = []
      timers.set(request.id, jobs)
      const later = (ms: number, event: AiEvent): void => {
        jobs.push(setTimeout(() => send(event), ms))
      }
      const text = (ms: number, value: unknown): void =>
        later(ms, { id: request.id, type: 'delta', text: JSON.stringify(value) + '\n' })
      if (meaning && request.lane === 'syntax') {
        const example = SYNTAX_READING_EXAMPLES.find(
          (e) => e.analysis.text === request.selectedText
        )?.analysis
        text(100, { type: 'begin', version: 3 })
        if (example)
          text(300, {
            type: 'patch',
            units: example.spans,
            relations: example.relations,
            readings: example.readings,
            summary: example.summary
          })
        text(450, {
          type: 'done',
          summary: example?.summary ?? '这段不在固定案例内；未进行模型分析。'
        })
        later(500, { id: request.id, type: 'done', finishReason: 'stop' })
        return
      }
      later(200, {
        id: request.id,
        type: 'reasoning',
        text: '〔固定示意，并非模型思考〕\n第一分句先交付“海风—翻开—书页”的联系；随后补充第二分句。'
      })
      if (request.lane === 'syntax') {
        text(1500, { type: 'begin', version: 3 })
        if (request.selectedText === sentence) {
          text(2200, {
            type: 'patch',
            units: [
              unit('wind', '海风', 'subject', '第一分句主语'),
              unit('open', '翻开', 'predicate', '第一分句谓语'),
              unit('page', '书页', 'object', '宾语')
            ],
            relations: [edge('r1', 'open', ['wind', 'page'], '海风翻开书页')]
          })
          later(5500, {
            id: request.id,
            type: 'reasoning',
            text: '\n现在第二批完整关系抵达；第一批已经亮起，无需等待这一批。'
          })
          text(8500, {
            type: 'patch',
            units: [
              unit('moon', '月光', 'subject', '第二分句主语'),
              unit('stay', '停', 'predicate', '第二分句谓语'),
              unit('between', '在行间', 'complement', '处所补足')
            ],
            relations: [edge('r2', 'stay', ['moon', 'between'], '月光停在行间')]
          })
        }
        text(11500, {
          type: 'done',
          summary: '流式示意完成：先显影第一分句，再显影第二分句。两组关系均为固定脚本。'
        })
      } else
        later(2200, {
          id: request.id,
          type: 'delta',
          text: '这是固定流式示意；真实解释来自桌面版中你配置的模型与系统提示词。'
        })
      later(12000, { id: request.id, type: 'done', finishReason: 'stop' })
    },
    async cancel(id) {
      timers.get(id)?.forEach(clearTimeout)
      timers.delete(id)
      send({ id, type: 'cancelled' })
    },
    onEvent(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}
