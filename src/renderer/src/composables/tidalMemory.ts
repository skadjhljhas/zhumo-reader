import { reactive } from 'vue'
import type { ParsedBook } from '../../../shared/types'
import { searchBlocks, searchTextParts, searchableText } from './searchText'
import { occurrenceContext } from './bookSearch'
import {
  textAddress,
  textDocumentVersion,
  validateTextAddress,
  type TextDocumentVersion
} from './textAddress'
import {
  appendTidalPlace,
  readTidalShelf,
  tidalPlaceKey,
  tidalBookKey,
  type TidalPlace
} from './tidalPlaces'
import type { EchoPlaceDetails } from './tidalPlaces'
import { readTidalArchive, writeTidalArchive } from './tidalArchive'

const STORAGE = 'zhumo.chaosheng.places.v2'
const ENABLED = 'zhumo.chaosheng.places.enabled'
export const tidalMemory = reactive({
  ready: false,
  open: false,
  selected: '',
  places: [] as TidalPlace[],
  enabled: true,
  local: true,
  error: '',
  undo: null as TidalPlace[] | null
})
let epoch = 0,
  activeBook: ParsedBook | null = null,
  activeSource = '',
  activePath = '',
  key = ''
let activeVersion: TextDocumentVersion | undefined
let activationError = ''
function persist(): void {
  if (!key) return
  const book = { key, at: Date.now(), places: [...tidalMemory.places] },
    own = epoch
  void writeTidalArchive(book)
    .then(() => {
      if (epoch === own) tidalMemory.local = true
    })
    .catch(() => {
      if (epoch === own) tidalMemory.local = false
    })
}
export async function activateTidalMemory(
  book: ParsedBook | null,
  path: string,
  source: string
): Promise<void> {
  if (book === activeBook && source === activeSource && path === activePath && tidalMemory.ready)
    return
  const own = ++epoch
  activeBook = null
  activeVersion = undefined
  activationError = ''
  key = ''
  activeSource = source
  activePath = path
  tidalMemory.ready = false
  tidalMemory.open = false
  tidalMemory.places = []
  tidalMemory.undo = null
  tidalMemory.selected = ''
  tidalMemory.error = ''
  try {
    tidalMemory.enabled = localStorage.getItem(ENABLED) !== 'false'
  } catch {
    /* This window remains usable. */
  }
  if (!book || !path) return
  try {
    const version = await textDocumentVersion(path, source)
    if (own !== epoch) return
    activeVersion = version
    key = tidalBookKey(version)
    try {
      const stored = await readTidalArchive(key)
      if (own !== epoch) return
      const legacy = stored
        ? undefined
        : readTidalShelf(localStorage.getItem(STORAGE)).find((item) => item.key === key)
      tidalMemory.places = stored?.places ?? legacy?.places ?? []
      if (legacy) await writeTidalArchive(legacy)
      if (own !== epoch) return
      tidalMemory.local = true
    } catch {
      if (own !== epoch) return
      const stored = readTidalShelf(localStorage.getItem(STORAGE)).find((item) => item.key === key)
      tidalMemory.places = stored?.places ?? []
      tidalMemory.local = false
    }
  } catch {
    if (own !== epoch) return
    key = ''
    tidalMemory.local = false
    activationError = '回声暂时不能记住位置，请重新打开这份文稿后再试。'
    tidalMemory.error = activationError
  }
  if (own !== epoch) return
  activeBook = book
  tidalMemory.ready = true
}
export function releaseTidalMemory(): void {
  epoch++
  activeBook = null
  activeVersion = undefined
  activationError = ''
  activeSource = ''
  activePath = ''
  key = ''
  tidalMemory.ready = false
  tidalMemory.open = false
  tidalMemory.places = []
  tidalMemory.undo = null
}
export function openTidalMemory(place?: TidalPlace): void {
  if (!tidalMemory.ready) return
  tidalMemory.selected = place
    ? tidalPlaceKey(place)
    : tidalMemory.places.at(-1)
      ? tidalPlaceKey(tidalMemory.places.at(-1)!)
      : ''
  tidalMemory.error = activationError
  tidalMemory.open = true
}
export function setTidalRecording(enabled: boolean): void {
  tidalMemory.enabled = enabled
  try {
    localStorage.setItem(ENABLED, String(enabled))
  } catch {
    tidalMemory.local = false
  }
}
export function clearTidalPlaces(): void {
  tidalMemory.undo = [...tidalMemory.places]
  tidalMemory.places = []
  tidalMemory.selected = ''
  persist()
}
export function undoTidalClear(): void {
  if (!tidalMemory.undo) return
  const records = [...tidalMemory.undo, ...tidalMemory.places]
  const restored: TidalPlace[] = []
  for (const place of records) {
    const at = restored.findIndex((item) => tidalPlaceKey(item) === tidalPlaceKey(place))
    if (at >= 0) restored.splice(at, 1)
    restored.push(place)
  }
  tidalMemory.places = restored
  tidalMemory.undo = null
  tidalMemory.selected = restored.length ? tidalPlaceKey(restored.at(-1)!) : ''
  persist()
}
/** Capture a source address from the same projection used by concordance.
 * No DOM node is retained in the stored record.
 */
