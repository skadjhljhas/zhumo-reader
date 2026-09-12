export type BookEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'
export function decodeBookBytes(bytes: Uint8Array): { content: string; encoding: BookEncoding } {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  try {
    return {
      content: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes),
      encoding
    }
  } catch {
    throw new Error(
      '文件不是有效的 UTF-8 或带 BOM 的 UTF-16 文本。请先在原编辑器中另存为 UTF-8，再用朱墨打开。'
    )
  }
}
export function encodeBookText(content: string, encoding: BookEncoding): Buffer {
  const bytes = Buffer.from(content, encoding === 'utf-8' ? 'utf8' : 'utf16le')
  return encoding === 'utf-16be' ? bytes.swap16() : bytes
}
