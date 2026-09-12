import { physicalFs as fs } from './physical-fs'
import type { SetupResult } from './setup-action'
import { readSetupFile } from './setup-paths'

type ReceiptHandle = Awaited<ReturnType<typeof fs.open>>
export interface ReceiptIdentity {
  dev: string
  ino: string
}
export function receiptBytes(data: SetupResult, status: string): Buffer {
  return Buffer.from(
    '\ufeff[Install]\r\nStatus=' +
      status +
      '\r\nRoot=' +
      data.root +
      '\r\nProfile=' +
      data.profile +
      '\r\nLauncher=' +
      data.launcher +
      '\r\nTransaction=' +
      data.transaction +
      '\r\nDesktopLink=' +
      (data.desktopLink ?? '') +
      '\r\nMenuLink=' +
      (data.menuLink ?? '') +
      '\r\n',
    'utf16le'
  )
}
export async function verifyReceipt(
  path: string,
  data: SetupResult,
  expected: ReceiptIdentity
): Promise<void> {
  const identity = await fs.lstat(path, { bigint: true })
  if (
    identity.dev.toString() !== expected.dev ||
    identity.ino.toString() !== expected.ino ||
    !(await readSetupFile(path)).equals(receiptBytes(data, 'committed'))
  )
    throw Error('原安装回执已被替换或内容不一致，未将占用文件当作完成结果。')
}
export async function writeReceipt(
  handle: ReceiptHandle,
  path: string,
  data: SetupResult,
  status: string,
  expected?: ReceiptIdentity
): Promise<void> {
  const before = await handle.stat(),
    named = await fs.lstat(path)
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    named.isSymbolicLink() ||
    before.dev !== named.dev ||
    before.ino !== named.ino
  )
    throw Error('安装回执文件在写入前发生改变。')
  if (expected) {
    const identity = await handle.stat({ bigint: true })
    if (identity.dev.toString() !== expected.dev || identity.ino.toString() !== expected.ino)
      throw Error('安装回执文件已被其他文件替代。')
  }
  const bytes = receiptBytes(data, status)
  let at = 0
  while (at < bytes.length) {
    const written = await handle.write(bytes, at, bytes.length - at, at)
    if (!written.bytesWritten) throw Error('安装回执写入中断。')
    at += written.bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
  const readback = Buffer.alloc(bytes.length)
  at = 0
  while (at < readback.length) {
    const read = await handle.read(readback, at, readback.length - at, at)
    if (!read.bytesRead) throw Error('安装回执未能完整读回。')
    at += read.bytesRead
  }
  if (!readback.equals(bytes)) throw Error('安装回执读回不一致。')
}

export async function resumeReceipt(
  path: string,
  data: SetupResult,
  status: string,
  expected: ReceiptIdentity
): Promise<void> {
  const output = await fs.open(path, 'r+')
  try {
    await writeReceipt(output, path, data, status, expected)
  } finally {
    await output.close()
  }
}
