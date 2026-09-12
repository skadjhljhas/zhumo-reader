import type { ParsedBook } from '../../../shared/types'
import type { SearchEntry } from './bookSearch'
import type { SearchMatchLocation } from './searchLanding'

export const TEXT_PROJECTION = 'zhumo-search-text-1' as const
export const TEXT_HASH = 'sha256-utf16le-1' as const
export interface TextDocumentVersion {
  path: string
  digest: string
  length: number
  hash: typeof TEXT_HASH
  projection: typeof TEXT_PROJECTION
}
export interface TextAddress {
  schema: 1
  version: TextDocumentVersion
  origin: { kind: 'section'; sectionId: string } | { kind: 'note'; label: string }
  blockIndex: number
  match: SearchMatchLocation
  prefix: string
  suffix: string
}
export function parseTextAddress(value: unknown): TextAddress | undefined {
  if (!value || typeof value !== 'object') return
  const address = value as Partial<TextAddress>,
    version = address.version,
    origin = address.origin,
    match = address.match
  if (
    address.schema !== 1 ||
    !version ||
    !origin ||
    !match ||
    version.hash !== TEXT_HASH ||
    version.projection !== TEXT_PROJECTION ||
    typeof version.path !== 'string' ||
    !version.path ||
    typeof version.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(version.digest) ||
    !Number.isSafeInteger(version.length) ||
    version.length < 0 ||
    !Number.isSafeInteger(address.blockIndex) ||
    address.blockIndex! < 0 ||
    !Number.isSafeInteger(match.start) ||
    !Number.isSafeInteger(match.end) ||
    match.start < 0 ||
    match.end <= match.start ||
    typeof match.text !== 'string' ||
    match.text.length !== match.end - match.start ||
    typeof address.prefix !== 'string' ||
    address.prefix.length > 48 ||
    typeof address.suffix !== 'string' ||
    address.suffix.length > 48
  )
    return
  if (
    origin.kind === 'section'
      ? typeof origin.sectionId !== 'string' || !origin.sectionId
      : origin.kind !== 'note' || typeof origin.label !== 'string' || !origin.label
  )
    return
  return {
    schema: 1,
    version: { ...version },
    origin: { ...origin },
    blockIndex: address.blockIndex!,
    match: { ...match },
    prefix: address.prefix,
    suffix: address.suffix
  }
}
/** Hash the exact JS text, including BOM, original EOLs and lone surrogates.
 * UTF-16LE is explicit so browser and worker callers produce the same version.
 */
export async function textDocumentVersion(
  path: string,
  source: string
): Promise<TextDocumentVersion> {
  const bytes = new Uint8Array(source.length * 2)
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i)
    bytes[i * 2] = unit & 255
    bytes[i * 2 + 1] = unit >>> 8
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    path,
    length: source.length,
    hash: TEXT_HASH,
    projection: TEXT_PROJECTION,
    digest: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
}
export function sameTextVersion(a: TextDocumentVersion, b: TextDocumentVersion): boolean {
  return (
    a.hash === TEXT_HASH &&
    b.hash === TEXT_HASH &&
    a.projection === TEXT_PROJECTION &&
    b.projection === TEXT_PROJECTION &&
    a.path === b.path &&
    a.length === b.length &&
    a.digest === b.digest
  )
}
function boundary(text: string, offset: number): boolean {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  )
}
export function textAddress(
  version: TextDocumentVersion,
  book: ParsedBook,
  entry: SearchEntry,
  match: SearchMatchLocation
): TextAddress | undefined {
  if (
    !Number.isInteger(entry.blockIndex) ||
    entry.blockIndex < 0 ||
    !Number.isInteger(match.start) ||
    !Number.isInteger(match.end) ||
    match.start < 0 ||
    match.end <= match.start ||
    match.end > entry.text.length ||
    !boundary(entry.text, match.start) ||
    !boundary(entry.text, match.end) ||
    entry.text.slice(match.start, match.end) !== match.text
  )
    return
  const label =
    entry.kind === 'note' ? book.notes.find((note) => note.id === entry.id)?.label : undefined
  if (
    entry.kind === 'note'
      ? label === undefined
      : !book.sections.some((section) => section.id === entry.id)
  )
    return
  return parseTextAddress({
    schema: 1,
    version: { ...version },
    origin:
      entry.kind === 'section'
        ? { kind: 'section', sectionId: entry.id }
        : { kind: 'note', label: label! },
    blockIndex: entry.blockIndex,
    match: { ...match },
    prefix: entry.text.slice(Math.max(0, match.start - 48), match.start),
    suffix: entry.text.slice(match.end, match.end + 48)
  })
}
export function validateTextAddress(
  address: TextAddress,
  current: TextDocumentVersion,
  text: string
): 'valid' | 'version-changed' | 'invalid-address' | 'text-changed' {
  if (!parseTextAddress(address)) return 'invalid-address'
  if (!sameTextVersion(address.version, current)) return 'version-changed'
  const { start, end, text: quote } = address.match
  if (
    !Number.isInteger(address.blockIndex) ||
    address.blockIndex < 0 ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    !boundary(text, start) ||
    !boundary(text, end)
  )
    return 'invalid-address'
  return text.slice(start, end) === quote &&
    text.slice(Math.max(0, start - 48), start) === address.prefix &&
    text.slice(end, end + 48) === address.suffix
    ? 'valid'
    : 'text-changed'
}
