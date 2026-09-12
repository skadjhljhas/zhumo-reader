import type { ReadingAppearance } from '../../../shared/reading-colors'
import { hexColor } from '../../../shared/reading-colors'
import { studio } from '../composables/useStudio'

export function readingAppearance(): ReadingAppearance {
  const style = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return hexColor(value) ? value.toLowerCase() : fallback
  }
  return {
    theme: studio.themeId,
    backgroundColor: color('--bg', '#edf3f6'),
    textColor: color('--text', '#25374a')
  }
}
export const readingAppearanceKey = (): string => JSON.stringify(readingAppearance())

/** Observe resolved appearance, including an automatic OS light/dark change. */
export function watchReadingAppearance(changed: (key: string) => void): () => void {
  let previous = readingAppearanceKey()
  const observer = new MutationObserver(() => {
    const next = readingAppearanceKey()
    if (next !== previous) {
      previous = next
      changed(next)
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-skin', 'data-theme']
  })
  return () => observer.disconnect()
}
