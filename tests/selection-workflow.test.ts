import { describe, it, expect } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import {
  createSelectionNote,
  rawSelectionOffset
} from '../src/renderer/src/composables/selectionNote'
import { resolveReadingInsertion } from '../src/renderer/src/parser/reading-source'
import { selectionContext } from '../src/shared/selection-context'
import { clampSettings, DEFAULT_SETTINGS } from '../src/shared/ipc-types'
describe('selection preferences, user notes and source context', () => {
  it('supports all eight combinations and keeps the default native selection', () => {
    for (let mask = 0; mask < 8; mask++) {
      const value = {
        ...DEFAULT_SETTINGS,
        selectionNote: !!(mask & 1),
        selectionExplain: !!(mask & 2),
        selectionCopy: !!(mask & 4)
      }
      expect(clampSettings(value)).toEqual(value)
    }
    expect(
      DEFAULT_SETTINGS.selectionNote ||
        DEFAULT_SETTINGS.selectionExplain ||
        DEFAULT_SETTINGS.selectionCopy
    ).toBe(false)
  })
  it('saves a user footnote with a portable point and a precise range record, preserving CRLF/BOM', () => {
    const source = '\uFEFF# 标题\r\n\r\n门槛，门槛。\r\n'
    const normalized = source.replace(/\r\n/g, '\n'),
      position = normalized.lastIndexOf('门槛') + 2
    const result = createSelectionNote(source, position, '门槛', '一行\n第二行')
    expect(result.source).toContain('门槛，门槛[^用户注释:1]。\r\n')
    expect(result.source).toContain('[^用户注释:1]: 一行\r\n    第二行')
    expect(result.source.startsWith('\uFEFF')).toBe(true)
    const book = parseBook(result.source)
    expect(book.warnings).toEqual([])
    expect(book.notes[0].typeLabel).toBe('用户注释')
    expect(book.notes[0].selectionRange?.text).toBe('门槛')
    expect(book.sections.map((s) => s.html).join('')).not.toContain('zhumo-range-')
    expect(book.stats.chars).toBeLessThan(100)
  })
  it('locates the start of a rendered paragraph and repeats without taking another occurrence', () => {
    const source = '# 标题\n\n门槛，门槛。'
    const common = { kind: 'section' as const, id: 'sec-1', inline: 1, text: '门槛，门槛。' }
    expect(resolveReadingInsertion(source, { ...common, end: 0, boundary: 'start' }).position).toBe(
      source.indexOf('门槛')
    )
    expect(resolveReadingInsertion(source, { ...common, end: 3, boundary: 'start' }).position).toBe(
      source.lastIndexOf('门槛')
    )
    expect(resolveReadingInsertion(source, { ...common, end: 5 }).position).toBe(
      source.lastIndexOf('门槛') + 2
    )
  })
  it('bounds each context side by 100k characters and keeps original line endings', () => {
    const source = '前'.repeat(110000) + '🌙选择\r\n原文' + '后'.repeat(110000),
      start = 110000,
      end = start + 8
    const context = selectionContext(source, start, end, '🌙选择\n原文')
    expect(context.before.length).toBeLessThanOrEqual(100000)
    expect(context.before.length).toBeGreaterThan(95000)
    expect(context.after.length).toBeLessThanOrEqual(100000)
    expect(context.selectedText).toBe('🌙选择\n原文')
    expect(
      selectionContext(source, start + 10, end + 10, '另一处').before.startsWith(context.before)
    ).toBe(true)
    expect(rawSelectionOffset('甲\r\n乙\r\n丙', 4)).toBe(6)
  })
})
