import type { ParsedBook } from '../../../shared/types'
import { searchBlocks } from './searchText'

export interface FormulaLocation {
  kind: 'section' | 'note'
  id: string
  blockIndex: number
}

/** Search the complete reading projection, including currently unmounted sections and notes. */
export function findEquation(book: ParsedBook, hash: string): FormulaLocation | undefined {
  let id: string
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''))
  } catch {
    return undefined
  }
  if (!id.startsWith('mjx-eqn:')) return undefined
  for (const kind of ['section', 'note'] as const) {
    for (const entry of kind === 'section' ? book.sections : book.notes) {
      if (!entry.html.includes('id="mjx-eqn:')) continue
      const template = document.createElement('template')
      template.innerHTML = entry.html
      const target = template.content.querySelector(`[id="${CSS.escape(id)}"]`)
      if (!target) continue
      const blockIndex = searchBlocks(template.content).findIndex((block) => block.contains(target))
      return { kind, id: entry.id, blockIndex: Math.max(0, blockIndex) }
    }
  }
  return undefined
}
