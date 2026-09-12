import type { AnnotationBlock, SyntaxAnalysis } from './ai-types'
import { parseReadingColors, type ReadingColorMark } from './reading-colors'
import { SyntaxStream } from './syntax-stream'

export function validateAnnotationBlocks(value: unknown): asserts value is AnnotationBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 20000)
    throw Error('全文文本索引无效。')
  const ids = new Set<string>()
  let length = 0
  for (const block of value) {
    if (
      !block ||
      typeof block.id !== 'string' ||
      !/^[\w-]{1,40}$/.test(block.id) ||
      ids.has(block.id) ||
      typeof block.text !== 'string' ||
      !block.text.trim()
    )
      throw Error('全文文本索引缺少唯一地址或原文。')
    ids.add(block.id)
    length += block.text.length
    if (length > 8 * 1024 * 1024) throw Error('全文文本索引过大，未截断或发送。')
  }
}

/** Blocks come from the complete parse, so offscreen paragraphs have the same exact addresses. */
export function createDocumentAnnotationStream(blocks: AnnotationBlock[]): SyntaxStream {
  validateAnnotationBlocks(blocks)
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const normalized = new WeakMap<object, ReadingColorMark>()
  return new SyntaxStream('', {
    maxBytes: 16 * 1024 * 1024,
    parse(raw): SyntaxAnalysis {
      if (
        raw.version !== 4 ||
        raw.text !== '' ||
        !Array.isArray(raw.marks) ||
        raw.marks.length > 8192 ||
        (raw.summary !== undefined &&
          (typeof raw.summary !== 'string' || raw.summary.length > 8000))
      )
        throw Error('全文标注需要版本 4 的文本块着色记录。')
      const ids = new Set<string>()
      const marks = raw.marks.map((value): ReadingColorMark => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw Error('全文标注记录无效。')
        let mark = normalized.get(value)
        if (!mark) {
          const block = byId.get(value.blockId)
          if (!block) throw Error('全文标注指向了不存在的文本块。')
          const parsed = parseReadingColors(
            { version: 4, text: block.text, marks: [value] },
            block.text
          ).marks![0]
          mark = { ...parsed, id: value.id ?? `${block.id}--${parsed.id}`, blockId: block.id }
          normalized.set(value, mark)
          normalized.set(mark, mark)
        }
        if (ids.has(mark.id)) throw Error('全文标注 ID 重复。')
        ids.add(mark.id)
        return mark
      })
      return {
        version: 4,
        text: '',
        spans: [],
        marks,
        summary: typeof raw.summary === 'string' ? raw.summary : ''
      }
    }
  })
}
