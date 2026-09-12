import type { NoteRecord } from '../../../shared/types'

export type NoteScope = 'all' | 'focus' | 'pinned'
export interface NotePlace {
  blockIndex: number
  offset: number
  height: number
  cardOffset: number
}
export interface NoteVisit {
  /** Author labels survive reparsing when an earlier note changes its generated id. */
  label: string
  scope: NoteScope
  place: NotePlace | null
}
export interface NoteJourney {
  visits: NoteVisit[]
  index: number
}
export function newNoteJourney(): NoteJourney {
  return { visits: [], index: -1 }
}
export function enterNote(journey: NoteJourney, visit: NoteVisit): void {
  if (journey.visits[journey.index]?.label === visit.label) {
    journey.visits[journey.index] = visit
    return
  }
  journey.visits.splice(journey.index + 1)
  journey.visits.push(visit)
  if (journey.visits.length > 40) journey.visits.shift()
  journey.index = journey.visits.length - 1
}
export function retainJourneyLabels(journey: NoteJourney, labels: Set<string>): void {
  const visits: NoteVisit[] = []
  let index = -1
  journey.visits.forEach((visit, previousIndex) => {
    if (!labels.has(visit.label)) return
    visits.push(visit)
    if (previousIndex <= journey.index) index = visits.length - 1
  })
  journey.visits = visits
  journey.index = index < 0 && visits.length ? 0 : index
}

/** Build once per parse; follow all descendant links without recursion or duplicate visits. */
export function noteChildren(notes: NoteRecord[]): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>()
  for (const note of notes) {
    for (const spot of note.anchorSpots) {
      if (spot.kind !== 'note') continue
      let targets = children.get(spot.parentNoteId)
      if (!targets) children.set(spot.parentNoteId, (targets = new Set()))
      targets.add(note.id)
    }
  }
  return children
}
export function reachableNotes(
  children: Map<string, Set<string>>,
  roots: Iterable<string>
): Set<string> {
  const found = new Set(roots),
    queue = [...found]
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return found
}
