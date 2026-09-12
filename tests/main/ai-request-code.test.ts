import { describe, expect, it } from 'vitest'
import { transformAiRequest, validateRequestCode } from '../../src/main/ai/request-code'
import { requestBody, streamCompletion } from '../../src/main/ai/transport'
import { defaultAiProfile, type AiRequest } from '../../src/shared/ai-types'
import { selectionCacheKey } from '../../src/main/ai/result-cache'
const profile = {
  ...defaultAiProfile('syntax'),
  model: 'qwen3.8-flash',
  endpoint: 'https://example.test/v1'
}
const request: AiRequest = {
  id: 'request-code-test',
  profileRevision: '',
  lane: 'syntax',
  document: '',
  selectedText: '光经过文字。',
  instruction: ''
}
const input = {
  url: 'https://example.test/v1/chat/completions',
  headers: { Authorization: 'Bearer {{API_KEY}}' },
  body: { stream: true, model: 'fixture' }
}
describe('user-authored request configuration', () => {
  it('simple mode never executes retained code; code mode can define the entire body without a form model', async () => {
    for (const configurationMode of ['simple', 'code'] as const) {
      const configured = {
        ...profile,
        model: configurationMode === 'code' ? '' : profile.model,
        configurationMode,
        requestCode:
          'return { model: "body-model", messages: request.body.messages, max_tokens: 32768, stream: true, temperature: 0.4 };'
      }
      await streamCompletion(
        configured,
        '',
        request,
        new AbortController().signal,
        () => {},
        async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          expect(body.model).toBe(configurationMode === 'code' ? 'body-model' : profile.model)
          expect(body.temperature).toBe(configurationMode === 'code' ? 0.4 : undefined)
          expect(body).not.toHaveProperty('thinking_budget')
          return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        }
      )
    }
    const a = {
      ...profile,
      configurationMode: 'simple' as const,
      requestCode: 'throw Error("inactive");'
    }
    const b = { ...a, requestCode: 'return request;' }
    expect(selectionCacheKey(a, request)).toBe(selectionCacheKey(b, request))
  })
  it('sends edited fields and same-origin path; injects the key only after transformation', async () => {
    let output = ''
    await streamCompletion(
      {
        ...profile,
        configurationMode: 'code',
        requestCode: `
      request.url = 'https://example.test/custom/chat';
      request.body.enable_thinking = true;
      request.body.temperature = 0.6;
      request.body.headerSeenByCode = request.headers.Authorization;
      return request;`
      },
      'fixture-only-secret',
      request,
      new AbortController().signal,
      (value) => (output += value),
      async (url, init) => {
        expect(url).toBe('https://example.test/custom/chat')
        expect(init?.headers).toHaveProperty('Authorization', 'Bearer fixture-only-secret')
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          enable_thinking: true,
          temperature: 0.6,
          headerSeenByCode: 'Bearer {{API_KEY}}'
        })
        expect(body.messages[0].content).toContain('应用输出契约')
        expect(JSON.parse(body.messages[1].content).selectedText).toBe(request.selectedText)
        return Response.json({
          choices: [{ message: { content: '一批结果' }, finish_reason: 'stop' }]
        })
      }
    )
    expect(output).toBe('一批结果')
    expect(selectionCacheKey(profile, request)).not.toBe(
      selectionCacheKey(
        { ...profile, configurationMode: 'code', requestCode: 'return request;' },
        request
      )
    )
  })
  it('bounds bad code and refuses changed origins before sending', async () => {
    expect(() => validateRequestCode('return {;')).toThrow('语法错误')
    for (const code of [
      'while(true) {}',
      'return process.env;',
      'return require("node:fs");',
      'throw new Error("private text must not escape")'
    ]) {
      await expect(transformAiRequest(code, input, new AbortController().signal)).rejects.toThrow(
        '执行失败'
      )
    }
    await expect(
      transformAiRequest(
        'request.url="https://other.test/v1"; return request;',
        input,
        new AbortController().signal
      )
    ).rejects.toThrow('更换服务商')
    await expect(
      transformAiRequest('return undefined;', input, new AbortController().signal)
    ).rejects.toThrow()
    await expect(
      transformAiRequest(
        'request.body.stream=false; return request;',
        input,
        new AbortController().signal
      )
    ).rejects.toThrow('stream')
    const abort = new AbortController()
    const pending = transformAiRequest('while(true) {}', input, abort.signal)
    abort.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
  it('tests the same thinking/output configuration used for real reading without manuscript text', () => {
    const configured = {
      ...profile,
      thinkingMode: 'enabled' as const,
      reasoningEffort: 'low' as const,
      thinkingBudget: 2048
    }
    const normal = requestBody(configured, request)
    const check = requestBody(configured, { ...request, test: true })
    for (const field of ['enable_thinking', 'reasoning_effort', 'max_tokens'])
      expect(check[field]).toEqual(normal[field])
    expect(JSON.stringify(check)).not.toContain(request.selectedText)
    expect(check.enable_thinking).toBe(true)
    expect(check).not.toHaveProperty('thinking_budget')
    expect(requestBody({ ...configured, thinkingMode: 'disabled' }, request)).not.toHaveProperty(
      'thinking_budget'
    )
  })
  it('surfaces known provider parameter errors without exposing echoed private values', async () => {
    let error = ''
    try {
      await streamCompletion(
        profile,
        'fixture-only-secret',
        request,
        new AbortController().signal,
        () => {},
        async () =>
          Response.json(
            {
              error: {
                type: 'invalid_request_error',
                param: 'enable_thinking',
                message: 'enable_thinking is unsupported; fixture-only-secret; PRIVATE MANUSCRIPT'
              }
            },
            { status: 400 }
          )
      )
    } catch (cause) {
      error = String(cause)
    }
    expect(error).toContain('enable_thinking')
    expect(error).toContain('HTTP 400')
    expect(error).not.toContain('fixture-only-secret')
    expect(error).not.toContain('PRIVATE MANUSCRIPT')
  })
})
