import { watch } from 'vue'
import { bookState } from './useBook'
import { documentSession } from './documentSession'
import { VisibleReadingClock } from '../effects/lucent/dynamics'

export const readingFieldClock = new VisibleReadingClock()
/** One application-owned clock survives theme component switches; no periodic timers. */
export function installReadingFieldSession(): () => void {
  let previousPath = '',
    previousStatus = 'welcome'
  function sync(): void {
    const now = performance.now(),
      path = documentSession.path,
      status = bookState.status
    if (path !== previousPath || (status === 'loading' && previousStatus === 'welcome'))
      readingFieldClock.reset(now)
    readingFieldClock.setActive(
      now,
      !document.hidden && status === 'reading' && documentSession.mode === 'read'
    )
    previousPath = path
    previousStatus = status
  }
  const stop = watch(() => [documentSession.path, documentSession.mode, bookState.status], sync, {
    immediate: true,
    flush: 'sync'
  })
  document.addEventListener('visibilitychange', sync)
  return () => {
    stop()
    document.removeEventListener('visibilitychange', sync)
    readingFieldClock.setActive(performance.now(), false)
  }
}
