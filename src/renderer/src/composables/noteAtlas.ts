import type { NoteBodySpot, NoteRecord } from '../../../shared/types'

export type AtlasEntry =
  | { key: string; kind: 'body'; title: string; spot: NoteBodySpot; occurrence: number }
  | { key: string; kind: 'note'; note: NoteRecord }

/** Relationships are explicit references from the parsed manuscript, never inferred similarity. */
export function createNoteAtlas(notes: NoteRecord[]): {
  byId: Map<string, NoteRecord>
  byLabel: Map<string, NoteRecord>
  edgeCount: number
  neighborhood: (id: string) => {
    incoming: AtlasEntry[]
    outgoing: AtlasEntry[]
    selfReference: boolean
  }
} {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const byLabel = new Map(notes.map((note) => [note.label, note]))
  const children = new Map<string, NoteRecord[]>()
  let edgeCount = 0
  for (const note of notes) {
    const parents = new Set(
      note.anchorSpots.filter((spot) => spot.kind === 'note').map((spot) => spot.parentNoteId)
    )
    for (const parent of parents) {
      if (!byId.has(parent)) continue
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent)!.push(note)
      edgeCount++
    }
  }
  return {
    byId,
    byLabel,
    edgeCount,
    neighborhood(id) {
      const note = byId.get(id)
      if (!note) return { incoming: [], outgoing: [], selfReference: false }
      const incoming: AtlasEntry[] = [],
        seen = new Set<string>()
      let occurrence = 0
      for (const spot of note.anchorSpots) {
        if (spot.kind === 'note') {
          const parent = byId.get(spot.parentNoteId)
          if (parent && parent.id !== id && !seen.has(parent.id)) {
            incoming.push({ key: `note:${parent.id}`, kind: 'note', note: parent })
            seen.add(parent.id)
          }
        } else {
          // Number this note's manuscript entries globally, including identically named headings.
          occurrence++
          incoming.push({
            key: `body:${spot.sectionId}:${spot.order}`,
            kind: 'body',
            title: spot.sectionTitle || '正文',
            spot,
            occurrence
          })
        }
      }
      return {
        incoming,
        outgoing: (children.get(id) ?? [])
          .filter((child) => child.id !== id)
          .map((child) => ({ key: `note:${child.id}`, kind: 'note', note: child })),
        selfReference: (children.get(id) ?? []).some((child) => child.id === id)
      }
    }
  }
}

export function atlasPage<T>(
  entries: T[],
  page: number,
  size: number
): { entries: T[]; page: number; pages: number; start: number; end: number; total: number } {
  const count = Math.max(1, Math.floor(size))
  const pages = Math.max(1, Math.ceil(entries.length / count))
  const current = Math.max(0, Math.min(pages - 1, Math.floor(page)))
  const start = current * count
  return {
    entries: entries.slice(start, start + count),
    page: current,
    pages,
    start: entries.length ? start + 1 : 0,
    end: Math.min(entries.length, start + count),
    total: entries.length
  }
}
