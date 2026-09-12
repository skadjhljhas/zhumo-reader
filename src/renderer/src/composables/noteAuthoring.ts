import { preprocess } from '../parser/preprocess'
import { protectMathSource } from '../parser/protect-math'
import { buildGraph } from '../parser/graph'
import { indentOf, isBlankLine, matchDefStart, stripIndent } from '../parser/scan'
import { normalizeSource, type SourceChange } from './sourceText'

export interface NoteSourceRegion {
  label: string
  from: number
  to: number
  inline: boolean
  closed: boolean
  continuationIndent: number
  contentFrom?: number
}
export interface NoteProjection {
  text: string
  offsets: number[]
  indent: string
}
export interface WriterPlace {
  anchor: number
  head: number
  scroll: number
  previewScroll?: number
}

/** Source offsets use the same LF document as CodeMirror, including a possible BOM. */
export function inspectNoteSource(source: string): {
  notes: NoteSourceRegion[]
  references: Array<{ label: string; from: number; to: number; parent?: string }>
} {
  const normalized = normalizeSource(source)
  const bom = normalized.startsWith('\uFEFF') ? 1 : 0
  const protectedMath = protectMathSource(normalized.slice(bom))
  if (protectedMath.source.length !== normalized.length - bom)
    throw new Error('无法建立这份文稿的注释位置，请在源文中编辑。')
  const pre = preprocess(protectedMath.source, { trackSource: true })
  const notes = pre.definitions.flatMap((def) =>
    def.source
      ? [
          {
            label: def.label,
            from: def.source.from + bom,
            to: def.source.to + bom,
            inline: def.source.inline,
            closed: def.source.closed,
            continuationIndent: def.source.continuationIndent,
            contentFrom: def.source.offsets[0] + bom
          }
        ]
      : []
  )
  const references = [
    ...pre.bodyRefs.flatMap((ref) =>
      ref.source ? [{ label: ref.label, from: ref.source.from + bom, to: ref.source.to + bom }] : []
    ),
    ...pre.noteRefs.flatMap((ref) =>
      ref.source
        ? [
            {
              label: ref.target,
              from: ref.source.from + bom,
              to: ref.source.to + bom,
              parent: ref.parent
            }
          ]
        : []
    )
  ]
  return { notes, references }
}
export function indexNoteSources(source: string): NoteSourceRegion[] {
  return inspectNoteSource(source).notes
}

/** Project the real source without reserializing untouched whitespace or note syntax. */
export function projectNote(source: string, region: NoteSourceRegion): NoteProjection | null {
  if (region.from < 0 || region.to > source.length || region.to < region.from) return null
  const raw = source.slice(region.from, region.to)
  let from: number, to: number
  if (region.inline) {
    if (!raw.startsWith('^[') || (region.closed && !raw.endsWith(']'))) return null
    from = region.from + 2
    to = region.to - (region.closed ? 1 : 0)
  } else {
    const first = raw.split('\n', 1)[0]
    const definition = matchDefStart(first)
    if (!definition || definition.label !== region.label) return null
    from = region.contentFrom ?? region.from + first.length - definition.content.length
    if (from < region.from || from > region.to) return null
    to = region.to
  }
  const lines = source.slice(from, to).split('\n')
  let start = from,
    text = '',
    indent = ' '.repeat(region.continuationIndent)
  const offsets: number[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const strip = index > 0 && region.continuationIndent > 0
    const column =
      strip && (indentOf(line) >= region.continuationIndent || isBlankLine(line))
        ? line.length - stripIndent(line, region.continuationIndent).length
        : 0
    if (strip && line.startsWith('\t')) indent = '\t'
    if (index > 0) {
      text += '\n'
      offsets.push(start - 1)
    }
    text += line.slice(column)
    for (let i = column; i < line.length; i++) offsets.push(start + i)
    start += line.length + 1
  }
  offsets.push(to)
  return { text, offsets, indent }
}

