import { parseSyntaxAnalysis, type SyntaxAnalysis } from './ai-types'

type Raw = Record<string, unknown>
export interface SyntaxStreamIssue {
  sequence: number
  kind: 'framing' | 'json' | 'validation' | 'protocol'
  message: string
  /** The damaged packet was isolated; subsequent packets can still be validated. */
  recoverable: boolean
}
function merge(previous: unknown[], updates: unknown, limit: number): unknown[] {
  if (!Array.isArray(updates) || updates.length > limit) throw Error('句法增量批次缺失或过大。')
  const result = [...previous],
    seen = new Set<string>()
  for (const value of updates) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || seen.has(value.id))
      throw Error('句法批次含无效或重复 ID。')
    seen.add(value.id)
    const index = result.findIndex((old) => (old as Raw).id === value.id)
    if (index < 0) result.push(value)
    else result[index] = value
  }
  return result
}

function colorRecordHead(text: string): 'record' | 'partial' | 'other' {
  // Only a new root record after an actual newline can resynchronize a truncated mark.
  const tokens = ['{', '"type"', ':', '"']
  let rest = text
  for (const token of tokens) {
    rest = rest.trimStart()
    if (rest.length < token.length) return token.startsWith(rest) ? 'partial' : 'other'
    if (!rest.startsWith(token)) return 'other'
    rest = rest.slice(token.length)
  }
  const choices = ['mark"', 'patch"', 'done"']
  if (choices.some((choice) => rest.startsWith(choice))) return 'record'
  return choices.some((choice) => choice.startsWith(rest)) ? 'partial' : 'other'
}

/** Structural framing, never speculative JSON or linguistic repair. A complete object
 * commits atomically after graph validation; damage to one packet does not stop the stream. */
export class SyntaxStream {
  analysis: SyntaxAnalysis | null = null
  complete = false
  private mode: 'unknown' | 'stream' | 'legacy' = 'unknown'
  private received = 0
  private buffer = ''
  private cursor = 0
  private depth = 0
  private arrays = 0
  private quoted = false
  private escaped = false
  private legacy = ''
  private done = false
  private issueCount = 0
  private pendingIssues: SyntaxStreamIssue[] = []
  private fatal: Error | null = null
  private graph: Raw
  private colorMode = false
  constructor(
    private selected: string,
    private options: {
      parse?: (raw: Raw) => SyntaxAnalysis
      maxBytes?: number
    } = {}
  ) {
    this.graph = {
      version: 2,
      text: selected,
      summary: '已收到部分关系，分析仍在继续。',
      units: [],
      relations: [],
      readings: []
    }
  }

  private parse(raw: Raw): SyntaxAnalysis {
    return this.options.parse
      ? this.options.parse(raw)
      : parseSyntaxAnalysis(JSON.stringify(raw), this.selected)
  }

  /** Reading notifications does not clear the cache-integrity failure. */
  drainIssues(): SyntaxStreamIssue[] {
    return this.pendingIssues.splice(0)
  }

  private fail(message: string): never {
    this.complete = false
    this.fatal = new Error(message)
    throw this.fatal
  }

  private issue(kind: SyntaxStreamIssue['kind'], message: string, recoverable = true): void {
    this.complete = false
    if (++this.issueCount > 256) this.fail('句法流异常批次过多；已校验的关系保留。')
    this.pendingIssues.push({ sequence: this.issueCount, kind, message, recoverable })
  }

  push(chunk: string): SyntaxAnalysis | null {
    if (this.fatal) throw this.fatal
    this.received += chunk.length
    if (this.received > (this.options.maxBytes ?? 1024 * 1024)) this.fail('句法流超过接收上限。')
    this.buffer += chunk
    this.consume(false)
    return this.analysis
  }

  private discard(count: number): void {
    this.buffer = this.buffer.slice(count)
    this.cursor = this.depth = this.arrays = 0
    this.quoted = this.escaped = false
  }

