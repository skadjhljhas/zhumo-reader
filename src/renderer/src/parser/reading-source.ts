import type { Env, Token } from 'markdown-it'
import { preprocess } from './preprocess'
import { protectMathSource } from './protect-math'
import { buildGraph } from './graph'
import { prepareBookRendering } from './render'
import type { SourceLine } from './types'

export interface ReadingSelectionAddress {
  /** Exact plain-text landmark for an imported, read-only publication. */
  projectionFrom?: number
  kind: 'section' | 'note'
  /** Section id or the author's annotation label. */
  id: string
  inline: number
  /** Complete visible inline text; reference badges are omitted, math uses TeX. */
  text: string
  end: number
  boundary?: 'start'
}
export interface ReadingInsertion {
  /** LF-normalized manuscript offset, including a possible BOM. */
  position: number
  start?: number
}

const unavailable = (): Error => new Error('这处选区暂时无法精确对应源文，请在源文中选择插入位置。')

export function readingInlineText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (['text', 'text_special', 'code_inline', 'math_inline'].includes(token.type))
        return token.content
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n'
      return ''
    })
    .join('')
}

/** Ignore only the zero-width probe and text-token fragmentation it causes.
 * Link destinations, formatting, code, formulae and all other blocks must match.
 */
function signature(tokens: Token[]): string {
  function project(tokens: Token[]): unknown[] {
    const result: unknown[][] = []
    for (const token of tokens) {
      if (token.type === 'zmu_selection_probe') continue
      if (token.type === 'text' || token.type === 'text_special') {
        if (!token.content) continue
        const previous = result.at(-1)
        if (previous?.[0] === 'text') previous[1] += token.content
        else result.push(['text', token.content])
      } else {
        result.push([
          token.type,
          token.tag,
          token.nesting,
          token.hidden,
          token.attrs,
          token.type === 'inline' ? project(token.children ?? []) : token.content
        ])
      }
    }
    return result
  }
  return JSON.stringify(project(tokens))
}

/** Resolve by testing a zero-width parser token, never by fuzzy string matching.
 * A candidate is accepted only if the entire Markdown structure is unchanged
 * and the probe appears in the exact requested inline at its exact text offset.
 * Candidate search may decline unsupported syntax; it cannot choose a lookalike.
 */
