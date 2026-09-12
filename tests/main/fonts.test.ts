import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FontLibrary } from '../../src/main/fonts'
describe('profile font storage', () => {
  it('retains font bytes after the original disappears; repeat imports are deduplicated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhumo-font-test-')),
      original = join(root, '任意字体.otf'),
      profile = join(root, 'profile')
    const bytes = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(100, 7)])
    await writeFile(original, bytes)
    const library = new FontLibrary(profile),
      first = await library.import(original)
    expect((await library.import(original)).font.id).toBe(first.font.id)
    expect(await library.list()).toHaveLength(1)
    await unlink(original)
    expect(Buffer.from(await new FontLibrary(profile).read(first.font.id))).toEqual(bytes)
  })
  it('rejects invalid files and paths; detects corruption and repairs from an explicit reimport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhumo-font-test-')),
      original = join(root, 'source.ttf'),
      profile = join(root, 'profile'),
      library = new FontLibrary(profile)
    await writeFile(original, 'a markdown document is not a font')
    await expect(library.import(original)).rejects.toThrow('不是可识别')
    await expect(library.read('../source.ttf')).rejects.toThrow('无效的字体编号')
    const bytes = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(100, 1)])
    await writeFile(original, bytes)
    const imported = await library.import(original),
      file = join(profile, 'fonts', imported.font.id + '.font')
    await writeFile(file, 'interrupted')
    await expect(library.read(imported.font.id)).rejects.toThrow('损坏')
    await library.import(original)
    expect(Buffer.from(await library.read(imported.font.id))).toEqual(bytes)
    expect(await readFile(original)).toEqual(bytes)
  })
})