  private outside(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || /^```(?:json|jsonl|ndjson)?$/i.test(trimmed)) return
    this.issue('framing', '句法对象之间含非 JSON 内容；已跳过该部分，继续校验后续批次。')
  }

  private consume(final: boolean): void {
    while (this.buffer.length) {
      if (!this.depth) {
        this.buffer = this.buffer.trimStart()
        if (!this.buffer) return
        if (this.buffer[0] !== '{') {
          // Only discard text outside a frame. Braces inside quoted JSON are never boundaries.
          const boundary = this.buffer.search(/[\n{]/)
          if (boundary < 0) {
            if (this.buffer.length > 256 * 1024) this.fail('句法单批过大，请缩小分析范围。')
            if (final) {
              this.outside(this.buffer)
              this.discard(this.buffer.length)
            }
            return
          }
          this.outside(this.buffer.slice(0, boundary))
          this.discard(boundary + (this.buffer[boundary] === '\n' ? 1 : 0))
          continue
        }
        this.depth = 1
        this.cursor = 1
      }
      let consumed = false
      for (; this.cursor < this.buffer.length; this.cursor++) {
        if (this.cursor >= 256 * 1024) this.fail('句法单批过大。')
        const char = this.buffer[this.cursor]
        if (
          this.colorMode &&
          !this.quoted &&
          char === '{' &&
          this.depth === 1 &&
          this.arrays === 0
        ) {
          const line = this.buffer.lastIndexOf('\n', this.cursor - 1)
          if (line >= 0 && !this.buffer.slice(line + 1, this.cursor).trim()) {
            const head = colorRecordHead(this.buffer.slice(this.cursor))
            if (head === 'partial' && !final) return
            if (head === 'record') {
              this.issue('json', '前一条着色记录未闭合；已保留有效标注，继续读取下一条完整记录。')
              this.discard(this.cursor)
              consumed = true
              break
            }
          }
        }
        if (this.quoted) {
          // A literal line break is illegal in JSON strings. It gives a reliable boundary
          // for discarding the damaged line without inventing a closing quote or anchor.
          if (char === '\n' || char === '\r') {
            this.issue('json', '句法字符串含未转义换行；已跳过损坏部分，继续校验后续批次。')
            this.discard(this.cursor + 1)
            consumed = true
            break
          }
          if (this.escaped) this.escaped = false
          else if (char === '\\') this.escaped = true
          else if (char === '"') this.quoted = false
        } else if (char === '"') this.quoted = true
        else if (char === '[') this.arrays++
        else if (char === ']') this.arrays--
        else if (char === '{') this.depth++
        else if (char === '}' && --this.depth === 0) {
          const object = this.buffer.slice(0, this.cursor + 1)
          this.discard(this.cursor + 1)
          this.packet(object)
          consumed = true
          break
        }
      }
      if (consumed) continue
      if (final) {
        this.issue('json', '句法流末尾的 JSON 对象未完整；已校验的关系保留。', false)
        this.discard(this.buffer.length)
      }
      return
    }
  }

  private packet(object: string): void {
    let packet: Raw
    try {
      packet = JSON.parse(object)
    } catch {
      this.issue('json', '句法批次不是有效的 JSON；已跳过该批次，继续校验后续批次。')
      return
    }
    if (this.done || this.mode === 'legacy') {
      this.issue('protocol', '句法结束标记或完整结果之后仍有数据；未作为完整结果缓存。')
      return
    }
    if (this.mode === 'unknown') {
      if (
        packet.type !== 'begin' &&
        (packet.version === 2 ||
          packet.version === 1 ||
          packet.version === 4 ||
          (typeof packet.text === 'string' && Array.isArray(packet.spans)))
      ) {
        this.mode = 'legacy'
        this.legacy = object
        return
      }
      if (packet.type !== 'begin' || (packet.version !== 3 && packet.version !== 4)) {
        this.issue(
          'protocol',
          packet.type === 'begin' ? '不支持的句法流版本。' : '句法流缺少有效的 begin 记录。'
        )
        return
      }
      this.mode = 'stream'
      this.colorMode = packet.version === 4
      if (this.colorMode) this.graph = { version: 4, text: this.selected, marks: [], summary: '' }
      return
    }
    if (this.colorMode) {
      this.colorPacket(packet)
      return
    }
    if (packet.type !== 'patch' && packet.type !== 'done') {
      this.issue('protocol', '未知或重复的句法流记录；继续校验后续批次。')
      return
    }
    try {
      const next =
        packet.type === 'done'
          ? { ...this.graph, summary: packet.summary }
          : {
              ...this.graph,
              units: merge(this.graph.units as unknown[], packet.units, 12),
              relations: merge(this.graph.relations as unknown[], packet.relations, 16),
              ...Object.fromEntries(
                ['readings', 'summary', 'language']
                  .filter((key) => key in packet)
                  .map((key) => [key, packet[key]])
              )
            }
      const validated = this.parse(next)
      this.graph = next
      this.analysis = validated
      if (packet.type === 'done') {
        this.done = true
        this.complete = this.issueCount === 0
      }
    } catch (error) {
      this.issue(
        'validation',
        (error instanceof Error ? error.message : '句法批次验证失败。') +
          ' 已跳过该批次，继续校验后续批次。'
      )
    }
  }

  private colorPacket(packet: Raw): void {
    try {
      let next: Raw
      if (packet.type === 'done') next = { ...this.graph, summary: packet.summary ?? '' }
      else if (packet.type === 'mark' || packet.type === 'patch') {
        const incoming = packet.type === 'mark' ? [packet] : packet.marks
        // Validate incoming quotes/colors independently before replacing earlier marks.
        const update = this.parse({ version: 4, text: this.selected, marks: incoming })
        if (update.marks!.length > 48) throw Error('单批着色最多48条。')
        const ids = new Set(update.marks!.map((m) => m.id))
        next = {
          ...this.graph,
          marks: [
            ...(this.graph.marks as Raw[]).filter((m) => !ids.has(String(m.id))),
            ...update.marks!
          ]
        }
      } else throw Error('未知或重复的着色流记录。')
      const validated = this.parse(next)
      this.graph = next
      this.analysis = validated
      if (packet.type === 'done') {
        this.done = true
        this.complete = this.issueCount === 0
      }
    } catch (error) {
      this.issue(
        'validation',
        (error instanceof Error ? error.message : '着色记录无效。') +
          ' 已保留先前标注，继续接收后续记录。'
      )
    }
  }

  finish(): SyntaxAnalysis {
    if (this.fatal) throw this.fatal
    this.consume(true)
    if (this.mode === 'legacy' && !this.analysis) {
      try {
        this.analysis = this.parse(JSON.parse(this.legacy))
        this.complete = this.issueCount === 0
      } catch (error) {
        this.issue(
          'validation',
          error instanceof Error ? error.message : '句法结果验证失败。',
          false
        )
      }
    }
    if (this.issueCount) {
      this.complete = false
      throw Error('句法流含未修复的异常批次；已校验的关系保留，未作为完整结果缓存。')
    }
    if (!this.complete || !this.analysis)
      throw Error('句法流尚未完成；已校验的关系保留，未作为完整结果缓存。')
    return this.analysis
  }
}
