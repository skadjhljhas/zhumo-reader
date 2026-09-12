import { shallowRef } from 'vue'
import type { ParsedBook } from '../../../shared/types'

/** Explicit reading gestures may prefill the existing concordance. */
export const readingPhraseRequest = shallowRef<{ book: ParsedBook; query: string } | null>(null)
