export interface NoteRange {
  version: 1
  label: string
  text: string
  end: 'note-reference'
}
export function encodeNoteRange(label: string, text: string, id: string): string {
  return `[zhumo-range-${id}]: zhumo-range:v1 "${encodeURIComponent(JSON.stringify({ version: 1, label, text, end: 'note-reference' }))}"`
}
export function noteRanges(references: unknown): Map<string, NoteRange> {
  const result = new Map<string, NoteRange>()
  const duplicated = new Set<string>()
  if (!references || typeof references !== 'object') return result
  for (const [key, value] of Object.entries(references)) {
    if (!key.toLowerCase().startsWith('zhumo-range-') || !value || typeof value !== 'object')
      continue
    const ref = value as { href?: unknown; title?: unknown }
    if (ref.href !== 'zhumo-range:v1' || typeof ref.title !== 'string' || ref.title.length > 800000)
      continue
    try {
      const v = JSON.parse(decodeURIComponent(ref.title))
      if (
        v.version === 1 &&
        typeof v.label === 'string' &&
        v.label.length <= 200 &&
        typeof v.text === 'string' &&
        v.text.length > 0 &&
        v.text.length <= 64000 &&
        v.end === 'note-reference'
      ) {
        if (result.has(v.label)) {
          result.delete(v.label)
          duplicated.add(v.label)
        } else if (!duplicated.has(v.label)) result.set(v.label, v)
      }
    } catch {
      /* A foreign or damaged link definition is not a range instruction. */
    }
  }
  return result
}
