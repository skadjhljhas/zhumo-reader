import { writeFile } from 'node:fs/promises'
/** Minimal stored ZIP writer for original test books; never extracts external archives. */
export async function zipFixture(
  path: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  const chunks: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  const crc = (data: Buffer): number => {
    let c = 0xffffffff
    for (const byte of data) {
      c ^= byte
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name),
      data = typeof value === 'string' ? Buffer.from(value) : value,
      sum = crc(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(filename.length, 26)
    chunks.push(local, filename, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, filename)
    offset += local.length + filename.length + data.length
  }
  const tail = Buffer.alloc(22)
  tail.writeUInt32LE(0x06054b50)
  tail.writeUInt16LE(Object.keys(files).length, 8)
  tail.writeUInt16LE(Object.keys(files).length, 10)
  tail.writeUInt32LE(
    central.reduce((sum, b) => sum + b.length, 0),
    12
  )
  tail.writeUInt32LE(offset, 16)
  await writeFile(path, Buffer.concat([...chunks, ...central, tail]))
}
export function epubFiles(ncx = false): Record<string, string | Buffer> {
  return {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'Book/package.opf': `<?xml version="1.0"?><package version="${ncx ? '2.0' : '3.0'}" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>来自书页的光</dc:title><dc:creator>朱墨测试</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="id">original-fixture</dc:identifier></metadata><manifest><item id="c1" href="Text/章一.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/><item id="image" href="Images/light.svg" media-type="image/svg+xml"/><item id="nav" href="${ncx ? 'toc.ncx' : 'nav.xhtml'}" media-type="${ncx ? 'application/x-dtbncx+xml' : 'application/xhtml+xml'}" ${ncx ? '' : 'properties="nav"'}/></manifest><spine toc="nav"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="notes" linear="no"/></spine></package>`,
    'Book/Text/ch2.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="again">再读一遍</h1><p>这是第二章的终点，仍保留着第一章的回声。</p><p><a href="章一.xhtml#first">返回第一章</a></p></body></html>',
    'Book/Text/章一.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><style>body{display:none}</style><script>window.epubInjected=true</script></head><body><h1 id="first">来自书页的光</h1><p>文字先于光抵达。<a epub:type="noteref" href="notes.xhtml#n1">[甲]</a></p><p>同一处注释可以再次被引用。<a epub:type="noteref" href="notes.xhtml#n1">[甲]</a></p><p><ruby>阅读<rt>yuè dú</rt></ruby>仍然清晰。</p><p><img src="../Images/light.svg" alt="光的插图"/></p><p><a href="ch2.xhtml#again">去第二章</a></p></body></html>',
    'Book/Text/notes.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><h1>书后注释</h1><aside id="n1" epub:type="footnote"><p>这是来自 EPUB 的第一条注释。</p></aside></body></html>',
    'Book/Images/light.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140"><defs><linearGradient id="g"><stop stop-color="#b8dce6"/><stop offset="1" stop-color="#d8c8e9"/></linearGradient></defs><rect width="360" height="140" rx="18" fill="url(#g)"/><path d="M30 100Q180 5 330 50" stroke="white" stroke-width="4" fill="none"/></svg>',
    'Book/nav.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="Text/章一.xhtml#first">来自书页的光</a><ol><li><a href="Text/ch2.xhtml#again">再读一遍</a></li></ol></li></ol></nav></body></html>',
    'Book/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>来自书页的光</text></navLabel><content src="Text/章一.xhtml#first"/><navPoint id="n2"><navLabel><text>再读一遍</text></navLabel><content src="Text/ch2.xhtml#again"/></navPoint></navPoint></navMap></ncx>'
  }
}
