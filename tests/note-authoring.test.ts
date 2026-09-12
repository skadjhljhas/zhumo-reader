import { describe, expect, it } from 'vitest'
import {
  indexNoteSources,
  projectNote,
  noteChanges,
  createNoteChanges,
  applyNormalizedChanges,
  expandInlineNote,
  inspectNoteSource,
  defineMissingNote,
  renameNoteChanges
} from '../src/renderer/src/composables/noteAuthoring'
import { applySourceChanges, normalizeSource } from '../src/renderer/src/composables/sourceText'
import { parseBook } from '../src/renderer/src/parser'

function semanticNotes(book: ReturnType<typeof parseBook>): unknown[] {
  const labels = new Map(book.notes.map((note) => [note.id, note.label]))
  return book.notes
    .map((note) => [
      note.label,
      note.html.replace(
        /data-note-id="([^"]+)"/g,
        (_match, id) => `data-note-label="${labels.get(id)}"`
      ),
      note.refCount,
      note.parentIds.map((id) => labels.get(id)).sort()
    ])
    .sort()
}

describe('annotation source projections', () => {
  it.each([
    ['句子^[原注。]结束。', '2'],
    ['句子[注1]结束。\n\n注1： 原注。', '2'],
    ['句子[^译者:1]结束。\n\n[^译者:1]: 原注。', '2'],
    ['句子[^译者注]结束。\n\n[^译者注]: 译者注：说明。', '3'],
    ['句子[^1]，再读[^3]。\n\n[^1]: 一。\n\n[^3]: 三。', '2']
  ])('new numeric labels avoid visible marks in %s', (source, expected) => {
    const created = createNoteChanges(source, 2)
    expect(created.label).toBe(expected)
    const next = applyNormalizedChanges(source, created.changes)
    const book = parseBook(next)
    expect(book.warnings).toEqual([])
    const marks = book.notes.map((note) => note.displayMark)
    expect(new Set(marks).size).toBe(marks.length)
  })
  it('keeps newly typed leading spaces and blank lines in an active note projection', () => {
    const source = '[^甲]: 原注。',
      region = indexNoteSources(source)[0]
    const before = projectNote(source, region)!
    const insert = '  \n\n'
    const changes = noteChanges(before, [{ from: 0, to: 0, insert }])
    const next = applyNormalizedChanges(source, changes)
    expect(projectNote(next, { ...region, to: region.to + changes[0].insert.length })!.text).toBe(
      insert + '原注。'
    )
  })
  it('tracks reference ranges through nested notes and protects code and mathematical text', () => {
    const source =
      '句子[^甲]。`[^甲]` $x^{[^甲]}$\n\n[^甲]: 父注^[里面[^乙]。]，再见[^乙]。\n    后来[^乙]。\n\n[^乙]: 子注。'
    const index = inspectNoteSource(source)
    expect(
      index.references.map((ref) => [ref.label, source.slice(ref.from, ref.to), ref.parent])
    ).toEqual([
      ['甲', '[^甲]', undefined],
      ['auto-1', '^[里面[^乙]。]', '甲'],
      ['乙', '[^乙]', '甲'],
      ['乙', '[^乙]', '甲'],
      ['乙', '[^乙]', 'auto-1']
    ])
  })
  it('renames every real reference while retaining source whitespace and literal examples', () => {
    const source =
      '句子[^甲]。\n\n```md\n[^甲]: 示例。\n```\n\n  [^甲]： 首行 `[^甲]`。\n\n\t第二段[^甲]。\n\n[^乙]: 指向[^甲]。'
    const next = applyNormalizedChanges(source, renameNoteChanges(source, '甲', '回声'))
    expect(next).toBe(
      '句子[^回声]。\n\n```md\n[^甲]: 示例。\n```\n\n  [^回声]： 首行 `[^甲]`。\n\n\t第二段[^回声]。\n\n[^乙]: 指向[^回声]。'
    )
    expect(parseBook(next).notes.find((note) => note.label === '回声')!.refCount).toBe(3)
  })
  it('preserves Chinese marks when possible and supports changing them to named GFM notes', () => {
    const source = '读[注2]，又见【注2】。\n\n注2： 旁注。'
    expect(applyNormalizedChanges(source, renameNoteChanges(source, '注2', '注12'))).toBe(
      '读[注12]，又见【注12】。\n\n注12： 旁注。'
    )
    expect(applyNormalizedChanges(source, renameNoteChanges(source, '注2', '门的含义'))).toBe(
      '读[^门的含义]，又见[^门的含义]。\n\n[^门的含义]： 旁注。'
    )
  })
  it('rejects collisions, invalid names and duplicate definitions without changing the document', () => {
    const source = '读[^甲]，未写[^乙]。\n\n[^甲]: 原注。'
    for (const label of ['乙', '甲 乙', '甲]乙', ''])
      expect(() => renameNoteChanges(source, '甲', label)).toThrow()
    expect(() => renameNoteChanges(source + '\n\n[^甲]: 重复。', '甲', '丙')).toThrow('重复定义')
  })
  it('defines a missing note without inserting another reference or disturbing unfinished code', () => {
    for (const source of ['正文[^未写]。', '\uFEFF正文[^未写]。\n\n```\n代码']) {
      const next = applyNormalizedChanges(source, defineMissingNote(source, '未写'))
      const note = parseBook(next).notes.find((note) => note.label === '未写')!
      expect(note.missing).toBeFalsy()
      expect(note.refCount).toBe(1)
      expect(projectNote(next, indexNoteSources(next)[0])!.text).toBe('')
      expect(() => defineMissingNote(next, '未写')).toThrow('状态已经变化')
    }
  })
  it('preserves other inline identities and nested relationships during explicit conversion', () => {
    const source = '前^[甲^[乙。]。]。后^[丙。]。再见[^auto-3]。'
    const before = parseBook(source)
    for (const region of indexNoteSources(source).filter((note) => note.inline)) {
      const next = applyNormalizedChanges(source, expandInlineNote(source, region))
      const after = parseBook(next)
      expect(
        after.notes.map((note) => [note.label, note.html, note.refCount, note.parentIds]).sort()
      ).toEqual(
        before.notes.map((note) => [note.label, note.html, note.refCount, note.parentIds]).sort()
      )
    }
  })
  it('keeps inline identities when several explicit notes also contain inline branches', () => {
    const sources = [
      '前^[甲^[乙^[更深。]。]。]。后^[丙^[丁。]。]。\n\n[^孤]: 孤注^[另一条^[另一条的子注。]。]。',
      '正文[^甲]，还有^[旁注^[子注。]。]。\n\n[^甲]: 引注^[第一支线。]。\n\n[^乙]: 另注^[第二支线^[继续。]。]。',
      '[^前]: 一段^[最早的子注。]。\n\n正文^[中间^[里面。]。]，又见[^前]。\n\n[^后]: 一段^[最晚的子注。]。'
    ]
    for (const source of sources) {
      const before = parseBook(source)
      for (const region of indexNoteSources(source).filter((note) => note.inline)) {
        const next = applyNormalizedChanges(source, expandInlineNote(source, region))
        const after = parseBook(next)
        expect(semanticNotes(after), region.label + ' in ' + source).toEqual(semanticNotes(before))
      }
    }
  })
  it('locates the first real definitions and preserves GFM, Chinese syntax and blank lines', () => {
    const source =
      '# 原文\n\n```md\n[^伪]: 代码。\n```\n\n正文[^甲] [注2]。\n\n  [^甲]： 首行。\n\n\n\t第二段。\n    第三行。\n\n下一段正文。\n\n注2： 中文定义。\n\n[^甲]: 重复定义。'
    const regions = indexNoteSources(source)
    expect(regions.map((note) => note.label)).toEqual(['甲', '注2'])
    expect(source.slice(regions[0].from, regions[0].to)).toBe(
      '  [^甲]： 首行。\n\n\n\t第二段。\n    第三行。'
    )
    expect(projectNote(source, regions[0])!.text).toBe('首行。\n\n\n第二段。\n第三行。')
    expect(projectNote(source, regions[1])!.text).toBe('中文定义。')
  })
  it('tracks same-line, multiline and nested inline notes back to their exact source', () => {
    const source =
      '甲^[解释 `]` 和 [链接](x)，继续^[更深]。]乙^[另一注\n下一行。]。\n\n[^外]: 一段文字。\n\n    注中^[另一个内注^[子注]。]结束。'
    const regions = indexNoteSources(source)
    const fragments = regions.map((note) => source.slice(note.from, note.to))
    expect(fragments).toContain('^[解释 `]` 和 [链接](x)，继续^[更深]。]')
    expect(fragments).toContain('^[另一注\n下一行。]')
    expect(fragments).toContain('^[更深]')
    expect(fragments).toContain('^[另一个内注^[子注]。]')
    expect(fragments).toContain('^[子注]')
    for (const note of regions) expect(projectNote(source, note)).not.toBeNull()
  })
  it('keeps mathematical and code lookalikes outside the editable definition index', () => {
    const source =
      '# 范例\n\\[\n[^公式]: x^2\n\\]\n\n    [^缩进]: 代码\n\n文字 $x^{[^内]}$ 与 `^[代码]`。\n\n[^真]: \\(x^2\\)，然后有一条行内注^[解释]。'
    expect(indexNoteSources(source).map((note) => note.label)).toEqual(['真', 'auto-1'])
  })
  it('edits Unicode in a note without changing BOM, surrounding bytes, mixed EOLs or indentation', () => {
    const raw =
      '\uFEFF正文[^甲]。\r\n\r\n[^甲]: 首行🐈。\r\n\r\n\t第二段。\n    尾段。\r\n\r\n末尾正文。'
    const source = normalizeSource(raw),
      region = indexNoteSources(source)[0]
    const projection = projectNote(source, region)!
    const at = projection.text.indexOf('第二')
    const edits = noteChanges(projection, [{ from: at, to: at + 2, insert: '修改后的' }])
    expect(applySourceChanges(raw, edits)).toBe(raw.replace('第二', '修改后的'))
  })
  it('maps deletion across a continuation line without leaving its indentation in the text', () => {
    const source = '[^甲]: 第一行\n    第二行\n\n    第三段'
    const projection = projectNote(source, indexNoteSources(source)[0])!
    const at = projection.text.indexOf('\n')
    const next = applyNormalizedChanges(
      source,
      noteChanges(projection, [{ from: at, to: at + 1, insert: '，' }])
    )
    expect(next).toBe('[^甲]: 第一行，第二行\n\n    第三段')
  })
  it('inserts arbitrary paragraphs, lists and code while keeping continuation syntax valid', () => {
    const source = '[^甲]: 旧内容'
    const projection = projectNote(source, indexNoteSources(source)[0])!
    const content = '新段。\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1\n```\n'
    const next = applyNormalizedChanges(
      source,
      noteChanges(projection, [{ from: 0, to: projection.text.length, insert: content }])
    )
    const region = { ...indexNoteSources(source)[0], to: next.length }
    expect(projectNote(next, region)!.text).toBe(content)
    const note = parseBook(next).notes[0]
    expect(note.html).toContain('<ul>')
    expect(note.html).toContain('const x = 1')
  })
  it('does not mistake an unclosed inline note for a closed one or include following definitions', () => {
    const source = '文字^[未闭合的注释\n\n[^另]: 定义。'
    const note = indexNoteSources(source).find((note) => note.inline)!
    expect(note.closed).toBe(false)
    expect(source.slice(note.from, note.to)).toBe('^[未闭合的注释')
    expect(() => expandInlineNote(source, note)).toThrow('尚未闭合')
  })
  it('reserves undefined references and creates a single undoable reference/definition change set', () => {
    const source = '未定义[^1]，选择这句话。\n\n[^3]: 孤立注。'
    const position = source.indexOf('。')
    const result = createNoteChanges(source, position)
    expect(result.label).toBe('2')
    const next = applyNormalizedChanges(source, result.changes)
    expect(next).toContain('选择这句话[^2]。')
    expect(
      projectNote(
        next,
        indexNoteSources(next).find((note) => note.label === '2')!
      )!.text
    ).toBe('')
  })
  it('places a definition before an unfinished final code block instead of swallowing it', () => {
    const source = '正文。\n\n```md\n未完成代码'
    const result = createNoteChanges(source, 2),
      next = applyNormalizedChanges(source, result.changes)
    expect(next).toContain('正文[^1]。')
    expect(indexNoteSources(next).map((note) => note.label)).toEqual(['1'])
    expect(next.endsWith('```md\n未完成代码')).toBe(true)
  })
  it('rejects reference creation inside a fenced code block or a formula before changing source', () => {
    expect(() => createNoteChanges('```\nabc\n```', 6)).toThrow('代码与公式')
    expect(() => createNoteChanges('$abc$', 2)).toThrow('代码与公式')
  })
  it('supports creating a nested note within an existing continuation paragraph', () => {
    const source = '正文[^甲]。\n\n[^甲]: 第一段。\n\n    第二段。'
    const result = createNoteChanges(source, source.lastIndexOf('。'))
    const next = applyNormalizedChanges(source, result.changes)
    const child = parseBook(next).notes.find((note) => note.label === result.label)!
    expect(child.level).toBe(2)
    expect(child.parentIds).toHaveLength(1)
  })
  it('deliberately expands an inline note while retaining its shared alias and source text', () => {
    const source = '一句^[两段\n说明。]。另见[^auto-1]。\n\n不改这段。'
    const region = indexNoteSources(source)[0]
    const next = applyNormalizedChanges(source, expandInlineNote(source, region))
    const parsed = parseBook(next)
    expect(parsed.notes).toHaveLength(1)
    expect(parsed.notes[0].refCount).toBe(2)
    expect(parsed.notes[0].html).toContain('说明。')
    expect(next).toContain('一句[^auto-1]。另见[^auto-1]。\n\n不改这段。')
  })
})
