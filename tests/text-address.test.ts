import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import {
  textAddress,
  textDocumentVersion,
  sameTextVersion,
  parseTextAddress,
  validateTextAddress
} from '../src/renderer/src/composables/textAddress'
import {
  comparisonBounds,
  comparisonPassage,
  comparisonText,
  samePassage,
  COMPARISON_WINDOW
} from '../src/renderer/src/composables/readingComparison'
import type { SearchEntry, SearchIndex } from '../src/renderer/src/composables/bookSearch'

describe('shared versioned text addresses', () => {
  it('hashes exact UTF-16LE text consistently, including BOM, EOLs and lone surrogates', async () => {
    for (const source of ['正文😀', '\uFEFF正文\r\n', '正文\n', '\uD800', '\uFFFD']) {
      const version = await textDocumentVersion('C:/书.md', source)
      expect(version.digest).toBe(
        createHash('sha256').update(Buffer.from(source, 'utf16le')).digest('hex')
      )
    }
    expect(
      sameTextVersion(
        await textDocumentVersion('书', '\uD800'),
        await textDocumentVersion('书', '\uFFFD')
      )
    ).toBe(false)
    expect(
      sameTextVersion(
        await textDocumentVersion('书', 'a\r\n'),
        await textDocumentVersion('书', 'a\n')
      )
    ).toBe(false)
    expect(
      sameTextVersion(await textDocumentVersion('甲', 'a'), await textDocumentVersion('乙', 'a'))
    ).toBe(false)
  })
  it('separates original Markdown offsets from rendered-text offsets and preserves note labels', async () => {
    const source = '门[^甲]槛。\n\n[^甲]: 里面的**门槛**。'
    const book = parseBook(source),
      version = await textDocumentVersion('书', source)
    const entry: SearchEntry = {
      kind: 'note',
      id: book.notes[0].id,
      title: '甲',
      text: '里面的门槛。',
      blockIndex: 0,
      position: 0
    }
    const address = textAddress(version, book, entry, { start: 3, end: 5, text: '门槛' })!
    expect(address.origin).toEqual({ kind: 'note', label: '甲' })
    expect(validateTextAddress(address, version, entry.text)).toBe('valid')
    expect(address.match.start).not.toBe(source.indexOf('门槛'))
  })
  it('detects changed context and versions instead of accepting another matching word', async () => {
    const source = '门槛，门槛。',
      book = parseBook(source),
      version = await textDocumentVersion('书', source)
    const entry: SearchEntry = {
      kind: 'section',
      id: 'sec-1',
      title: '正文',
      text: source,
      blockIndex: 0,
      position: 0
    }
    const address = textAddress(version, book, entry, { start: 3, end: 5, text: '门槛' })!
    expect(validateTextAddress(address, version, '门边，门槛。')).toBe('text-changed')
    expect(
      validateTextAddress(address, await textDocumentVersion('书', source + '后来'), source)
    ).toBe('version-changed')
    expect(
      validateTextAddress(
        {
          ...address,
          version: { ...version, projection: 'old-projection' }
        } as unknown as typeof address,
        version,
        source
      )
    ).toBe('invalid-address')
  })
  it('rejects malformed persisted values and boundaries splitting a surrogate pair', async () => {
    const source = '🌠门槛',
      book = parseBook(source),
      version = await textDocumentVersion('书', source)
    const entry: SearchEntry = {
      kind: 'section',
      id: 'sec-1',
      title: '正文',
      text: source,
      blockIndex: 0,
      position: 0
    }
    expect(textAddress(version, book, entry, { start: 0, end: 1, text: source[0] })).toBeUndefined()
    const good = textAddress(version, book, entry, { start: 2, end: 4, text: '门槛' })!
    expect(textAddress({ ...version, path: '' }, book, entry, good.match)).toBeUndefined()
    for (const value of [
      null,
      [],
      {},
      { ...good, blockIndex: Number.NaN },
      { ...good, match: null },
      { ...good, origin: { kind: 'note' } },
      { ...good, version: { ...version, digest: 'x' } }
    ])
      expect(parseTextAddress(value)).toBeUndefined()
    expect(parseTextAddress(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })
})

describe('two-passage reading snapshots', () => {
  it('keeps different occurrences and query histories independent', async () => {
    const source = '# 第一处\n\n门槛，门槛。\n\n# 第二处\n\n另一个门槛。'
    const book = parseBook(source),
      version = await textDocumentVersion('书', source)
    const index: SearchIndex = {
      entries: [
        {
          kind: 'section',
          id: 'sec-1',
          title: '第一处',
          text: '门槛，门槛。',
          blockIndex: 1,
          position: 0
        },
        {
          kind: 'section',
          id: 'sec-2',
          title: '第二处',
          text: '另一个门槛。',
          blockIndex: 1,
          position: 7
        }
      ],
      lengths: { section: 14, note: 0 }
    }
    const left = comparisonPassage(
      book,
      index,
      { entryIndex: 0, start: 0, end: 2, ordinal: 0 },
      '门槛',
      version
    )!
    const same = comparisonPassage(
      book,
      index,
      { entryIndex: 0, start: 0, end: 2, ordinal: 0 },
      '门',
      version
    )!
    const later = comparisonPassage(
      book,
      index,
      { entryIndex: 0, start: 3, end: 5, ordinal: 1 },
      '门槛',
      version
    )!
    const right = comparisonPassage(
      book,
      index,
      { entryIndex: 1, start: 0, end: 3, ordinal: 0 },
      '另一个',
      version
    )!
    expect(samePassage(left, same)).toBe(true)
    expect(samePassage(left, later)).toBe(false)
    expect(left.query).toBe('门槛')
    expect(right.query).toBe('另一个')
    const copy = comparisonText(left, right)
    expect(copy).toContain('第一处')
    expect(copy).toContain('第二处')
    expect(copy).toContain('门槛，门槛。')
    expect(copy).toContain('另一个门槛。')
  })
  it('bounds long text windows without splitting UTF-16 pairs or losing the ending', () => {
    const text = '🌠门槛。'.repeat(5000)
    for (const center of [0, 1401, 13002, text.length]) {
      const range = comparisonBounds(text, center)
      expect(range.to - range.from).toBeLessThanOrEqual(COMPARISON_WINDOW + 2)
      expect(range.from).toBeGreaterThanOrEqual(0)
      expect(range.to).toBeLessThanOrEqual(text.length)
      expect(/^[\uDC00-\uDFFF]/.test(text.slice(range.from, range.to))).toBe(false)
      expect(/[\uD800-\uDBFF]$/.test(text.slice(range.from, range.to))).toBe(false)
    }
    expect(comparisonBounds(text, text.length).to).toBe(text.length)
  })
})
