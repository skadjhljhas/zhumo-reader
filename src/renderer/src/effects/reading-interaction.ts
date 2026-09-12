import { noteHoverGuide } from '../composables/noteHoverGuide'

/** A fixed time constant keeps the same response on 60 Hz and faster displays. */
export function dampingFactor(deltaMs: number, timeConstantMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0
  return -Math.expm1(-Math.min(deltaMs, 250) / Math.max(1, timeConstantMs))
}

export function nativePointerTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      'button,a,input,select,textarea,label,.zmu-ref,.zmu-math,[role=button],[contenteditable=true],.studio-toolbar,.studio-rail,.settings-panel,.ai-reading-panel,.ai-settings'
    )
  )
}

/** Reading controls share the theme cursor; native text-entry and modal surfaces keep theirs. */
export function themedNoteTarget(target: EventTarget | null): boolean {
  if (
    !(target instanceof Element) ||
    target.closest(
      'input,select,textarea,[contenteditable=true],dialog,.settings-panel,.ai-reading-panel,.ai-settings,.note-peek'
    )
  )
    return false
  const control = target.closest('button,a,[role=button],.zmu-ref,.zmu-math')
  return Boolean(
    control?.closest(
      '.reader-scroll,.notes-sidebar,.toc-drawer,.studio-toolbar,.studio-rail,.welcome-studio'
    )
  )
}

/** Both endpoints must actually be visible. Prefer the exact hovered occurrence. */
export function readingConnection(noteId: string, preferred: HTMLElement | null): string {
  if (noteHoverGuide.value || document.documentElement.dataset.noteGuidance === 'sidebar') return ''
  if (!noteId) return ''
  const reader = document.querySelector<HTMLElement>('.reader-scroll')
  const notes = document.querySelector<HTMLElement>('.notes-scroll')
  if (!reader || !notes) return ''
  const readerClip = reader.getBoundingClientRect(),
    noteClip = notes.getBoundingClientRect()
  const visible = (element: HTMLElement, clip: DOMRect): DOMRect | null => {
    const rect = element.getBoundingClientRect()
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom <= Math.max(0, clip.top) ||
      rect.top >= Math.min(innerHeight, clip.bottom)
    )
      return null
    const x = (rect.left + rect.right) / 2,
      y = Math.max(
        Math.max(0, clip.top) + 1,
        Math.min((rect.top + rect.bottom) / 2, Math.min(innerHeight, clip.bottom) - 1)
      )
    const top = document.elementFromPoint(x, y)
    return top && (element.contains(top) || top.contains(element)) ? rect : null
  }
  const key = CSS.escape(noteId)
  const card = document.querySelector<HTMLElement>(
    '.notes-scroll .note-card[data-note-id="' + key + '"]'
  )
  if (!card) return ''
  const target = visible(card, noteClip)
  if (!target) return ''
  let origin: DOMRect | null = null
  if (preferred?.isConnected && reader.contains(preferred) && preferred.dataset.noteId === noteId) {
    origin = visible(preferred.querySelector<HTMLElement>('.zmu-ref-mark') ?? preferred, readerClip)
  }
  if (!origin) {
    const band = readerClip.top + readerClip.height * 0.42
    const candidates = [
      ...reader.querySelectorAll<HTMLElement>('.zmu-ref[data-note-id="' + key + '"] .zmu-ref-mark')
    ]
      .map((element) => visible(element, readerClip))
      .filter((rect): rect is DOMRect => Boolean(rect))
    candidates.sort((a, b) => Math.abs(a.top - band) - Math.abs(b.top - band))
    origin = candidates[0] ?? null
  }
  if (!origin) return ''
  const ax = origin.right + 5,
    ay = origin.top + origin.height / 2,
    bx = target.left - 4
  const top = Math.max(0, noteClip.top),
    bottom = Math.min(innerHeight, noteClip.bottom)
  const by = Math.max(top + 12, Math.min(target.top + 28, bottom - 12))
  const bend = Math.max(35, (bx - ax) * 0.48)
  return (
    'M' +
    ax +
    ',' +
    ay +
    ' C' +
    (ax + bend) +
    ',' +
    ay +
    ' ' +
    (bx - bend) +
    ',' +
    by +
    ' ' +
    bx +
    ',' +
    by
  )
}
