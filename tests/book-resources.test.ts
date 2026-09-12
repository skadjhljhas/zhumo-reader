import { expect, it } from 'vitest'
import {
  bookFileUrl,
  bookPathFromUrl,
  headingSlug
} from '../src/renderer/src/composables/bookResources'
it.each([
  ['C:\\文档\\A # 100%.md', 'file:///C:/%E6%96%87%E6%A1%A3/A%20%23%20100%25.md'],
  ['/books/A #.md', 'file:///books/A%20%23.md'],
  ['\\\\server\\share\\book.md', 'file://server/share/book.md']
])('resolves local resources without treating a filename as a URL: %s', (path, expected) => {
  expect(bookFileUrl(path)).toBe(expected)
  expect(bookPathFromUrl(new URL(expected))).toBe(path)
})
it('resolves relative images beside the document and preserves encoded fragment characters', () => {
  const base = bookFileUrl('C:\\books\\文稿.md')!
  expect(new URL('images/a%23b.png', base).href).toBe('file:///C:/books/images/a%23b.png')
  expect(bookFileUrl('zhumo:reader-tour')).toBeUndefined()
  expect(bookPathFromUrl(new URL('https://example.com/book.md'))).toBeUndefined()
  expect(bookPathFromUrl(new URL('file:///C:/%E0%A4.md'))).toBeUndefined()
})
it('builds readable Chinese and Latin heading fragments', () => {
  expect(headingSlug('第二章：世界与思想')).toBe('第二章世界与思想')
  expect(headingSlug('A **New** World!')).toBe('a-new-world')
})
