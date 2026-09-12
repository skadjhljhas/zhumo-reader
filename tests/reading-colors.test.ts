import { describe, it, expect } from 'vitest'
import { defaultAiProfile, parseSyntaxAnalysis, SYNTAX_PROMPT } from '../src/shared/ai-types'
import { SyntaxStream } from '../src/shared/syntax-stream'
import { readingColorSegments } from '../src/shared/reading-colors'
import { requestBody, validateAiRequest } from '../src/main/ai/transport'
import { selectionCacheKey } from '../src/main/ai/result-cache'
const text = '自由并不是任意。自由也不是孤立。'
const mark = (quote = '自由', occurrence = 1): Record<string, unknown> => ({
  type: 'mark',
  quote,
  occurrence,
  textColor: '#386491',
  glowColor: '#E7BD91'
})
const begin = '{"type":"begin","version":4}'
const done = '{"type":"done"}'
describe('model-selected independent reading colors', () => {
  it('recovers a new complete record after a missing closing brace, across single-character chunks', () => {
    const stream = new SyntaxStream(text)
    const truncated = JSON.stringify(mark()).slice(0, -1)
    for (const char of begin + truncated + '\n' + JSON.stringify(mark('自由', 2)) + done)
      stream.push(char)
    expect(stream.analysis?.marks?.map((m) => m.start)).toEqual([8])
    expect(stream.drainIssues()).toHaveLength(1)
    expect(() => stream.finish()).toThrow('未作为完整结果缓存')
  })
  it('does not confuse pretty-printed patch children with a new root record', () => {
    const stream = new SyntaxStream(text)
    for (const char of begin +
      JSON.stringify({ type: 'patch', marks: [mark(), mark('自由', 2)] }, null, 2) +
      done)
      stream.push(char)
    expect(stream.finish().marks).toHaveLength(2)
    expect(stream.drainIssues()).toEqual([])
  })
  it('paints a complete mark before the next record and before stream completion', () => {
    const stream = new SyntaxStream(text)
    for (const c of begin + JSON.stringify(mark())) stream.push(c)
    expect(stream.complete).toBe(false)
    expect(stream.analysis?.marks?.[0]).toMatchObject({
      start: 0,
      end: 2,
      textColor: '#386491',
      glowColor: '#e7bd91'
    })
    stream.push(JSON.stringify(mark('自由', 2)) + done)
    expect(stream.finish().marks?.map((m) => m.start)).toEqual([0, 8])
  })
  it('isolates a bad record, continues applying later colors, and refuses to cache a damaged stream', () => {
    const stream = new SyntaxStream(text)
    stream.push(
      begin +
        JSON.stringify(mark()) +
        JSON.stringify(mark('不在原文中')) +
        JSON.stringify(mark('自由', 2)) +
        done
    )
    expect(stream.analysis?.marks).toHaveLength(2)
    expect(stream.drainIssues()).toHaveLength(1)
    expect(() => stream.finish()).toThrow('未作为完整结果缓存')
  })
  it('allows unrelated colors and makes later overlaps explicit without blending semantic channels', () => {
    const stream = new SyntaxStream(text)
    stream.push(
      begin +
        JSON.stringify(mark('自由并不是任意')) +
        JSON.stringify({ ...mark('并不是'), textColor: '#985781', glowColor: '#78CACA' }) +
        done
    )
    const segments = readingColorSegments(stream.finish().marks!)
    expect(segments.map((s) => [s.start, s.end, s.mark.textColor])).toEqual([
      [0, 2, '#386491'],
      [2, 5, '#985781'],
      [5, 7, '#386491']
    ])
  })
  it('replaces the same source occurrence and preserves independently chosen colors', () => {
    const stream = new SyntaxStream(text)
    stream.push(
      begin + JSON.stringify(mark()) + JSON.stringify({ ...mark(), glowColor: '#B8CADC' }) + done
    )
    expect(stream.finish().marks).toHaveLength(1)
    expect(stream.analysis?.marks?.[0].glowColor).toBe('#b8cadc')
  })
  it('refuses CSS injection, identical ink/glow, impossible occurrences and split graphemes', () => {
    for (const invalid of [
      { ...mark(), textColor: 'red;display:none' },
      { ...mark(), glowColor: '#386491' },
      { ...mark(), occurrence: 100 },
      { ...mark(), quote: 'e' }
    ])
      expect(() =>
        parseSyntaxAnalysis(
          JSON.stringify({ version: 4, text: 'e\u0301' + text, marks: [invalid] }),
          'e\u0301' + text
        )
      ).toThrow()
  })
  it('keeps completed-empty results valid and never invents coloring from reasoning or roles', () => {
    const stream = new SyntaxStream(text)
    stream.push(begin + done)
    expect(stream.finish().marks).toEqual([])
    expect(SYNTAX_PROMPT).toContain('字体颜色 textColor 与荧光颜色 glowColor 是独立')
    expect(SYNTAX_PROMPT).not.toContain('不要输出CSS、HTML、SVG、颜色')
  })
  it('sends theme context to the model and separates cache keys for distinct reading surfaces', () => {
    const profile = {
      ...defaultAiProfile('syntax'),
      model: 'fixture',
      endpoint: 'https://example.com/v1'
    }
    const request = {
      id: 'color-fixture-1',
      profileRevision: '',
      lane: 'syntax' as const,
      document: '',
      selectedText: text,
      instruction: '',
      readingAppearance: { theme: 'lucent', backgroundColor: '#dce6ef', textColor: '#25374a' }
    }
    validateAiRequest(request)
    const body = requestBody(profile, request)
    expect(
      JSON.parse((body.messages as Array<{ content: string }>)[1].content).readingAppearance
    ).toEqual(request.readingAppearance)
    expect(selectionCacheKey(profile, request)).not.toBe(
      selectionCacheKey(profile, {
        ...request,
        readingAppearance: {
          ...request.readingAppearance,
          theme: 'chaosheng',
          backgroundColor: '#142c48'
        }
      })
    )
  })
})
