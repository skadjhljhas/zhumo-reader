import { isAbsolute, basename } from 'node:path'
import { physicalFs as fs } from './physical-fs'
import { installVersion, recoverVersionUpdate, type VersionUpdatePlan } from './version-update'

/** A separate Node-mode helper owns the admission lifetime, so interrupted updates can be
 * recovered by another process. Plans come from the updater/installer, never from a book. */
export async function runVersionUpdatePlan(path: string, signal?: AbortSignal): Promise<unknown> {
  if (!isAbsolute(path)) throw Error('更新计划需要绝对文件路径。')
  const info = await fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256 * 1024)
    throw Error('更新计划文件无效。')
  const input = JSON.parse(await fs.readFile(path, 'utf8'))
  if (input.version !== 1) throw Error('更新计划版本无效。')
  const progress = (phase: string): void => {
    process.stdout.write(JSON.stringify({ phase }) + '\n')
  }
  if (input.operation === 'install') {
    if (!input.plan || typeof input.manifestFile !== 'string' || !isAbsolute(input.manifestFile))
      throw Error('更新计划缺少受信发行清单。')
    const manifest = await fs.lstat(input.manifestFile)
    if (
      !manifest.isFile() ||
      manifest.isSymbolicLink() ||
      manifest.nlink !== 1 ||
      manifest.size > 64 * 1024 * 1024
    )
      throw Error('发行清单文件无效。')
    const plan: VersionUpdatePlan = {
      ...input.plan,
      manifestBytes: await fs.readFile(input.manifestFile, 'utf8')
    }
    const result = await installVersion(plan, { signal, progress })
    return {
      operation: 'install',
      phase: 'committed',
      transaction: result.transaction,
      directory: result.directory,
      version: result.pointer.appVersion
    }
  }
  if (
    input.operation === 'recover' &&
    ['commit', 'rollback'].includes(input.action) &&
    typeof input.transaction === 'string' &&
    input.expected
  )
    return recoverVersionUpdate(input.transaction, input.expected, input.action, {
      signal,
      progress
    })
  throw Error('更新计划操作无效。')
}
if (process.argv[1] && basename(process.argv[1]) === 'version-update-runner.js') {
  const abort = new AbortController()
  process.on('SIGINT', () => abort.abort())
  void (async () => {
    if (process.argv.length !== 3) throw Error('需要一份明确的本地更新计划。')
    const result = await runVersionUpdatePlan(process.argv[2], abort.signal)
    process.stdout.write(JSON.stringify({ result }) + '\n')
  })().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : '更新未完成。',
        ...(error?.transaction ? { transaction: error.transaction } : {})
      }) + '\n'
    )
    process.exitCode = 1
  })
}
