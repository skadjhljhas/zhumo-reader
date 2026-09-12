import { createNoteChanges, indexNoteSources } from './noteAuthoring'
import { applySourceChanges, normalizeSource } from './sourceText'
import { encodeNoteRange } from '../../../shared/note-range'

export function createSelectionNote(
  source: string,
  position: number,
  quote: string,
  body: string
): { source: string; label: string } {
  if (!body.trim()) throw Error('请先写下你的注释。')
  if (!quote.trim() || quote.length > 64000)
    throw Error('注释范围应在64k字符以内，请缩小选区；原选文未改动。')
  const normalized = normalizeSource(source),
    labels = new Set(indexNoteSources(normalized).map((note) => note.label))
  let number = 1
  while (labels.has('用户注释:' + number)) number++
  const label = '用户注释:' + number
  const created = createNoteChanges(normalized, position, label)
  const definition = `[^${label}]: `
  const content = body
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .split('\n')
    .map((line, index) => (index ? '    ' + line : line))
    .join('\n')
  const metadata = encodeNoteRange(label, quote, crypto.randomUUID())
  const changes = created.changes.map((change) => ({
    ...change,
    insert: change.insert.replace(definition, definition + content + '\n\n' + metadata + '\n')
  }))
  return { source: applySourceChanges(source, changes), label }
}
export function rawSelectionOffset(source: string, normalizedOffset: number): number {
  let normalized = 0
  for (let i = 0; i < source.length; i++, normalized++) {
    if (normalized === normalizedOffset) return i
    if (source[i] === '\r' && source[i + 1] === '\n') i++
  }
  if (normalized === normalizedOffset) return source.length
  throw Error('选区源文坐标失效。')
}
