import { describe, expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
import {
  enterNote,
  newNoteJourney,
  noteChildren,
  reachableNotes,
  retainJourneyLabels
} from '../src/renderer/src/composables/noteJourney'

describe('annotation reading paths', () => {
  it('keeps shared descendants and reachable cycles inside their actual heading', () => {
    const book = parseBook(
      '# 书\n\n## 相同标题\n\n第一处。[^甲]\n\n## 相同标题\n\n另一处。[^乙]\n\n' +
        '[^甲]: 甲注[^共]。\n\n[^乙]: 乙注[^共]。\n\n[^共]: 共同的支线[^深]。\n\n[^深]: 回到共同讨论[^共]。\n\n[^孤]: 未引用材料。'
    )
    expect(book.sections).toHaveLength(1)
    const [first, second] = ['甲', '乙'].map((label) =>
      book.notes.find((note) => note.label === label)!
    )
    expect(first.anchorSpots[0]).toMatchObject({ headingId: 'toc-2', sectionTitle: '相同标题' })
    expect(second.anchorSpots[0]).toMatchObject({ headingId: 'toc-3', sectionTitle: '相同标题' })
    const selected = reachableNotes(noteChildren(book.notes), [first.id])
    expect(
      book.notes
        .filter((note) => selected.has(note.id))
        .map((note) => note.label)
        .sort()
    ).toEqual(['共', '深', '甲'])
    expect(book.sections[0].html).toContain('data-toc-id="toc-3"')
  })

  it('carries heading identity through internal chunks and excludes headings in notes', () => {
    const book = parseBook(
      '# 书\n\n## 这一章\n\n前面的入口[^甲]。\n\n' +
        '完整的一个段落。'.repeat(20).concat('\n\n').repeat(220) +
        '后面的入口[^乙]。\n\n[^甲]: ### 注释里的标题\n\n    仍然是注释。\n\n[^乙]: 另一个入口。'
    )
    expect(book.sections.length).toBeGreaterThan(2)
    const spots = book.notes.map((note) => note.anchorSpots[0])
    expect(spots).toEqual(expect.arrayContaining([expect.objectContaining({ headingId: 'toc-2' })]))
    expect(spots.every((spot) => spot.kind === 'body' && spot.headingId === 'toc-2')).toBe(true)
    expect(book.notes[0].html).not.toContain('data-toc-id')
  })

  it('a new branch after going back replaces the forward path and preserves the departure place', () => {
    const journey = newNoteJourney()
    const place = { blockIndex: 7, offset: -16, height: 70, cardOffset: -800 }
    enterNote(journey, { label: '母', scope: 'pinned', place })
    enterNote(journey, { label: '旧支线', scope: 'all', place: null })
    journey.index = 0
    enterNote(journey, { label: '新支线', scope: 'all', place: null })
    expect(journey.visits.map((visit) => visit.label)).toEqual(['母', '新支线'])
    expect(journey.visits[0]).toMatchObject({ scope: 'pinned', place })
    expect(journey.index).toBe(1)
  })

  it('reparsing keeps author labels while removed notes cannot leave dead history buttons', () => {
    const journey = newNoteJourney()
    for (const label of ['甲', '删去', '乙', '甲'])
      enterNote(journey, { label, scope: 'all', place: null })
    journey.index = 1
    retainJourneyLabels(journey, new Set(['甲', '乙']))
    expect(journey.visits.map((visit) => visit.label)).toEqual(['甲', '乙', '甲'])
    expect(journey.index).toBe(0)
    retainJourneyLabels(journey, new Set())
    expect(journey).toEqual(newNoteJourney())
  })

  it('walks deeply nested graphs without recursive stack growth', () => {
    const children = new Map(
      Array.from({ length: 15000 }, (_, index) => [`n${index}`, new Set([`n${index + 1}`])])
    )
    children.set('n15000', new Set(['n1']))
    expect(reachableNotes(children, ['n0']).size).toBe(15001)
  })
})
