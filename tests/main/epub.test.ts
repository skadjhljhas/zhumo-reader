import { it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEpub } from '../../src/main/epub'
import { epubLocation, epubAnchor } from '../../src/shared/epub-types'
import { epubFiles, zipFixture } from '../epub-fixture'
it.each([false, true])(
  'reads spine order, images and nested navigation from EPUB NCX=%s',
  async (ncx) => {
    const root = await mkdtemp(join(tmpdir(), 'zhumo-epub-unit-')),
      path = join(root, '样例.epub')
    await zipFixture(path, epubFiles(ncx))
    const before = await readFile(path),
      book = await readEpub(path)
    expect(book.title).toBe('来自书页的光')
    expect(book.chapters.map((c) => c.href)).toEqual([
      'Book/Text/章一.xhtml',
      'Book/Text/ch2.xhtml',
      'Book/Text/notes.xhtml'
    ])
    expect(book.toc.map((t) => [t.title, t.level])).toEqual([
      ['来自书页的光', 1],
      ['再读一遍', 2]
    ])
    expect(book.resources['Book/Images/light.svg']).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(await readFile(path)).toEqual(before)
  }
)
it('rejects unreadable archives and encrypted prose without modifying the input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-epub-unit-')),
    path = join(root, 'broken.epub')
  await writeFile(path, 'not a ZIP')
  await expect(readEpub(path)).rejects.toThrow()
  const files = epubFiles()
  files['META-INF/encryption.xml'] =
    '<encryption><EncryptedData><EncryptionMethod Algorithm="drm"/><CipherData><CipherReference URI="Book/Text/章一.xhtml"/></CipherData></EncryptedData></encryption>'
  await zipFixture(path, files)
  const before = await readFile(path)
  await expect(readEpub(path)).rejects.toThrow('加密')
  expect(await readFile(path)).toEqual(before)
})
it('normalizes archive links without losing encoded punctuation or allowing external resources', () => {
  expect(epubLocation('Book/Text/章一.xhtml', '../Images/a%23b.svg')).toEqual({
    path: 'Book/Images/a#b.svg',
    hash: ''
  })
  expect(epubLocation('Book/ch.xhtml', 'https://example.com/x')).toBeUndefined()
  expect(epubAnchor('Book/章一.xhtml', '初见')).toMatch(/^epub-[a-f0-9]+$/)
})
