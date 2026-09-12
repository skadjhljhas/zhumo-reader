import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { DOMParser } from '@xmldom/xmldom'
import { basename, extname } from 'node:path'
import { stat } from 'node:fs/promises'
import { epubLocation, type EpubBook, type EpubToc } from '../shared/epub-types'

const MB = 1024 * 1024,
  MAX_TOTAL = 256 * MB
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}
function xml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml') as unknown as Document
}
function decode(bytes: Buffer): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : bytes[0] === 0 && bytes[1] === 60
          ? 'utf-16be'
          : bytes[0] === 60 && bytes[1] === 0
            ? 'utf-16le'
            : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}
const locationHref = (target: { path: string; hash: string }): string =>
  target.path.split('/').map(encodeURIComponent).join('/') +
  (target.hash ? '#' + encodeURIComponent(target.hash) : '')
const named = (root: Document | Element, name: string): Element[] =>
  Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name)
function resolvePath(base: string, href: string): string {
  const location = epubLocation(base, href)
  if (!location || !location.path) throw Error('EPUB资源位置无效：' + href)
  return location.path
}
function navigation(doc: Document, base: string, ncx = false): EpubToc[] {
  if (ncx) {
    return named(doc, 'navPoint').flatMap((point) => {
      const src = named(point, 'content')[0]?.getAttribute('src'),
        label = named(point, 'text')[0]?.textContent?.trim()
      if (!src || !label) return []
      let level = 1,
        parent = point.parentElement
      while (parent) {
        if (parent.localName === 'navPoint') level++
        parent = parent.parentElement
      }
      const target = epubLocation(base, src)
      return target ? [{ title: label, href: locationHref(target), level }] : []
    })
  }
  const nav =
    named(doc, 'nav').find(
      (el) =>
        (el.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc') ||
        el.getAttribute('role') === 'doc-toc'
    ) ?? named(doc, 'nav')[0]
  if (!nav) return []
  return named(nav, 'a').flatMap((link) => {
    const location = epubLocation(base, link.getAttribute('href') ?? '')
    if (!location) return []
    let level = 0,
      parent = link.parentElement
    while (parent && parent !== nav) {
      if (parent.localName === 'ol') level++
      parent = parent.parentElement
    }
    return [
      {
        title: link.textContent?.trim() || '章节',
        href: locationHref(location),
        level: Math.max(1, level)
      }
    ]
  })
}

/** Read EPUB 2/3 in memory. Never extract archive paths into the user's filesystem. */
export async function readEpub(path: string): Promise<EpubBook> {
  if ((await stat(path)).size > 200 * MB) throw Error('EPUB超过200 MB，暂时无法打开。')
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      path,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => (error ? reject(error) : resolve(zip!))
    )
  )
  let fault: Error | undefined,
    consumed = 0
  zip.on('error', (error) => {
    fault = error
  })
  try {
    const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
      const found = new Map<string, Entry>()
      let total = 0
      zip.on('error', reject)
      zip.on('entry', (entry: Entry) => {
        total += entry.uncompressedSize
        if (found.size > 20000 || total > MAX_TOTAL) {
          reject(Error('EPUB展开后的资源过大。'))
          return
        }
        if (found.has(entry.fileName)) {
          reject(Error('EPUB中含重复资源名称。'))
          return
        }
        found.set(entry.fileName, entry)
        zip.readEntry()
      })
      zip.once('end', () => resolve(found))
      zip.readEntry()
    })
    const read = async (name: string, limit = 16 * MB): Promise<Buffer> => {
      if (fault) throw fault
      const entry = entries.get(name)
      if (!entry) throw Error('EPUB缺少资源：' + name)
      if (entry.uncompressedSize > limit) throw Error('EPUB单项资源过大：' + name)
      if (entry.generalPurposeBitFlag & 1) throw Error('此EPUB含加密内容，当前无法读取。')
      return new Promise((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? Error('资源读取失败'))
            return
          }
          const chunks: Buffer[] = []
          let length = 0
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length
            consumed += chunk.length
            if (length > limit || consumed > MAX_TOTAL) {
              stream.destroy(Error('EPUB资源超出读取上限。'))
              return
            }
            chunks.push(chunk)
          })
          stream.on('error', reject)
          stream.on('end', () => resolve(Buffer.concat(chunks)))
        })
      )
    }
    const container = xml(decode(await read('META-INF/container.xml', MB)))
    const root =
      named(container, 'rootfile').find(
        (e) => e.getAttribute('media-type') === 'application/oebps-package+xml'
      ) ?? named(container, 'rootfile')[0]
    if (!root?.getAttribute('full-path')) throw Error('EPUB没有有效的内容清单。')
    const packagePath = resolvePath('', root.getAttribute('full-path')!)
    const packageDoc = xml(decode(await read(packagePath, 4 * MB)))
    const title =
      named(packageDoc, 'title')[0]?.textContent?.trim() || basename(path, extname(path))
    const book: EpubBook = {
      title,
      author: named(packageDoc, 'creator')[0]?.textContent?.trim() ?? '',
      language: named(packageDoc, 'language')[0]?.textContent?.trim() ?? '',
      chapters: [],
      toc: [],
      resources: {},
      warnings: []
    }
    const manifest = new Map(
      named(packageDoc, 'item')
        .filter((item) => {
          if (epubLocation(packagePath, item.getAttribute('href') ?? '')) return true
          book.warnings.push('外部资源未加载：' + (item.getAttribute('href') ?? ''))
          return false
        })
        .map((item) => [
          item.getAttribute('id')!,
          {
            href: resolvePath(packagePath, item.getAttribute('href') ?? ''),
            type: item.getAttribute('media-type') ?? '',
            properties: item.getAttribute('properties') ?? '',
            fallback: item.getAttribute('fallback')
          }
        ])
    )
    const encrypted = new Set<string>()
    if (entries.has('META-INF/encryption.xml')) {
      const encryption = xml(decode(await read('META-INF/encryption.xml', 4 * MB)))
      for (const item of named(encryption, 'EncryptedData')) {
        const algorithm = named(item, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? ''
        if (
          ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(
            algorithm
          )
        )
          continue
        const uri = named(item, 'CipherReference')[0]?.getAttribute('URI')
        if (uri) encrypted.add(resolvePath('', uri))
      }
    }
    for (const ref of named(packageDoc, 'itemref')) {
      let item = manifest.get(ref.getAttribute('idref') ?? '')
      const seen = new Set<string>()
      while (
        item &&
        !['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(item.type) &&
        item.fallback &&
        !seen.has(item.fallback)
      ) {
        seen.add(item.fallback)
        item = manifest.get(item.fallback)
      }
      if (!item) {
        book.warnings.push('一个章节未找到对应资源。')
        continue
      }
      if (encrypted.has(item.href)) throw Error('此EPUB正文受到加密保护，当前无法读取。')
      if (!['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(item.type)) {
        book.warnings.push('暂不支持的章节资源：' + item.href)
        continue
      }
      const html = decode(await read(item.href))
      book.chapters.push({
        href: item.href,
        title: '',
        html,
        linear: ref.getAttribute('linear') !== 'no'
      })
    }
    const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
    const ncx = [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')
    const navigationItem = nav ?? ncx
    if (navigationItem) {
      try {
        book.toc = navigation(
          xml(decode(await read(navigationItem.href, 4 * MB))),
          navigationItem.href,
          !nav
        )
      } catch {
        book.warnings.push('目录未能读取，已使用章节顺序。')
      }
    }
    for (const chapter of book.chapters)
      chapter.title =
        book.toc.find((item) => epubLocation('', item.href)?.path === chapter.href)?.title ?? ''
    for (const item of manifest.values()) {
      const type = Object.values(imageTypes).includes(item.type)
        ? item.type
        : imageTypes[extname(item.href).toLowerCase()]
      if (!type || encrypted.has(item.href)) continue
      try {
        const bytes = await read(item.href, 48 * MB)
        book.resources[item.href] = 'data:' + type + ';base64,' + bytes.toString('base64')
      } catch {
        book.warnings.push('一张插图未能读取：' + item.href)
      }
    }
    if (!book.chapters.length) throw Error('此EPUB没有可读取的章节。')
    return book
  } finally {
    zip.close()
  }
}
