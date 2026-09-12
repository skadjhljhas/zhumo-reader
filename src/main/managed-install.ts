import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { physicalFsSync as fs } from './physical-fs'

/** A launcher-supplied root becomes a lifecycle scope only for a binary physically inside
 * that root's managed release directory. It can never redirect an unrelated reader's library. */
export function managedInstallRoot(executable: string, supplied?: string): string | undefined {
  if (!supplied) return
  if (!isAbsolute(supplied) || /[\0\r\n]/.test(supplied)) throw Error('朱墨安装目录标识无效。')
  const root = fs.realpathSync.native(supplied)
  if (root === parse(root).root || root.toLowerCase() !== resolve(supplied).toLowerCase())
    throw Error('朱墨安装目录不能是盘根或链接别名。')
  const exe = fs.realpathSync.native(executable)
  const part = relative(root, dirname(exe)).split(sep)
  if (
    part.length !== 3 ||
    part[0] !== '.zhumo' ||
    part[1] !== 'versions' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(part[2])
  )
    throw Error('当前程序不属于指定的朱墨安装目录。')
  for (const path of [root, join(root, '.zhumo'), join(root, '.zhumo', 'versions'), dirname(exe)]) {
    const info = fs.lstatSync(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      fs.realpathSync.native(path).toLowerCase() !== path.toLowerCase()
    )
      throw Error('朱墨版本路径含链接或无效目录。')
  }
  return root
}
