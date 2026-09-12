import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { assertPlainDirectory } from './current-version'

export function setupAbsolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    /[\0\r\n]/.test(value) ||
    value.trim() !== value
  )
    throw Error('安装路径必须是明确的绝对路径。')
  const path = resolve(value),
    root = parse(path).root
  if (path === root) throw Error('不能把整个盘符作为朱墨目录。')
  if (process.platform === 'win32') {
    if (/^\\\\[?.]\\/.test(value)) throw Error('安装目录不能使用设备路径。')
    for (const part of relative(root, path).split(sep))
      if (
        // eslint-disable-next-line no-control-regex -- Reject Windows-forbidden characters including control codes.
        /[<>:"|?*\u0000-\u001f]/.test(part) ||
        /[ .]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
        throw Error('安装路径包含 Windows 不允许或有歧义的名称。')
  }
  return path
}

export function setupContains(parent: string, child: string): boolean {
  const caseKey = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const part = relative(caseKey(parent), caseKey(child))
  return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}

export interface SetupDirectory {
  path: string
  existing: string
  missing: string[]
}
/** Inspect before creating any path; reject an existing linked ancestor before following it. */
export async function inspectSetupDirectory(value: string): Promise<SetupDirectory> {
  const path = setupAbsolute(value),
    missing: string[] = []
  let at = path
  while (true) {
    try {
      await fs.lstat(at)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.unshift(at)
      const parent = dirname(at)
      if (parent === at) throw Error('安装路径没有可用的上级目录。')
      at = parent
    }
  }
  await assertPlainDirectory(at)
  return { path, existing: at, missing }
}

export async function createSetupDirectory(
  plan: SetupDirectory,
  created = new Set<string>()
): Promise<string> {
  // Recheck at execution time, since a path can change after initial inspection.
  const fresh = await inspectSetupDirectory(plan.path)
  if (
    (fresh.existing !== plan.existing && !created.has(fresh.existing)) ||
    fresh.missing.join('\0') !== plan.missing.filter((path) => !created.has(path)).join('\0')
  )
    throw Error('安装目录在检查后改变，请重新执行安装。')
  for (const path of fresh.missing) {
    await assertPlainDirectory(dirname(path))
    await fs.mkdir(path, { mode: 0o700 })
    created.add(path)
  }
  await assertPlainDirectory(plan.path)
  return plan.path
}

export async function readSetupFile(value: string, limit = 65536): Promise<Buffer> {
  const path = setupAbsolute(value)
  await assertPlainDirectory(dirname(path))
  const before = await fs.lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    throw Error('安装计划必须是独立的普通文件。')
  const handle = await fs.open(path, 'r')
  try {
    const opened = await handle.stat()
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1
    )
      throw Error('安装计划在读取时改变。')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length > limit || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size)
      throw Error('安装计划在读取时改变。')
    return bytes
  } finally {
    await handle.close()
  }
}

export const setupResultFile = (source: string): string => join(dirname(source), 'installed.ini')
