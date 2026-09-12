import { reactive } from 'vue'
import { EchoHabits } from '../effects/echo-metrics'
export let echoHabits = new EchoHabits()
export const echoState = reactive({
  text: '',
  seconds: 0,
  strength: 0,
  onText: false,
  textSeconds: 0,
  airSeconds: 0,
  textShare: 0.5,
  switches: 0,
  scrollDistance: 0,
  reversals: 0,
  direction: 0,
  activity: 0,
  returnImpulse: 0,
  /** Times this session already lingered on the word under the pointer (visual only). */
  revisits: 0
})
export function resetEchoHabits(): void {
  echoHabits = new EchoHabits()
  Object.assign(echoState, {
    text: '',
    seconds: 0,
    strength: 0,
    onText: false,
    revisits: 0,
    ...echoHabits.value
  })
}
export function echoScrollUniform(): [number, number, number, number] {
  return [echoState.direction, echoState.activity, echoState.returnImpulse, echoState.textShare]
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
/** Read the actual glyph under the pointer; formula layout phantoms are never prose. */
export function echoWordAt(x: number, y: number): Range | undefined {
  const target = document.elementFromPoint(x, y)
  if (
    !target ||
    target.closest(
      'button,a,input,select,textarea,code,pre,.zmu-ref,.zmu-math,.zmu-diagram,[contenteditable=true]'
    )
  )
    return
  const owner = target.closest('.reader-scroll .section-body,.notes-scroll .zmu-note-body')
  if (!owner) return
  const caret = (
    document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }
  ).caretRangeFromPoint(x, y)
  if (
    !caret ||
    caret.startContainer.nodeType !== Node.TEXT_NODE ||
    !owner.contains(caret.startContainer)
  )
    return
  const node = caret.startContainer as Text,
    text = node.data
  for (const offset of [caret.startOffset, caret.startOffset - 1]) {
    if (offset < 0 || offset >= text.length) continue
    const glyph = document.createRange()
    glyph.setStart(node, offset)
    glyph.setEnd(node, Math.min(text.length, offset + 1))
    const rect = glyph.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    const begin = Math.max(0, offset - 72),
      piece = text.slice(begin, offset + 72)
    for (const part of segmenter.segment(piece)) {
      let from = begin + part.index,
        to = from + part.segment.length
      if (!part.isWordLike || from > offset || to <= offset) continue
      // A single function character becomes a short phrase instead of a stray luminous speck.
      if (to - from === 1 && /[\u3400-\u9fff]/.test(part.segment)) {
        while (from > 0 && offset - from < 4 && !/[，。；！？、\s]/.test(text[from - 1])) from--
        while (to < text.length && to - from < 9 && !/[，。；！？、\s]/.test(text[to])) to++
      }
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      return range
    }
  }
  return
}