export function rememberTidalWord(
  range: Range,
  book: ParsedBook,
  source: string,
  echo?: EchoPlaceDetails
): void {
  if (
    !tidalMemory.enabled ||
    !tidalMemory.ready ||
    !activeVersion ||
    activeBook !== book ||
    activeSource !== source ||
    !range.startContainer.isConnected ||
    range.startContainer !== range.endContainer ||
    range.startContainer.nodeType !== Node.TEXT_NODE
  )
    return
  const root = range.startContainer.parentElement?.closest<HTMLElement>(
    '.section-body,.zmu-note-body'
  )
  if (!root) return
  const blocks = searchBlocks(root, true)
  const block = blocks.filter((block) => block.contains(range.startContainer)).at(-1)
  if (!block) return
  let offset = 0,
    found = false
  for (const part of searchTextParts(block, true)) {
    if (part.node === range.startContainer && !part.atomic) {
      offset += range.startOffset
      found = true
      break
    }
    offset += part.text.length
  }
  const word = range.toString()
  if (!found || !word.trim() || word.length > 80) return
  const text = searchableText(block, true)
  if (text.slice(offset, offset + word.length) !== word) return
  let kind: 'section' | 'note', id: string, title: string, index: number, total: number
  if (root.matches('.section-body')) {
    kind = 'section'
    id = root.closest<HTMLElement>('[data-section-id]')?.dataset.sectionId ?? ''
    index = book.sections.findIndex((section) => section.id === id)
    total = book.sections.length
    title = book.sections[index]?.title ?? ''
    for (const heading of root.querySelectorAll('h1,h2,h3')) {
      if (
        heading === block ||
        heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING
      )
        title = searchableText(heading, true)
    }
  } else {
    kind = 'note'
    id = root.closest<HTMLElement>('.note-card')?.dataset.noteId ?? ''
    index = book.notes.findIndex((note) => note.id === id)
    total = book.notes.length
    title = '旁注 ' + (book.notes[index]?.displayMark ?? '')
  }
  if (index < 0 || !id) return
  const blockIndex = blocks.indexOf(block)
  const address = textAddress(
    activeVersion,
    book,
    { kind, id, title, text, blockIndex, position: 0 },
    { start: offset, end: offset + word.length, text: word }
  )
  if (!address) return
  const place: TidalPlace = {
    address,
    title: title.slice(0, 180),
    position: (index + (blockIndex + 0.5) / Math.max(1, blocks.length)) / Math.max(1, total),
    at: Date.now(),
    visits: 1,
    ...(echo ? { echo } : {})
  }
  tidalMemory.places = appendTidalPlace(tidalMemory.places, place)
  persist()
}
/** Display comes from current parser output, verified by the shared address contract. */
export function tidalExcerpt(place: TidalPlace): ReturnType<typeof occurrenceContext> | undefined {
  if (!activeBook || !activeVersion || !tidalMemory.ready) return
  const origin = place.address.origin
  const owner =
    origin.kind === 'section'
      ? activeBook.sections.find((section) => section.id === origin.sectionId)
      : activeBook.notes.find((note) => note.label === origin.label)
  if (!owner) return
  const template = document.createElement('template')
  template.innerHTML = owner.html
  const block = searchBlocks(template.content, true)[place.address.blockIndex]
  if (!block) return
  const text = searchableText(block, true)
  if (validateTextAddress(place.address, activeVersion, text) !== 'valid') return
  return occurrenceContext(text, place.address.match, 72, 110)
}
