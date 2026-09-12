import { access, mkdir, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

/** Keep portable manuscripts outside app.asar and the portable launcher's temp extraction. */
export async function ensureManuscriptDirectory(
  programDirectory: string,
  documentsDirectory: string
): Promise<string> {
  const preferred = join(programDirectory, '文稿')
  const fallback = join(documentsDirectory, '朱墨', '文稿')
  const alreadyExists = await lstat(preferred)
    .then(() => true)
    .catch((error) => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    })
  for (const directory of [preferred, fallback]) {
    try {
      await mkdir(directory, { recursive: true })
      await access(directory, constants.W_OK)
      return directory
    } catch {
      if (directory === preferred && alreadyExists)
        throw new Error(`原文稿目录暂不可用，未改用其它目录：${preferred}`)
      // Installed applications may live in a directory the reader cannot write.
    }
  }
  throw new Error(`无法创建或写入默认文稿目录：${preferred}；${fallback}`)
}
