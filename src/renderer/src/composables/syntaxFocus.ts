import { computed } from 'vue'
import { aiState, SYNTAX_DEMOS } from './aiReading'
import { syntaxProjection } from '../../../shared/syntax-view'
import type { SyntaxAnalysis } from '../../../shared/ai-types'
export const displayedSyntax = computed(() =>
  aiState.demonstration
    ? SYNTAX_DEMOS[aiState.syntaxExample].analysis
    : aiState.runs.syntax.analysis
)
export function focusedSyntax(analysis: SyntaxAnalysis): ReturnType<typeof syntaxProjection> & {
  relation: ReturnType<typeof syntaxProjection>['relations'][number] | undefined
  members: Set<string>
} {
  const projection = syntaxProjection(analysis, aiState.syntaxReading)
  const unit = projection.units.find((item) => item.index === aiState.activeSpan)
  let relation = projection.relations.find((item) => item.id === aiState.syntaxRelation)
  if (unit && (!relation || ![relation.from, ...relation.to].includes(unit.id)))
    relation = projection.relations.find((item) => [item.from, ...item.to].includes(unit.id))
  if (!unit && !relation) relation = projection.relations[0]
  return {
    ...projection,
    relation,
    members: new Set(relation ? [relation.from, ...relation.to] : unit ? [unit.id] : [])
  }
}
export function chooseSyntaxReading(id: string): void {
  aiState.syntaxReading = id
  aiState.syntaxRelation = ''
  aiState.activeSpan = -1
}
