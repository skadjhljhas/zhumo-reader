import { describe, expect, it } from 'vitest'
import { applySourceChanges, normalizeSource } from '../src/renderer/src/composables/sourceText'
describe('Lossless source edits', () => {
  it('keeps BOM, mixed endings, untouched spaces and Unicode intact', () => {
    const raw = '\uFEFF# 题目\r\n段落🐈  \n下一段\r末段\r\n'
    const normalized = normalizeSource(raw)
    const pos = normalized.indexOf('段落')
    const changed = applySourceChanges(raw, [{ from: pos, to: pos + 2, insert: '正文' }])
    expect(changed).toBe(raw.replace('段落', '正文'))
  })
  it('deletes exactly one CRLF at normalized offsets', () => {
    expect(applySourceChanges('a\r\nb\r\nc', [{ from: 1, to: 2, insert: '' }])).toBe('ab\r\nc')
  })
  it('applies multiple edits in one transaction and follows dominant EOL for inserted lines', () => {
    expect(
      applySourceChanges('ab\r\ncd\r\nef', [
        { from: 1, to: 2, insert: 'B\nX' },
        { from: 7, to: 8, insert: 'F' }
      ])
    ).toBe('aB\r\nX\r\ncd\r\neF')
  })
})
