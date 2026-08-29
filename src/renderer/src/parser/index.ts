/**
 * 朱墨注释解析内核 —— 对外唯一入口。
 *
 * 三遍管线：Pass A 归一与扫描（preprocess）→ Pass B 注释图（graph）
 * → Pass C 渲染（render）。纯函数，可在主线程或 Worker 中调用。
 *
 * 铁律：永不抛错、永不丢正文——任何异常都降级为单 section 的纯文本
 * ParsedBook 并附 parse-fallback 警告。
 */
import type { NoteRecord, ParsedBook, ParseOptions } from '../../../shared/types'
import { preprocess } from './preprocess'
import { buildGraph } from './graph'
import { renderBook } from './render'
import { NOTE_TYPE_WORDS, registerNoteTypeWord, stripRefMarkers } from './scan'

export { NOTE_TYPE_WORDS, registerNoteTypeWord }
export type { NoteType, PreprocessResult, NoteGraph } from './types'

export function parseBook(source: string, options?: ParseOptions): ParsedBook {
  const levelCap = Math.max(1, Math.floor(options?.levelCap ?? 4))
  try {
    const pre = preprocess(source)
    const graph = buildGraph(pre, levelCap)
    const rendered = renderBook(pre.bodyLines, graph)

    const notes: NoteRecord[] = graph.nodes.map((node) => {
      const record: NoteRecord = {
        id: node.id,
        label: node.label,
        type: node.type,
        displayMark: node.displayMark,
        level: node.level,
        html: rendered.noteHtml.get(node.label) ?? '',
        anchorSpots: rendered.anchorSpots.get(node.label) ?? [],
        parentIds: node.parents
          .map((p) => graph.byLabel.get(p)?.id)
          .filter((id): id is string => typeof id === 'string'),
        refCount: node.refCount
      }
      if (node.typeLabel) record.typeLabel = node.typeLabel
      if (!node.hasDef) record.missing = true
      if (node.orphan) record.orphan = true
      if (node.cycle) record.cycle = true
      return record
    })

    const bodyText = pre.bodyLines.join('\n')
    return {
      title: rendered.title,
      toc: rendered.toc,
      sections: rendered.sections,
      notes,
      warnings: [...pre.warnings, ...graph.warnings],
      stats: {
        chars: Array.from(bodyText).length,
        noteCount: notes.length,
        maxLevel: notes.reduce((max, n) => Math.max(max, n.level), 0)
      }
    }
  } catch (err) {
    return fallbackBook(source, err)
  }
}

/* ------------------------------------------------------------------ */
/* 降级兜底                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 纯段落渲染：按空行分段、HTML 转义、段内换行转 <br /> */
function fallbackBook(source: unknown, err: unknown): ParsedBook {
  const text = typeof source === 'string' ? source : source == null ? '' : String(source)
  const normalized = text.replace(/\r\n?/g, '\n')
  const titleMatch = /^ {0,3}#[ \t]+(.*?)[ \t]*$/m.exec(normalized)
  const title = titleMatch ? stripRefMarkers(titleMatch[1]) : ''
  const paras = normalized
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const html = paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`).join('\n')
  const reason = err instanceof Error ? err.message : String(err)
  return {
    title,
    toc: title ? [{ id: 'toc-1', level: 1, title, sectionId: 'sec-1' }] : [],
    sections: [{ id: 'sec-1', level: 1, title: title || '§1', html, anchorIds: [] }],
    notes: [],
    warnings: [
      {
        kind: 'parse-fallback',
        message: `解析器异常，已降级为纯文本渲染：${reason}`
      }
    ],
    stats: { chars: Array.from(normalized).length, noteCount: 0, maxLevel: 0 }
  }
}