export function resolveReadingInsertion(
  input: string,
  address: ReadingSelectionAddress,
  levelCap = 4
): ReadingInsertion {
  if (
    !Number.isInteger(address.inline) ||
    address.inline < 0 ||
    !Number.isInteger(address.end) ||
    (address.boundary === 'start' ? address.end < 0 : address.end <= 0) ||
    address.end > address.text.length
  )
    throw unavailable()
  const source = input.replace(/\r\n?/g, '\n')
  if (address.projectionFrom !== undefined) {
    const from = address.projectionFrom
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      source.slice(from, from + address.text.length) !== address.text
    )
      throw unavailable()
    return { position: from + address.end }
  }
  const bom = source.startsWith('\uFEFF') ? 1 : 0
  const protectedMath = protectMathSource(source.slice(bom))
  if (protectedMath.source.length !== source.length - bom) throw unavailable()
  const pre = preprocess(protectedMath.source, { trackContent: true })
  pre.bodyLines = pre.bodyLines.map(protectedMath.restore)
  for (const definition of pre.definitions)
    definition.lines = definition.lines.map(protectedMath.restore)
  const graph = buildGraph(pre, levelCap)
  const { md, chunks } = prepareBookRendering(pre.bodyLines, graph)
  const env: Env = {}
  md.parse(pre.bodyLines.join('\n'), env)
  let lines: string[], maps: SourceLine[]
  if (address.kind === 'section') {
    const index = chunks.findIndex((_chunk, index) => 'sec-' + (index + 1) === address.id)
    if (index < 0) throw unavailable()
    let { start, end } = chunks[index]
    while (start <= end && !pre.bodyLines[start].trim()) start++
    while (end >= start && !pre.bodyLines[end].trim()) end--
    lines = pre.bodyLines.slice(start, end + 1)
    maps = pre.bodySources!.slice(start, end + 1)
  } else {
    // Match the reader's shared reference-link environment in note render order.
    for (const node of graph.nodes) {
      if (node.label === address.id) break
      if (node.hasDef) md.parse(node.contentLines.join('\n'), env)
    }
    const definition = pre.definitions.find((definition) => definition.label === address.id)
    if (!definition) throw unavailable()
    lines = definition.lines
    maps = definition.lineSources!
  }
  const markdown = lines.join('\n')
  const tokens = md.parse(markdown, env)
  const inlines = tokens.filter((token) => token.type === 'inline')
  const inline = inlines[address.inline]
  if (!inline || readingInlineText(inline.children ?? []) !== address.text) throw unavailable()
  const expected = signature(tokens)
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  // Table cells have no map; their inline ordinal still distinguishes repeated
  // cells, so use the containing chunk and verify the identity in every probe.
  const from = inline.map ? starts[inline.map[0]] : 0
  const to = inline.map ? (starts[inline.map[1]] ?? markdown.length + 1) - 1 : markdown.length
  const originalPosition = (position: number): number | undefined => {
    if (address.boundary === 'start') {
      let line = 0
      while (line + 1 < starts.length && starts[line + 1] <= position) line++
      const column = position - starts[line]
      const at = maps[line]?.starts[column] ?? maps[line]?.ends[column - 1]
      return at !== undefined && at >= 0 ? at + bom : undefined
    }
    let low = 0,
      high = starts.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (starts[mid] < position) low = mid + 1
      else high = mid
    }
    const line = low - 1
    const column = position - starts[line] - 1
    const end = maps[line]?.ends[column]
    return end !== undefined && end >= 0 ? end + bom : undefined
  }
  let marker = '@ZMUprobe0@',
    markerIndex = 0
  while (markdown.includes(marker)) marker = '@ZMUprobe' + ++markerIndex + '@'
  md.inline.ruler.before('text', 'zmu_selection_probe', (state, silent) => {
    if (!state.src.startsWith(marker, state.pos)) return false
    if (!silent) state.push('zmu_selection_probe', '', 0)
    state.pos += marker.length
    return true
  })
  const last = address.text[address.end - 1]
  const candidates: number[] = []
  if (address.boundary === 'start' && originalPosition(from) !== undefined) candidates.push(from)
  for (let i = from; i < to; i++) {
    const char = markdown[i]
    if (
      char !== last &&
      !';)>_*~]$'.includes(char) &&
      char.charCodeAt(0) !== 96 &&
      !(address.end === 0 && i - from < 32)
    )
      continue
    // UTF-16 offsets must never bisect an emoji or another surrogate pair.
    if (/[\uD800-\uDBFF]/.test(char) && /[\uDC00-\uDFFF]/.test(markdown[i + 1] ?? '')) continue
    if (originalPosition(i + 1) !== undefined) candidates.push(i + 1)
  }
  const cached = new Map<number, { inline: number; end: number } | null>()
  const started = Date.now()
  const probe = (index: number): { inline: number; end: number } | null => {
    if (cached.has(index)) return cached.get(index)!
    if (cached.size >= 160 || Date.now() - started > 1800) return null
    const position = candidates[index]
    const next = md.parse(markdown.slice(0, position) + marker + markdown.slice(position), {
      ...env,
      references: { ...env.references }
    })
    let found: { inline: number; end: number } | null = null
    let inlineIndex = 0
    for (const token of next) {
      if (token.type !== 'inline') continue
      let length = 0,
        linkDepth = 0
      for (const child of token.children ?? []) {
        if (child.type === 'link_open') linkDepth++
        if (child.type === 'link_close') linkDepth--
        if (child.type === 'zmu_selection_probe' && linkDepth === 0)
          found = { inline: inlineIndex, end: length }
        length += readingInlineText([child]).length
      }
      inlineIndex++
    }
    if (found && signature(next) !== expected) found = null
    cached.set(index, found)
    return found
  }
  const compare = (found: { inline: number; end: number }): number =>
    found.inline - address.inline || found.end - address.end
  let low = 0,
    high = candidates.length - 1
  // Complete code spans and formulae can contain thousands of invalid probe
  // positions. Their outer boundaries remain cheap and trustworthy to test.
  for (const index of new Set([low, high])) {
    if (index < 0 || index >= candidates.length) continue
    const found = probe(index)
    if (!found) continue
    const delta = compare(found)
    if (delta === 0) return { position: originalPosition(candidates[index])! }
    if (delta < 0) low = Math.max(low, index + 1)
    else high = Math.min(high, index - 1)
  }
  while (low <= high && cached.size < 160 && Date.now() - started <= 1800) {
    const middle = (low + high) >>> 1
    let index = middle,
      found = probe(index)
    for (let distance = 1; !found && distance <= 12; distance++) {
      for (const nearby of [middle + distance, middle - distance]) {
        if (nearby < low || nearby > high) continue
        const value = probe(nearby)
        if (value) {
          index = nearby
          found = value
          break
        }
      }
    }
    if (!found) break
    const delta = compare(found)
    if (delta === 0) return { position: originalPosition(candidates[index])! }
    if (delta < 0) low = index + 1
    else high = index - 1
  }
  // A large code span or destination can be an invalid region in the monotone
  // search. Try exact literal suffixes, still subject to the same whole-parse proof.
  const suffix = address.text.slice(Math.max(0, address.end - 24), address.end)
  const nearby = candidates
    .map((position, index) => ({ position, index }))
    .filter(
      ({ position, index }) =>
        index >= low &&
        index <= high &&
        markdown.slice(Math.max(from, position - suffix.length), position) === suffix
    )
  for (const { position, index } of nearby) {
    const found = probe(index)
    if (found && compare(found) === 0) return { position: originalPosition(position)! }
    if (cached.size >= 160 || Date.now() - started > 1800) break
  }
  throw unavailable()
}
