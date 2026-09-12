import { physicalFs } from './physical-fs'
const { readFile, open, realpath, stat, lstat, rename, unlink } = physicalFs
import { isAbsolute, relative, sep, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPreservationSnapshot, verifyPreservationSnapshot } from './update-preservation'
import { assertProgramsClosed } from './update-process-guard'
import {
  createProgramManifest,
  programManifestHash,
  readProgramManifest,
  auditProgramFiles
} from './program-files'

interface Plan {
  version: 1
  action: 'capture'
  sources: string[]
  programRoots: string[]
  destination: string
}
const inside = (root: string, file: string): boolean => {
  const p = relative(root.toLowerCase(), file.toLowerCase())
  return !p || (!isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep))
}
async function main(): Promise<void> {
  if (process.argv[2] === '--audit-build-output') {
    const path = process.argv[3]
    if (!path || !isAbsolute(path) || process.argv.length !== 4)
      throw Error('构建覆盖检查需要明确的计划路径。')
    const plan = JSON.parse((await readFile(path)).toString())
    if (
      !plan ||
      plan.version !== 1 ||
      !isAbsolute(plan.stage ?? '') ||
      !/^[a-f0-9]{64}$/.test(plan.manifestHash ?? '')
    )
      throw Error('构建覆盖检查计划无效。')
    const stage = await realpath(plan.stage)
    await assertProgramsClosed([stage])
    const bytes = await readFile(join(stage, 'program-files.v1.json'))
    const audit = await auditProgramFiles(stage, bytes, plan.manifestHash)
    if (
      audit.identity !== 'matched' ||
      audit.changed.length ||
      audit.missing.length ||
      audit.linked.length ||
      audit.protectedDocuments.length ||
      audit.unlisted.some((p) => p !== 'program-files.v1.json')
    )
      throw Error('现有构建目录含改动、文稿或未知内容，未允许覆盖；请保留它并使用新的输出目录。')
    return
  }
  if (process.argv[2] === '--build-program-manifest') {
    const path = process.argv[3]
    if (!path || !isAbsolute(path) || process.argv.length !== 4)
      throw Error('发行清单需要一个独立构建计划。')
    const bytes = await readFile(path)
    if (bytes.length > 4 * 1024 * 1024) throw Error('构建计划过大。')
    const plan = JSON.parse(bytes.toString())
    if (
      !plan ||
      plan.version !== 1 ||
      !isAbsolute(plan.stage ?? '') ||
      !Array.isArray(plan.allowed) ||
      plan.allowed.length > 100000 ||
      typeof plan.identity?.appId !== 'string' ||
      typeof plan.identity?.appVersion !== 'string' ||
      typeof plan.identity?.executable !== 'string'
    )
      throw Error('构建计划无效。')
    const stage = await realpath(plan.stage),
      job = await realpath(path)
    if (inside(stage, job)) throw Error('构建计划与受信校验回执必须留在程序目录之外。')
    const manifest = await createProgramManifest(stage, plan.identity, plan.allowed),
      data = JSON.stringify(manifest, null, 2)
    const target = join(stage, 'program-files.v1.json'),
      temp = target + '.' + randomUUID() + '.tmp'
    const previous = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (previous) {
      if (!previous.isFile() || previous.isSymbolicLink()) throw Error('构建清单路径不是普通文件。')
      const prior = await readFile(target)
      if (readProgramManifest(prior, programManifestHash(prior)).appId !== manifest.appId)
        throw Error('现有清单属于另一应用。')
    }
    const output = await open(temp, 'wx', 0o600)
    try {
      await output.writeFile(data)
      await output.sync()
    } finally {
      await output.close()
    }
    try {
      await rename(temp, target)
    } finally {
      await unlink(temp).catch(() => undefined)
    }
    const report = await open(job + '.result.json', 'wx', 0o600)
    try {
      await report.writeFile(
        JSON.stringify(
          {
            version: 1,
            appId: manifest.appId,
            appVersion: manifest.appVersion,
            manifestHash: programManifestHash(data),
            files: manifest.files.length,
            executable: manifest.executable
          },
          null,
          2
        )
      )
      await report.sync()
    } finally {
      await report.close()
    }
    return
  }
  const [flag, planPath, rootFlag, installRoot, ...extra] = process.argv.slice(2)
  if (
    flag !== '--plan' ||
    !planPath ||
    !isAbsolute(planPath) ||
    rootFlag !== '--installation-root' ||
    !installRoot ||
    !isAbsolute(installRoot) ||
    extra.length
  )
    throw Error('更新帮助程序需要绝对计划路径和本次实际卸载目录。')
  const bytes = await readFile(planPath)
  if (bytes.length > 128 * 1024) throw Error('更新计划过大。')
  const plan = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as Plan
  if (
    !plan ||
    plan.version !== 1 ||
    plan.action !== 'capture' ||
    !Array.isArray(plan.sources) ||
    !plan.sources.length ||
    plan.sources.length > 64 ||
    !Array.isArray(plan.programRoots) ||
    !plan.programRoots.length ||
    typeof plan.destination !== 'string' ||
    !isAbsolute(plan.destination) ||
    [...plan.sources, ...plan.programRoots].some((p) => typeof p !== 'string' || !isAbsolute(p))
  )
    throw Error('更新计划无效。')
  const sources = await Promise.all(plan.sources.map((p) => realpath(p))),
    programs = await Promise.all(plan.programRoots.map((p) => realpath(p)))
  const expected = await realpath(installRoot)
  if (
    !(await stat(expected)).isDirectory() ||
    !programs.some((p) => p.toLowerCase() === expected.toLowerCase()) ||
    (await Promise.all(programs.map((p) => stat(p)))).some((s) => !s.isDirectory())
  )
    throw Error('保存计划与本次实际卸载目录不一致，停止更新。')
  if (programs.some((p) => !sources.some((s) => inside(s, p))))
    throw Error('旧程序目录没有包含在完整保存范围中。')
  const canonicalPlan = await realpath(planPath)
  if (sources.some((s) => inside(s, canonicalPlan)))
    throw Error('更新计划及结果必须在旧程序与配置目录之外。')
  // Reserve the result path before touching any output. A repeated/stale job cannot overwrite it.
  const report = await open(canonicalPlan + '.result.json', 'wx', 0o600)
  let result: Record<string, unknown> = { ok: false, stage: 'preflight' }
  try {
    await assertProgramsClosed(programs)
    result = { ok: false, stage: 'capture' }
    await createPreservationSnapshot(sources, plan.destination, {
      progress: () => assertProgramsClosed(programs)
    })
    await assertProgramsClosed(programs)
    const manifest = await verifyPreservationSnapshot(plan.destination)
    result = {
      ok: true,
      stage: 'captured',
      snapshotId: manifest.id,
      snapshot: await realpath(plan.destination),
      roots: manifest.roots.length,
      files: manifest.roots.reduce(
        (n, r) => n + r.entries.filter((e) => e.kind === 'file').length,
        0
      )
    }
  } catch (error) {
    result = { ...result, error: error instanceof Error ? error.message : '更新保护未完成。' }
    throw error
  } finally {
    try {
      await report.writeFile(JSON.stringify(result, null, 2))
      await report.sync()
    } finally {
      await report.close()
    }
  }
}
void main().catch((error) => {
  // Only operational errors, never profile contents, are emitted by this isolated Node-mode entry.
  process.stderr.write((error instanceof Error ? error.message : '更新保护失败。') + '\n')
  process.exitCode = 1
})
