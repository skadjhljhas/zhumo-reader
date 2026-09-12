import { describe, expect, it } from 'vitest'
import {
  createDocumentAnnotationStream,
  validateAnnotationBlocks
} from '../src/shared/document-annotations'
import { defaultAiProfile, type AiRequest } from '../src/shared/ai-types'
import { requestBody, validateAiRequest } from '../src/main/ai/transport'
import { selectionCacheKey } from '../src/main/ai/result-cache'
import { AiJobAdmission } from '../src/main/ai/job-admission'
const blocks = [
  { id: 'b-0-0', text: '自由从不是孤立的自由。' },
  { id: 'b-8-2', text: '理解使自由重新成为问题。' }
]
const request: AiRequest = {
  id: 'whole-fixture',
  profileRevision: '',
  lane: 'syntax',
  automatic: true,
  annotationMode: 'document',
  document: '# 自由\n\n自由从不是孤立的自由。\n\n理解使自由重新成为问题。',
  selectedText: '',
  instruction: '',
  documentBlocks: blocks
}
const mark = (blockId = 'b-8-2', radiance = 0.65): object => ({
  type: 'mark',
  blockId,
  quote: '自由',
  occurrence: 1,
  textColor: '#aa3355',
  glowColor: '#aacedd',
  radiance
})

describe('whole document annotations', () => {
  it('locates block-local repetition, preserves independent channels and delivers before done', () => {
    const stream = createDocumentAnnotationStream(blocks)
    stream.push('{"type":"begin","version":4}\n')
    const result = stream.push(JSON.stringify(mark()) + '\n')!
    expect(result.marks?.[0]).toMatchObject({
      blockId: 'b-8-2',
      start: 3,
      end: 5,
      textColor: '#aa3355',
      glowColor: '#aacedd',
      radiance: 0.65
    })
    stream.push(JSON.stringify({ ...mark('b-0-0'), occurrence: 2 }) + '\n')
    expect(stream.analysis!.marks?.[1].start).toBe(8)
    stream.push('{"type":"done","summary":"遥相呼应"}')
    expect(stream.finish().marks).toHaveLength(2)
  })
  it('isolates invalid blocks and invalid radiance without blessing a damaged cache', () => {
    const stream = createDocumentAnnotationStream(blocks)
    stream.push('{"type":"begin","version":4}\n')
    stream.push(
      JSON.stringify(mark('missing')) +
        '\n' +
        JSON.stringify(mark('b-0-0', 2)) +
        '\n' +
        JSON.stringify(mark())
    )
    expect(stream.analysis!.marks).toHaveLength(1)
    stream.push('{"type":"done"}')
    expect(() => stream.finish()).toThrow('异常批次')
    expect(() => validateAnnotationBlocks([blocks[0], blocks[0]])).toThrow('唯一地址')
  })
  it('uses an independent prompt and intact Markdown while omitting model-default parameters', () => {
    validateAiRequest(request)
    const profile = {
      ...defaultAiProfile('syntax'),
      systemPrompt: 'FOLLOW',
      documentSystemPrompt: 'DOCUMENT'
    }
    const body = requestBody(profile, request)
    const messages = body.messages as Array<{ content: string }>
    expect(messages[0].content).toContain('DOCUMENT')
    expect(messages[0].content).not.toContain('FOLLOW')
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
      markdown: request.document,
      blocks
    })
    for (const key of ['max_tokens', 'max_completion_tokens', 'thinking', 'reasoning_effort'])
      expect(body).not.toHaveProperty(key)
    expect(() => validateAiRequest({ ...request, documentBlocks: undefined })).toThrow()
    expect(() => validateAiRequest({ ...request, selectedText: '截断的部分' })).toThrow()
    expect(selectionCacheKey({ ...profile, systemPrompt: 'OTHER FOLLOW' }, request)).toBe(
      selectionCacheKey(profile, request)
    )
    expect(
      selectionCacheKey({ ...profile, documentSystemPrompt: 'OTHER DOCUMENT' }, request)
    ).not.toBe(selectionCacheKey(profile, request))
    expect(
      selectionCacheKey(profile, { ...request, document: request.document + '\n新的限定。' })
    ).not.toBe(selectionCacheKey(profile, request))
  })
  it('cancels ten follow jobs when admitting a whole-document job, and the reverse', () => {
    const admission = new AiJobAdmission()
    const jobs = Array.from({ length: 10 }, (_, i) =>
      admission.reserve(1, { id: `follow-${i}`, lane: 'syntax', automatic: true })
    )
    const whole = admission.reserve(1, request)
    expect(jobs.every((job) => job.abort.signal.aborted)).toBe(true)
    expect(whole.abort.signal.aborted).toBe(false)
    admission.reserve(1, { id: 'new-follow', lane: 'syntax', automatic: true })
    expect(whole.abort.signal.aborted).toBe(true)
  })
})
