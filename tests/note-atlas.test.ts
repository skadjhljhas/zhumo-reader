import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import { atlasPage, createNoteAtlas } from '../src/renderer/src/composables/noteAtlas'

describe('manuscript annotation atlas', () => {
  it('retains every exact body entry across repeated headings and both parents of a shared note', () => {
    const book = parseBook(
      '# 书\n\n## 同题\n\n第一处[^共]。另一个入口[^甲]。\n\n## 同题\n\n第二处[^共]。另一支线[^乙]。\n\n[^甲]: 参见[^共]。\n\n[^乙]: 也参见[^共]。\n\n[^共]: 共享的讨论。'
    )
    const atlas = createNoteAtlas(book.notes)
    const note = atlas.byLabel.get('共')!
    const entries = atlas.neighborhood(note.id).incoming
    const bodies = entries.filter((entry) => entry.kind === 'body')
    expect(bodies.map((entry) => [entry.title, entry.occurrence, entry.spot.headingId])).toEqual([
      ['同题', 1, 'toc-2'],
      ['同题', 2, 'toc-3']
    ])
    expect(bodies.map((entry) => entry.spot)).toEqual(
      note.anchorSpots.filter((spot) => spot.kind === 'body')
    )
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(4)
    expect(
      entries.filter((entry) => entry.kind === 'note').map((entry) => entry.note.label)
    ).toEqual(['甲', '乙'])
    expect(atlas.edgeCount).toBe(2)
    expect(atlas.neighborhood(atlas.byLabel.get('甲')!.id).outgoing).toMatchObject([
      { note: { label: '共' } }
    ])
  })

  it('shows cycles and missing definitions without inventing links from similar prose', () => {
    const book = parseBook(
      '入口[^甲]。\n\n[^甲]: 一段相同文字。[^乙][^乙][^甲][^缺]\n\n[^乙]: 一段相同文字。[^甲]\n\n[^孤]: 一段相同文字。'
    )
    const atlas = createNoteAtlas(book.notes)
    const selected = atlas.neighborhood(atlas.byLabel.get('甲')!.id)
    expect(selected.selfReference).toBe(true)
    expect(selected.outgoing.map((entry) => entry.kind === 'note' && entry.note.label)).toEqual([
      '乙',
      '缺'
    ])
    expect(
      selected.incoming.filter((entry) => entry.kind === 'note').map((entry) => entry.note.label)
    ).toEqual(['乙'])
    expect(atlas.edgeCount).toBe(4)
    expect(atlas.byLabel.get('缺')?.missing).toBe(true)
    expect(atlas.byLabel.get('孤')?.orphan).toBe(true)
    expect(atlas.neighborhood(atlas.byLabel.get('孤')!.id)).toEqual({
      incoming: [],
      outgoing: [],
      selfReference: false
    })
    expect(atlas.neighborhood('removed-note')).toEqual({
      incoming: [],
      outgoing: [],
      selfReference: false
    })
  })

  it('keeps all 257 branches reachable in manuscript order when the visible capacity changes', () => {
    const labels = Array.from({ length: 257 }, (_, i) => `支线${i}`)
    const book = parseBook(
      '入口[^根]。\n\n[^根]: ' +
        labels.map((label) => `[^${label}]`).join(' ') +
        '\n\n' +
        labels.map((label) => `[^${label}]: ${label}的讨论。`).join('\n\n')
    )
    const atlas = createNoteAtlas(book.notes)
    const branches = atlas.neighborhood(atlas.byLabel.get('根')!.id).outgoing
    for (const size of [1, 2, 4]) {
      const pages = atlasPage(branches, 0, size).pages
      const visible = Array.from(
        { length: pages },
        (_, page) => atlasPage(branches, page, size).entries
      ).flat()
      expect(visible.map((entry) => entry.kind === 'note' && entry.note.label)).toEqual(labels)
      const last = atlasPage(branches, 10000, size)
      expect(last.end).toBe(257)
      expect(last.page).toBe(pages - 1)
    }
    expect(atlasPage(branches, -5, 4).start).toBe(1)
    expect(atlasPage([], 12, 2)).toEqual({
      entries: [],
      page: 0,
      pages: 1,
      start: 0,
      end: 0,
      total: 0
    })
  })

  it('builds independent indexes after reopening another manuscript with reused internal IDs', () => {
    const first = parseBook('入口[^甲]。\n\n[^甲]: 参见[^乙]。\n\n[^乙]: 旧支线。')
    const before = JSON.stringify(first)
    const previous = createNoteAtlas(first.notes)
    previous.neighborhood(first.notes[0].id)
    const next = createNoteAtlas(parseBook('入口[^新]。\n\n[^新]: 独立的讨论。').notes)
    expect(next.byLabel.has('甲')).toBe(false)
    expect(next.neighborhood(first.notes[0].id).outgoing).toHaveLength(0)
    expect(previous.neighborhood(first.notes[0].id).outgoing).toHaveLength(1)
    expect(JSON.stringify(first)).toBe(before)
  })
})
