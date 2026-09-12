import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseBook } from '../src/renderer/src/parser'
it('the writing example has a shared note, a three-level path and no structural warnings', () => {
  const book = parseBook(readFileSync(resolve('docs/annotation-example.md'), 'utf8'))
  expect(book.warnings).toEqual([])
  expect(book.notes).toHaveLength(6)
  expect(book.stats.maxLevel).toBe(3)
  expect(book.notes.find((note) => note.label === '门槛')?.refCount).toBe(2)
  expect(book.notes.find((note) => note.label === '检验')?.parentIds).toHaveLength(1)
})
