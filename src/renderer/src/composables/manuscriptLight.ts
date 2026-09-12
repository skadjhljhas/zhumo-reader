import { computed, onScopeDispose, shallowRef, watch, type ComputedRef } from 'vue'
import { bookState } from './useBook'
import { studio } from './useStudio'
import { measureManuscriptAsync } from '../effects/manuscript/measure'
import { freshLightSeed, type ManuscriptProfile } from '../effects/manuscript/profile'

const encounter = shallowRef(freshLightSeed())
// Loading denotes an actual open. Saving also replaces payload, so payload
// identity must not reseed a manuscript that is still being read and edited.
watch(
  () => bookState.status,
  (status) => {
    if (status === 'loading') encounter.value = freshLightSeed()
  },
  { flush: 'sync' }
)
export function useManuscriptLight(): ComputedRef<{
  profile: ManuscriptProfile | null
  seed: number[]
}> {
  const profile = shallowRef<ManuscriptProfile | null>(null)
  let controller: AbortController | undefined
  let activeEncounter = encounter.value
  watch(
    () => [bookState.book, encounter.value, studio.effectsMode === 'off'] as const,
    async ([book, nextEncounter, off]) => {
      controller?.abort()
      if (activeEncounter !== nextEncounter) profile.value = null
      activeEncounter = nextEncounter
      if (off) {
        controller = undefined
        return
      }
      const active = new AbortController()
      controller = active
      try {
        const value = await measureManuscriptAsync(book, { signal: active.signal })
        if (!active.signal.aborted && bookState.book === book) profile.value = value
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          console.warn('[zhumo] Manuscript light analysis unavailable:', error)
      }
    },
    { immediate: true, flush: 'post' }
  )
  onScopeDispose(() => controller?.abort())
  return computed(() => ({ profile: profile.value, seed: encounter.value }))
}
