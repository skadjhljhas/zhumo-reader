import { it, expect } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AiResultCache, selectionCacheKey } from '../../src/main/ai/result-cache'
import { defaultAiProfile, type AiRequest } from '../../src/shared/ai-types'
it('persists result hits and invalidates changes in model, prompt or exact context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-selection-cache-'))
  const vault = {
    available: () => true,
    encrypt: (v: string) => Buffer.from(v).toString('base64'),
    decrypt: (v: string) => Buffer.from(v, 'base64').toString()
  }
  try {
    const request: AiRequest = {
      id: 'test-selection-id',
      lane: 'reading',
      profileRevision: 'a',
      document: '',
      selectedText: '所选',
      instruction: '',
      selectionContext: { before: '上文', after: '下文' }
    }
    const profile = {
      ...defaultAiProfile('reading'),
      model: 'fixture',
      endpoint: 'https://example.test/v1'
    }
    const key = selectionCacheKey(profile, request),
      cache = new AiResultCache(root, vault)
    await cache.put(key, '这是一段解释。')
    expect(await new AiResultCache(root, vault).get(key)).toBe('这是一段解释。')
    expect(await readFile(join(root, 'selection-explanations.v1.json'), 'utf8')).not.toContain(
      '这是一段解释。'
    )
    expect(selectionCacheKey(profile, { ...request, id: 'another-id', profileRevision: 'b' })).toBe(
      key
    )
    expect(selectionCacheKey({ ...profile, systemPrompt: '改变解释方式' }, request)).not.toBe(key)
    expect(selectionCacheKey({ ...profile, reasoningEffort: 'low' }, request)).not.toBe(key)
    expect(selectionCacheKey({ ...profile, thinkingMode: 'disabled' }, request)).not.toBe(key)
    expect(selectionCacheKey(profile, { ...request, lane: 'syntax' })).not.toBe(key)
    const syntaxRequest: AiRequest = {
      ...request,
      lane: 'syntax',
      selectedText: 'x>0 时才成立',
      syntaxTarget: {
        regions: [{ kind: 'math', start: 0, end: 3 }],
        beginsMidSentence: false,
        endsMidSentence: false
      }
    }
    const syntaxKey = selectionCacheKey(profile, syntaxRequest)
    expect(selectionCacheKey(profile, { ...syntaxRequest, syntaxTarget: undefined })).not.toBe(
      syntaxKey
    )
    expect(
      selectionCacheKey(profile, {
        ...syntaxRequest,
        syntaxTarget: {
          ...syntaxRequest.syntaxTarget!,
          regions: [{ kind: 'code', start: 0, end: 3 }]
        }
      })
    ).not.toBe(syntaxKey)
    expect(
      selectionCacheKey(profile, {
        ...syntaxRequest,
        syntaxTarget: { ...syntaxRequest.syntaxTarget!, endsMidSentence: true }
      })
    ).not.toBe(syntaxKey)
    expect(
      selectionCacheKey(profile, {
        ...request,
        selectionContext: { before: '改变上文', after: '下文' }
      })
    ).not.toBe(key)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
