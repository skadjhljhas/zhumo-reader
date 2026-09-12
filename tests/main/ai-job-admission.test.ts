import { describe, expect, it } from 'vitest'
import { AiJobAdmission } from '../../src/main/ai/job-admission'
import { selectionCacheKey } from '../../src/main/ai/result-cache'
import { requestBody, validateAiRequest } from '../../src/main/ai/transport'
import {
  AUTOMATIC_SYNTAX_CONCURRENCY,
  defaultAiProfile,
  type AiRequest
} from '../../src/shared/ai-types'

function request(id: number, automatic = true): AiRequest {
  return {
    id: `request-${id}`,
    profileRevision: '',
    lane: 'syntax',
    document: '',
    selectedText: '并非每一段阅读都在同一时刻完成。',
    instruction: '',
    automatic,
    selectionContext: { before: '# 阅读\n\n', after: '\n\n光仍在文字之间。' }
  }
}

describe('AI foreground and viewport request admission', () => {
  it('reserves all ten viewport slots before any asynchronous credential work', async () => {
    expect(AUTOMATIC_SYNTAX_CONCURRENCY).toBe(10)
    const admission = new AiJobAdmission()
    let credentialsReady!: () => void
    const credentials = new Promise<void>((resolve) => (credentialsReady = resolve))
    const jobs: ReturnType<AiJobAdmission['reserve']>[] = []
    const start = async (id: number): Promise<void> => {
      const job = admission.reserve(1, request(id))
      jobs.push(job)
      try {
        await credentials
        expect(job.abort.signal.aborted).toBe(false)
      } finally {
        admission.release(job)
      }
    }
    const pending = Array.from({ length: AUTOMATIC_SYNTAX_CONCURRENCY }, (_, i) => start(i))
    await expect(start(AUTOMATIC_SYNTAX_CONCURRENCY)).rejects.toThrow('已有 10 句')
    expect(jobs).toHaveLength(AUTOMATIC_SYNTAX_CONCURRENCY)
    expect(jobs.every((job) => !job.abort.signal.aborted)).toBe(true)
    credentialsReady()
    await Promise.all(pending)
    expect(admission.reserve(1, request(AUTOMATIC_SYNTAX_CONCURRENCY)).abort.signal.aborted).toBe(
      false
    )
  })

  it('keeps manual syntax and reading independent of all ten background requests', () => {
    const admission = new AiJobAdmission()
    const background = Array.from({ length: AUTOMATIC_SYNTAX_CONCURRENCY }, (_, i) =>
      admission.reserve(1, request(i))
    )
    const manual = admission.reserve(1, request(10, false))
    const reading = admission.reserve(1, { ...request(11, false), lane: 'reading' })
    const nextManual = admission.reserve(1, request(12, false))
    expect(manual.abort.signal.aborted).toBe(true)
    expect(reading.abort.signal.aborted).toBe(false)
    expect(nextManual.abort.signal.aborted).toBe(false)
    const nextReading = admission.reserve(1, { ...request(13, false), lane: 'reading' })
    expect(reading.abort.signal.aborted).toBe(true)
    expect(nextReading.abort.signal.aborted).toBe(false)
    expect(nextManual.abort.signal.aborted).toBe(false)
    expect(background.every((job) => !job.abort.signal.aborted)).toBe(true)
  })

  it('reuses a cancelled or timed-out slot before its old finally has run', () => {
    const admission = new AiJobAdmission()
    const jobs = Array.from({ length: AUTOMATIC_SYNTAX_CONCURRENCY }, (_, i) =>
      admission.reserve(1, request(i))
    )
    admission.cancel(1, jobs[1].id)
    const replacement = admission.reserve(1, request(10))
    expect(replacement.abort.signal.aborted).toBe(false)
    expect(jobs[0].abort.signal.aborted).toBe(false)
    expect(jobs[2].abort.signal.aborted).toBe(false)
    expect(jobs[3].abort.signal.aborted).toBe(false)
    expect(() => admission.reserve(1, request(11))).toThrow('已有 10 句')
    jobs[2].abort.abort('timeout')
    expect(admission.reserve(1, request(11)).abort.signal.aborted).toBe(false)
    admission.release(jobs[1])
    admission.release(jobs[2])
    expect(() => admission.reserve(1, request(12))).toThrow('已有 10 句')
  })

  it('rejects duplicate request IDs without cancelling their existing work', () => {
    const admission = new AiJobAdmission()
    const first = admission.reserve(1, request(0, false))
    expect(() => admission.reserve(1, request(0, false))).toThrow('请求编号重复')
    expect(first.abort.signal.aborted).toBe(false)
    // The event channel identifies only the request ID, so sharing one across lanes is invalid.
    expect(() => admission.reserve(1, { ...request(0, false), lane: 'reading' })).toThrow(
      '请求编号重复'
    )
    admission.cancel(1, first.id)
    expect(() => admission.reserve(1, request(0))).toThrow('请求编号重复')
    admission.release(first)
    expect(admission.reserve(1, request(0)).abort.signal.aborted).toBe(false)
  })

  it('scopes limits, cancellation and window destruction to each sender', () => {
    const admission = new AiJobAdmission()
    const first = Array.from({ length: AUTOMATIC_SYNTAX_CONCURRENCY }, (_, i) =>
      admission.reserve(1, request(i))
    )
    const second = Array.from({ length: AUTOMATIC_SYNTAX_CONCURRENCY }, (_, i) =>
      admission.reserve(2, request(i))
    )
    admission.cancel(1, first[0].id)
    expect(first[0].abort.signal.aborted).toBe(true)
    expect(second[0].abort.signal.aborted).toBe(false)
    admission.destroy(1)
    expect(first.every((job) => job.abort.signal.aborted)).toBe(true)
    expect(second.every((job) => !job.abort.signal.aborted)).toBe(true)
    // A stale task's completion must not remove a new task with a subsequently reused identity.
    const replacement = admission.reserve(1, request(0))
    admission.release(first[0])
    admission.cancel(1, replacement.id)
    expect(replacement.abort.signal.aborted).toBe(true)
    admission.abortAll()
    expect(second.every((job) => job.abort.signal.aborted)).toBe(true)
  })
})

describe('viewport scheduling flag boundaries', () => {
  it('allows automatic only for real syntax analysis and validates its type', () => {
    expect(() => validateAiRequest(request(0))).not.toThrow()
    expect(() => validateAiRequest({ ...request(0), automatic: undefined })).not.toThrow()
    expect(() => validateAiRequest({ ...request(0), lane: 'reading' })).toThrow('无效的 AI 请求')
    expect(() => validateAiRequest({ ...request(0), test: true })).toThrow('无效的 AI 请求')
    for (const automatic of [null, 1, 'true', {}, []])
      expect(() => validateAiRequest({ ...request(0), automatic })).toThrow('无效的 AI 请求')
    expect(() =>
      validateAiRequest({ ...request(0), lane: 'reading', test: true, automatic: false })
    ).not.toThrow()
  })

  it('shares exact cache identity and provider input between background and manual analysis', () => {
    const profile = defaultAiProfile('syntax')
    const background = request(0)
    const foreground = { ...background, id: 'manual-request', automatic: false }
    expect(selectionCacheKey(profile, background)).toBe(selectionCacheKey(profile, foreground))
    expect(requestBody(profile, background)).toEqual(requestBody(profile, foreground))
    expect(selectionCacheKey(profile, { ...background, selectedText: '另一段。' })).not.toBe(
      selectionCacheKey(profile, background)
    )
  })
})
