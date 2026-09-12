import type { SourceBlock } from '../../../shared/types'
import type { SourceLine } from './types'

export interface RenderProvenance {
  body: SourceLine[]
  notes: Map<string, { lines: SourceLine[]; from: number; to: number }>
  offset: number
}
interface Scope {
  kind: 'section' | 'note'
  id: string
  label?: string
  lines: SourceLine[]
}
/** Transient character maps become small block landmarks; no character arrays
 * are retained in ParsedBook or added to the user's Markdown.
 */
export class SourceMapBuilder {
  readonly blocks: SourceBlock[] = []
  scope: Scope | undefined
  constructor(private readonly offset: number) {}
  region(from: number, to: number): void {
    if (!this.scope) return
    const { kind, id, label } = this.scope
    this.blocks.push({
      kind,
      id,
      label,
      key: 'row',
      tag: '',
      from: from + this.offset,
      to: to + this.offset
    })
  }
  capture(map: [number, number] | null, key: string, tag: string): SourceBlock | undefined {
    const scope = this.scope
    if (!scope || !map) return
    let from = -1,
      to = -1
    for (let line = map[0]; line < map[1]; line++) {
      const positions = scope.lines[line]
      if (!positions?.starts.length) continue
      if (from < 0) from = positions.starts[0]
      to = positions.ends.at(-1) ?? -1
    }
    if (from < 0 || to < from) return
    const { kind, id, label } = scope
    const block = { kind, id, label, key, tag, from: from + this.offset, to: to + this.offset }
    this.blocks.push(block)
    return block
  }
  attributes(block: SourceBlock | undefined): string {
    return block
      ? ' data-source-block="' +
          block.key +
          '" data-source-from="' +
          block.from +
          '" data-source-to="' +
          block.to +
          '"'
      : ''
  }
  atom(html: string, map: [number, number] | null, key: string, tag: string): string {
    const block = this.capture(map, key, tag)
    return block ? '<!--zmu-source:' + key + ':' + block.from + ':' + block.to + '-->' + html : html
  }
  /** MathJax can render an equation after the rest of the book. Attach its
   * landmark only after the placeholder has become the real outer element.
   */
  finalize(html: string): string {
    return html.replace(
      /<!--zmu-source:([a-z]\d+):(\d+):(\d+)-->(\s*<[a-z][\w:-]*)\b/g,
      (_match, key: string, from: string, to: string, tag: string) =>
        tag +
        ' data-source-block="' +
        key +
        '" data-source-from="' +
        from +
        '" data-source-to="' +
        to +
        '"'
    )
  }
}
