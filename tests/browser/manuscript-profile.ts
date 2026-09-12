import { parseBook } from '../../src/renderer/src/parser'
import {
  measureManuscript,
  measureManuscriptAsync
} from '../../src/renderer/src/effects/manuscript/measure'
Object.assign(window, {
  themeProfileTest: { parseBook, measureManuscript, measureManuscriptAsync }
})
