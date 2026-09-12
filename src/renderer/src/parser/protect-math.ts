import { displayEnvironmentStart } from './markdown-extensions'
/** Protect TeX punctuation while the note scanner runs; restore before graph/render passes. */
export function protectMathSource(source: string): {
  source: string
  restore: (text: string) => string
} {
  const punctuation = ['[', ']', '^', '#', '【', '】', ':', '：']
  let base = 0xe000
  while (punctuation.some((_, i) => source.includes(String.fromCodePoint(base + i))))
    base += punctuation.length
  const encode = new Map(punctuation.map((ch, i) => [ch, String.fromCodePoint(base + i)]))
  const decode = new Map([...encode].map(([ch, replacement]) => [replacement, ch]))
  const masked = (text: string): string => text.replace(/[[\]^#【】:：]/g, (ch) => encode.get(ch)!)
  const escaped = (index: number): boolean => {
    let slashes = 0
    while (source[--index] === '\\') slashes++
    return slashes % 2 === 1
  }
  const parts: string[] = []
  let plainStart = 0
  let i = 0
  while (i < source.length) {
    const lineStart = i === 0 || source[i - 1] === '\n'
    if (lineStart) {
      const endOfLine = source.indexOf('\n', i)
      const lineEnd = endOfLine < 0 ? source.length : endOfLine
      const line = source.slice(i, lineEnd).replace(/\r$/, '')
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`, 'gm')
        closing.lastIndex = lineEnd + 1
        const match = closing.exec(source)
        i = match ? match.index + match[0].length : source.length
        continue
      }
      const block = /^ {0,3}(\$\$|\\\[)/.exec(line)
      if (/^ {0,3}\\begin/.test(line) && displayEnvironmentStart.test(line.trimStart())) {
        const start = /\\begin\s*\{\s*([a-zA-Z]+\*?)\s*\}/.exec(line)!
        const name = start[1].replace('*', '\\*')
        const closing = new RegExp('\\\\end\\s*\\{\\s*' + name + '\\s*\\}[ \\t]*\\r?$', 'gm')
        closing.lastIndex = i + start.index + start[0].length
        const match = closing.exec(source)
        if (match) {
          const end = match.index + match[0].length
          parts.push(source.slice(plainStart, i), masked(source.slice(i, end)))
          i = end
          plainStart = i
          continue
        }
      }
      if (block) {
        const dollar = block[1] === '$$'
        // Dollar blocks may close on this line only when nothing follows the close delimiter.
        const invalidDollar = dollar && /\$\$\s*\S/.test(line.slice(block[0].length))
        const closing = dollar ? /\$\$[ \t]*\r?$/gm : /\\\][ \t]*\r?$/gm
        closing.lastIndex = i + block[0].length
        const match = closing.exec(source)
        if (!invalidDollar && (match || dollar)) {
          const end = match ? match.index + match[0].length : source.length
          parts.push(source.slice(plainStart, i), masked(source.slice(i, end)))
          i = end
          plainStart = i
          continue
        }
      }
    }
    if (source[i] === '`' && !escaped(i)) {
      let length = 1
      while (source[i + length] === '`') length++
      const ticks = '`'.repeat(length)
      let close = source.indexOf(ticks, i + length)
      while (close >= 0 && (source[close - 1] === '`' || source[close + length] === '`'))
        close = source.indexOf(ticks, close + length)
      i = close < 0 ? i + length : close + length
      continue
    }
    const bracket = source.slice(i, i + 2) === '\\(' && !escaped(i)
    const dollar =
      source[i] === '$' &&
      !escaped(i) &&
      !/[$\w]/.test(source[i - 1] ?? '') &&
      !/\s/.test(source[i + 1] ?? '')
    if (bracket || dollar) {
      const mark = bracket ? '\\)' : '$'
      const start = i + (bracket ? 2 : 1)
      const blank = /\r?\n[ \t]*\r?\n/g
      blank.lastIndex = start
      const limit = blank.exec(source)?.index ?? source.length
      let close = source.indexOf(mark, start)
      while (close >= 0 && close < limit) {
        if (escaped(close)) {
          close = source.indexOf(mark, close + mark.length)
          continue
        }
        if (
          !escaped(close) &&
          (bracket ||
            (!/\s/.test(source[close - 1] ?? '') && !/[$\w]/.test(source[close + 1] ?? '')))
        )
          break
        if (
          dollar &&
          !(
            /\s/.test(source[close - 1] ?? '') &&
            (close + 1 >= source.length || /\s/.test(source[close + 1]))
          )
        ) {
          close = -1
          break
        }
        close = source.indexOf(mark, close + mark.length)
      }
      if (close >= start && close < limit) {
        const end = close + mark.length
        parts.push(source.slice(plainStart, i), masked(source.slice(i, end)))
        i = end
        plainStart = i
        continue
      }
    }
    i++
  }
  parts.push(source.slice(plainStart))
  return {
    source: parts.join(''),
    restore: (text) => Array.from(text, (ch) => decode.get(ch) ?? ch).join('')
  }
}
