import type MarkdownIt from 'markdown-it'

export const DISPLAY_ENVIRONMENTS =
  'equation|align|alignat|flalign|gather|multline|displaymath|eqnarray'
export const displayEnvironmentStart = new RegExp(
  '^\\\\begin\\s*\\{\\s*(' + DISPLAY_ENVIRONMENTS + ')\\*?\\s*\\}'
)

/** Accept complete standalone AMS environments without inventing missing delimiters. */
export function markdownExtensions(md: InstanceType<typeof MarkdownIt>): void {
  md.block.ruler.before(
    'fence',
    'zmu_ams_environment',
    (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false
      const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start])
      if (!displayEnvironmentStart.test(first)) return false
      const stack: string[] = []
      for (let line = start; line < end; line++) {
        if (line > start && state.sCount[line] < state.blkIndent && !state.isEmpty(line))
          return false
        const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
        for (const match of text.matchAll(/\\(begin|end)\s*\{\s*([a-zA-Z]+\*?)\s*\}/g)) {
          if (match[1] === 'begin') stack.push(match[2])
          else {
            if (stack.pop() !== match[2]) return false
            if (!stack.length) {
              if (text.slice(match.index! + match[0].length).trim()) return false
              if (silent) return true
              const token = state.push('math_block', 'math', 0)
              token.block = true
              token.content = state.getLines(start, line + 1, state.tShift[start], false).trimEnd()
              token.map = [start, line + 1]
              token.markup = 'ams-environment'
              state.line = line + 1
              return true
            }
          }
        }
      }
      return false
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  )
  md.core.ruler.after('inline', 'zmu_task_lists', (state) => {
    for (let i = 2; i < state.tokens.length; i++) {
      const inline = state.tokens[i],
        first = inline.children?.[0]
      if (
        inline.type !== 'inline' ||
        state.tokens[i - 1].type !== 'paragraph_open' ||
        state.tokens[i - 2].type !== 'list_item_open' ||
        first?.type !== 'text'
      )
        continue
      const task = /^\[([ xX])\][ \t]+/.exec(first.content)
      if (!task) continue
      first.content = first.content.slice(task[0].length)
      const box = new state.Token('html_inline', '', 0)
      box.content =
        '<input class="zmu-task-checkbox" type="checkbox" disabled aria-label="' +
        (task[1] === ' ' ? '未完成' : '已完成') +
        '"' +
        (task[1] === ' ' ? '' : ' checked') +
        ' /> '
      inline.children!.unshift(box)
      state.tokens[i - 2].attrJoin('class', 'zmu-task-item')
    }
  })
}