export function noteChanges(projection: NoteProjection, changes: SourceChange[]): SourceChange[] {
  return changes.map((change) => {
    if (change.from < 0 || change.to < change.from || change.to > projection.text.length)
      throw new Error('注释位置已经变化，请重新打开这条注释。')
    return {
      from: projection.offsets[change.from],
      to: projection.offsets[change.to],
      insert: change.insert.replace(/\n/g, '\n' + projection.indent)
    }
  })
}

function scan(source: string): ReturnType<typeof preprocess> {
  return preprocess(protectMathSource(source.replace(/^\uFEFF/, '')).source)
}
export function nextNoteLabel(source: string): string {
  const pre = scan(source)
  const used = new Set([
    ...pre.definitions.map((def) => def.label),
    ...pre.bodyRefs.map((ref) => ref.label),
    ...pre.noteRefs.map((ref) => ref.target)
  ])
  for (const note of buildGraph(pre, 4).nodes) {
    used.add(note.displayMark)
    // Type-only labels display their document position. Inserting one note
    // before them can advance that position by one; reserve that value too.
    if (note.label === note.typeLabel) used.add(String(note.number + 1))
  }
  let number = 1
  while (used.has(String(number))) number++
  return String(number)
}

export function applyNormalizedChanges(source: string, changes: SourceChange[]): string {
  let result = source
  for (const change of [...changes].sort((a, b) => b.from - a.from))
    result = result.slice(0, change.from) + change.insert + result.slice(change.to)
  return result
}

export function defineMissingNote(source: string, label: string): SourceChange[] {
  const index = inspectNoteSource(source)
  if (
    index.notes.some((note) => note.label === label) ||
    !index.references.some((ref) => ref.label === label)
  )
    throw new Error('这条注释的状态已经变化，请重新选择。')
  const changes = [{ from: source.length, to: source.length, insert: `\n\n[^${label}]: ` }]
  if (
    indexNoteSources(applyNormalizedChanges(source, changes)).some((note) => note.label === label)
  )
    return changes
  const start = source.startsWith('\uFEFF') ? 1 : 0
  return [{ from: start, to: start, insert: `[^${label}]: \n\n` }]
}

export function renameNoteChanges(
  source: string,
  label: string,
  nextLabel: string
): SourceChange[] {
  if (nextLabel === label) return []
  if (!nextLabel || /[\s[\]\p{C}]/u.test(nextLabel))
    throw new Error('标号不能为空，也不能包含空白或方括号。')
  const index = inspectNoteSource(source)
  const note = index.notes.find((note) => note.label === label)
  if (!note || note.inline) throw new Error('请先将行内注转为独立注释。')
  if (
    scan(source).warnings.some((warning) => warning.kind === 'duplicate' && warning.label === label)
  )
    throw new Error('文稿中有同名的重复定义，请先在源文中整理，再更新标号。')
  if (
    index.notes.some((note) => note.label === nextLabel) ||
    index.references.some((ref) => ref.label === nextLabel)
  )
    throw new Error('这个标号已经被使用，请换一个名称。')
  const firstLine = source.slice(note.from, note.to).split('\n', 1)[0]
  const leading = /^ */.exec(firstLine)![0].length
  const gfm = firstLine.slice(leading).startsWith('[^')
  const start = note.from + leading
  const changes: SourceChange[] = [
    {
      from: start,
      to: start + (gfm ? label.length + 3 : label.length),
      insert: !gfm && /^注\d+$/.test(nextLabel) ? nextLabel : `[^${nextLabel}]`
    }
  ]
  for (const ref of index.references.filter((ref) => ref.label === label)) {
    const old = source.slice(ref.from, ref.to)
    const marker =
      !old.startsWith('[^') && /^注\d+$/.test(nextLabel)
        ? old[0] + nextLabel + old.at(-1)
        : `[^${nextLabel}]`
    changes.push({ from: ref.from, to: ref.to, insert: marker })
  }
  const next = inspectNoteSource(applyNormalizedChanges(source, changes))
  if (
    !next.notes.some((note) => note.label === nextLabel) ||
    next.references.filter((ref) => ref.label === nextLabel).length !==
      index.references.filter((ref) => ref.label === label).length
  )
    throw new Error('这个名称不能形成完整的注释引用，请使用文字、数字或常用标点。')
  return changes.sort((a, b) => a.from - b.from)
}

