import type { AnnotationBlock } from '../../../shared/ai-types'
import type { ParsedBook } from '../../../shared/types'
import type { SyntaxAnchor } from './syntax-ranges'
import { searchTextParts } from '../composables/searchText'

export interface DocumentAnnotationBlock extends AnnotationBlock {
  anchors: SyntaxAnchor[]
}
/** Build addresses from every parsed section and note, without mounting or scrolling them. */
export async function documentAnnotationTarget(
  book: ParsedBook,
  signal: AbortSignal
): Promise<DocumentAnnotationBlock[]> {
  const blocks: DocumentAnnotationBlock[] = []
  const owners = [
    ...book.sections.map((s) => ({ kind: 'section' as const, id: s.id, html: s.html })),
    ...book.notes
      .filter((n) => !n.missing)
      .map((n) => ({ kind: 'note' as const, id: n.label, html: n.html }))
  ]
  let lastYield = performance.now()
  for (let index = 0; index < owners.length; index++) {
    if (signal.aborted) throw Error('全文标注已取消。')
    const owner = owners[index],
      template = document.createElement('template')
    template.innerHTML = owner.html
    for (const inline of template.content.querySelectorAll<HTMLElement>('[data-source-inline]')) {
      const parts = searchTextParts(inline, true),
        text = parts.map((p) => p.text).join('')
      if (!text.trim()) continue
      let offset = 0
      const anchors = parts.map((part): SyntaxAnchor => {
        const start = offset
        offset += part.text.length
        return {
          kind: owner.kind,
          id: owner.id,
          inline: Number(inline.dataset.sourceInline),
          text,
          from: start,
          to: offset,
          start,
          end: offset,
          ...(part.atomic
            ? { contentKind: 'math' as const }
            : part.node.parentElement?.closest('code')
              ? { contentKind: 'code' as const }
              : {})
        }
      })
      blocks.push({ id: `b-${index}-${inline.dataset.sourceInline}`, text, anchors })
    }
    if (performance.now() - lastYield > 4) {
      await new Promise<void>((done) => setTimeout(done, 0))
      lastYield = performance.now()
    }
  }
  return blocks
}
