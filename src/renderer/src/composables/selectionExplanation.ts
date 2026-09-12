import { reactive } from 'vue'
import { selectionContext } from '../../../shared/selection-context'
import { aiProfileReady, type AiEvent } from '../../../shared/ai-types'
export const selectionExplanation = reactive({
  id: '',
  output: '',
  reasoning: '',
  status: 'idle' as 'idle' | 'running' | 'done' | 'error',
  error: ''
})
let generation = 0
export function cancelSelectionExplanation(): void {
  generation++
  if (selectionExplanation.id && selectionExplanation.status === 'running')
    void window.ai?.cancel(selectionExplanation.id).catch(() => undefined)
  Object.assign(selectionExplanation, {
    id: '',
    output: '',
    reasoning: '',
    status: 'idle',
    error: ''
  })
}
export async function explainSelection(
  source: string,
  start: number,
  end: number,
  quote: string
): Promise<void> {
  cancelSelectionExplanation()
  const ticket = generation
  if (!window.ai) {
    selectionExplanation.status = 'error'
    selectionExplanation.error = '自动解释在桌面版使用已配置的模型。'
    return
  }
  selectionExplanation.status = 'running'
  try {
    const { reading: profile } = await window.ai.getProfiles()
    if (ticket !== generation) return
    if (!aiProfileReady(profile)) throw Error('请在全局设置中配置解释模型。')
    if (profile.keyStorage === 'unavailable')
      throw Error('密钥暂时无法读取，请在全局模型设置中保存配置。')
    const context = selectionContext(source, start, end, quote),
      id = crypto.randomUUID()
    selectionExplanation.id = id
    await window.ai.start({
      id,
      profileRevision: profile.revision,
      lane: 'reading',
      document: profile.context === 'default' ? source : '',
      selectedText: quote,
      instruction: '',
      ...(profile.context === 'full'
        ? { selectionContext: { before: context.before, after: context.after } }
        : {})
    })
    if (ticket !== generation) void window.ai.cancel(id)
  } catch (error) {
    if (ticket === generation) {
      selectionExplanation.status = 'error'
      selectionExplanation.error = error instanceof Error ? error.message : '解释暂时无法开始。'
    }
  }
}
export function selectionExplanationEvent(event: AiEvent): void {
  if (event.id !== selectionExplanation.id || selectionExplanation.status !== 'running') return
  if (event.type === 'delta') selectionExplanation.output += event.text
  else if (event.type === 'reasoning') selectionExplanation.reasoning += event.text
  else if (event.type === 'done') {
    selectionExplanation.status = 'done'
    if (['length', 'max_tokens'].includes(event.finishReason))
      selectionExplanation.error = '本次输出已到长度上限，当前文字已保留。'
  } else if (event.type === 'error') {
    selectionExplanation.status = 'error'
    selectionExplanation.error = event.message
  } else selectionExplanation.status = 'idle'
}