export function createNoteChanges(
  source: string,
  position: number,
  requestedLabel?: string
): { label: string; changes: SourceChange[] } {
  if (position < 0 || position > source.length) throw new Error('请选择文稿中的注释位置。')
  const label = requestedLabel ?? nextNoteLabel(source)
  if (
    !label ||
    /[\s[\]]/.test(label) ||
    indexNoteSources(source).some((note) => note.label === label)
  )
    throw Error('注释标签已存在或不合法。')
  const mark = `[^${label}]`,
    definition = `\n\n[^${label}]: `
  let changes: SourceChange[] =
    position === source.length
      ? [{ from: position, to: position, insert: mark + definition }]
      : [
          { from: position, to: position, insert: mark },
          { from: source.length, to: source.length, insert: definition }
        ]
  let next = applyNormalizedChanges(source, changes)
  if (!indexNoteSources(next).some((note) => note.label === label)) {
    // An unfinished fence or formula at EOF must not swallow a newly written definition.
    const start = source.startsWith('\uFEFF') ? 1 : 0
    const prefix = `[^${label}]: \n\n`
    changes =
      position === start
        ? [{ from: start, to: start, insert: prefix + mark }]
        : [
            { from: start, to: start, insert: prefix },
            { from: position, to: position, insert: mark }
          ]
    next = applyNormalizedChanges(source, changes)
  }
  const pre = scan(next)
  if (
    !pre.bodyRefs.some((ref) => ref.label === label) &&
    !pre.noteRefs.some((ref) => ref.target === label)
  )
    throw new Error('请将光标放在正文或注释的文字中，代码与公式内不能建立注释引用。')
  return { label, changes }
}

/** A deliberate conversion preserves aliases that may already refer to an inline note. */
export function expandInlineNote(source: string, region: NoteSourceRegion): SourceChange[] {
  if (!region.inline || !region.closed)
    throw new Error('这条行内注尚未闭合，请先在源文中补全括号。')
  const projection = projectNote(source, region)
  if (!projection) throw new Error('注释位置已经变化，请重新打开这条注释。')
  const start = source.startsWith('\uFEFF') ? 1 : 0
  // Reserve the entire moved branch. Otherwise processing it earlier can silently swap
  // automatic aliases in other branches, including aliases referenced by the author.
  const branch = indexNoteSources(source).filter(
    (note) => note.inline && note.from >= region.from && note.to <= region.to
  )
  if (!branch.some((note) => note.label === region.label && note.from === region.from))
    throw new Error('行内注的标号已经变化，请重新打开这条注释。')
  const definition = branch
    .map((note) => {
      const body = projectNote(source, note)
      if (!body) throw new Error('行内注的位置已经变化，请重新打开。')
      const descendants = branch.filter((child) => child.from > note.from && child.to < note.to)
      const direct = descendants.filter(
        (child) =>
          !descendants.some(
            (other) => other !== child && other.from < child.from && other.to > child.to
          )
      )
      const replacements = direct.map((child) => ({
        from: body.offsets.indexOf(child.from),
        to: body.offsets.indexOf(child.to),
        insert: `[^${child.label}]`
      }))
      if (replacements.some((change) => change.from < 0 || change.to < change.from))
        throw new Error('这条行内注暂时不能独立展开，请在源文中编辑。')
      const content = applyNormalizedChanges(body.text, replacements)
      return `[^${note.label}]: ${content.replace(/\n/g, '\n    ')}\n\n`
    })
    .join('')
  const mark = `[^${region.label}]`
  return region.from === start
    ? [{ from: region.from, to: region.to, insert: definition + mark }]
    : [
        { from: start, to: start, insert: definition },
        { from: region.from, to: region.to, insert: mark }
      ]
}
