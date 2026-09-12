import { describe, expect, it } from 'vitest'
import { defaultAiProfile, type AiRequest } from '../../src/shared/ai-types'
import { requestBody, SseFrames, streamCompletion } from '../../src/main/ai/transport'
const request: AiRequest = {
  id: 'test-request-123',
  profileRevision: '',
  lane: 'reading',
  selectedText: '月光',
  document: '\uFEFF# 全文\r\n\r\n月光[^甲]\r\n\r\n[^甲]: 注释',
  instruction: '解释'
}
const profile = {
  ...defaultAiProfile('reading'),
  model: 'test',
  endpoint: 'https://example.test/v1'
}
const event = (data: unknown): string => `data: ${JSON.stringify(data)}\r\n\r\n`
function sse(value: string, width = 1): Response {
  const bytes = new TextEncoder().encode(value)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width))
        controller.close()
      }
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
describe('LLM request and streaming boundaries', () => {
  it('sends typed atomic regions and continuation boundaries alongside exact context', () => {
    const target = {
      regions: [{ kind: 'math' as const, start: 0, end: 3 }],
      beginsMidSentence: false,
      endsMidSentence: true
    }
    for (const context of [undefined, { before: '\uFEFF原文\r\n若 $', after: '$ 成立。' }]) {
      const mixed: AiRequest = {
        ...request,
        lane: 'syntax',
        selectedText: 'x>0 才成立',
        syntaxTarget: target,
        ...(context ? { document: '', selectionContext: context } : {})
      }
      const body = requestBody(profile, mixed) as { messages: { content: string }[] }
      const user = JSON.parse(body.messages[1].content)
      expect(user.syntaxTarget).toEqual(target)
      expect(user.selectedText).toBe(mixed.selectedText)
      if (context) expect(user.markdownContext).toEqual(context)
    }
  })
  it('rejects invalid or overlapping atomic regions before contacting a provider', async () => {
    const badRegions = [
      [{ kind: 'math', start: -1, end: 2 }],
      [{ kind: 'math', start: 0, end: 99 }],
      [
        { kind: 'math', start: 0, end: 2 },
        { kind: 'code', start: 1, end: 3 }
      ],
      [{ kind: 'text', start: 0, end: 2 }]
    ]
    let contacted = false
    for (const regions of badRegions) {
      await expect(
        streamCompletion(
          profile,
          '',
          {
            ...request,
            lane: 'syntax',
            selectedText: 'x>0 才成立',
            syntaxTarget: {
              regions,
              beginsMidSentence: false,
              endsMidSentence: false
            } as AiRequest['syntaxTarget']
          },
          new AbortController().signal,
          () => {},
          async () => {
            contacted = true
            return sse('')
          }
        )
      ).rejects.toThrow('混排区域')
    }
    expect(contacted).toBe(false)
  })
  it('sends complete byte-faithful source and distinct task/selection fields', () => {
    const body = requestBody(profile, request) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[1].content)).toEqual({
      task: '解释',
      selectedText: '月光',
      markdown: request.document
    })
    const syntax = requestBody(
      { ...profile, context: 'selection' },
      { ...request, lane: 'syntax' }
    ) as typeof body
    expect(JSON.parse(syntax.messages[1].content)).not.toHaveProperty('markdown')
    expect(syntax.messages[0].content).toContain('应用输出契约')
    expect(JSON.stringify(requestBody(profile, { ...request, test: true }))).not.toContain('月光')
  })
  it('parses arbitrarily split UTF8 and CRLF frames with terminal completion', async () => {
    const wire =
      ': ping\r\n\r\n' +
      event({ choices: [{ delta: { content: '海🌙' } }] }) +
      event({ choices: [{ delta: { content: '风' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\r\n\r\n'
    let text = ''
    const reason = await streamCompletion(
      profile,
      'test-key',
      request,
      new AbortController().signal,
      (chunk) => {
        text += chunk
      },
      async (_url, init) => {
        expect(init?.redirect).toBe('error')
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
        return sse(wire)
      }
    )
    expect(text).toBe('海🌙风')
    expect(reason).toBe('stop')
  })
  it('keeps Anthropic thinking deltas separate from answer text', async () => {
    let output = ''
    let thinking = ''
    const wire =
      event({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'private' }
      }) +
      event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '句法' } }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
      event({ type: 'message_stop' })
    await streamCompletion(
      { ...profile, protocol: 'anthropic' },
      'key',
      request,
      new AbortController().signal,
      (text) => {
        output += text
      },
      async (_url, init) => {
        expect((init?.headers as Record<string, string>)['x-api-key']).toBe('key')
        return sse(wire, 11)
      },
      (text) => {
        thinking += text
      }
    )
    expect(output).toBe('句法')
    expect(thinking).toBe('private')
  })
  it('accepts a provider that returns a completed JSON response despite stream=true', async () => {
    let output = ''
    await streamCompletion(
      profile,
      '',
      request,
      new AbortController().signal,
      (text) => {
        output += text
      },
      async () =>
        Response.json({ choices: [{ message: { content: '结果' }, finish_reason: 'stop' }] })
    )
    expect(output).toBe('结果')
  })
  it('reports a broken stream while preserving already received text', async () => {
    let text = ''
    await expect(
      streamCompletion(
        profile,
        '',
        request,
        new AbortController().signal,
        (value) => {
          text += value
        },
        async () => sse(event({ choices: [{ delta: { content: '前半句' } }] }))
      )
    ).rejects.toThrow('中断')
    expect(text).toBe('前半句')
  })
  it('does not disclose an API error body containing keys or manuscript text', async () => {
    await expect(
      streamCompletion(
        profile,
        'secret-key',
        request,
        new AbortController().signal,
        () => {},
        async () => new Response('secret-key/full-private-source', { status: 401 })
      )
    ).rejects.toThrow('拒绝授权')
  })
  it('keeps length-limited output distinguishable from completion', async () => {
    expect(
      await streamCompletion(
        profile,
        '',
        request,
        new AbortController().signal,
        () => {},
        async () =>
          sse(
            event({ choices: [{ delta: { content: '半句' }, finish_reason: 'length' }] }) +
              'data: [DONE]\n\n'
          )
      )
    ).toBe('length')
  })
  it('frames multiline data and comments correctly across chunk splits', () => {
    const frames = new SseFrames()
    expect(frames.push(': ping\r\ndata: first\r\n')).toEqual([])
    expect(frames.push('data: second\r\n\r')).toEqual([])
    expect(frames.push('\n')).toEqual(['first\nsecond'])
  })
  it('refuses oversized syntax selections before any request', async () => {
    let called = false
    await expect(
      streamCompletion(
        profile,
        '',
        { ...request, lane: 'syntax', selectedText: 'a'.repeat(12001) },
        new AbortController().signal,
        () => {},
        async () => {
          called = true
          return sse('')
        }
      )
    ).rejects.toThrow('12000')
    expect(called).toBe(false)
  })
  it('streams DeepSeek reasoning before a split syntax result and sends configured thinking controls', async () => {
    const arrivals: string[] = []
    await streamCompletion(
      { ...profile, maxTokens: 32768, thinkingMode: 'enabled', reasoningEffort: 'low' },
      '',
      request,
      new AbortController().signal,
      (text) => arrivals.push('answer:' + text),
      async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          max_tokens: 32768,
          thinking: { type: 'enabled' },
          reasoning_effort: 'low'
        })
        return sse(
          event({ choices: [{ delta: { reasoning_content: '先分析🌙。' } }] }) +
            event({ choices: [{ delta: { content: '一批关系' }, finish_reason: 'stop' }] }) +
            'data: [DONE]\n\n',
          3
        )
      },
      (text) => arrivals.push('reasoning:' + text)
    )
    expect(arrivals).toEqual(['reasoning:先分析🌙。', 'answer:一批关系'])
    expect(
      requestBody({ ...profile, thinkingMode: 'disabled', reasoningEffort: 'max' }, request)
    ).not.toHaveProperty('reasoning_effort')
    expect(requestBody(profile, request)).not.toHaveProperty('thinking')
    expect(
      requestBody(
        {
          ...profile,
          protocol: 'anthropic',
          endpoint: 'https://api.deepseek.com/anthropic',
          thinkingMode: 'enabled',
          reasoningEffort: 'max'
        },
        request
      )
    ).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'max' } })
  })
})

it('uses Qwen enable_thinking and canonical effort parameters instead of DeepSeek thinking.type', () => {
  const qwen = {
    ...profile,
    model: 'qwen3.8-flash',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  }
  const off = requestBody({ ...qwen, thinkingMode: 'disabled', reasoningEffort: 'max' }, request)
  expect(off).toHaveProperty('enable_thinking', false)
  expect(off).not.toHaveProperty('thinking')
  expect(off).not.toHaveProperty('reasoning_effort')
  expect(
    requestBody({ ...qwen, thinkingMode: 'enabled', reasoningEffort: 'medium' }, request)
  ).toMatchObject({ enable_thinking: true, reasoning_effort: 'medium' })
  expect(
    requestBody({ ...qwen, thinkingMode: 'enabled', reasoningEffort: 'max' }, request)
  ).toMatchObject({ enable_thinking: true, reasoning_effort: 'xhigh' })
})
