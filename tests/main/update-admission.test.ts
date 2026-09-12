import { it, expect, afterEach } from 'vitest'
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  readFile,
  writeFile,
  readdir,
  chmod,
  unlink
} from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { admitReader, admitUpdate, inspectUpdateAdmission } from '../../src/main/update-admission'
const roots: string[] = []
async function fixture(): Promise<{
  root: string
  profile: string
  program: string
  coord: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-admission-'))
  roots.push(root)
  const profile = join(root, 'profile'),
    program = join(root, 'program')
  await mkdir(program)
  return { root, profile, program, coord: join(root, 'coord') }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-admission-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function rewriteRecord(
  coord: string,
  token: string,
  change: (record: Record<string, unknown>) => void
): Promise<void> {
  const state = join(coord, 'states', token + '.json')
  const record = JSON.parse(await readFile(state, 'utf8'))
  change(record)
  for (const scope of await readdir(coord)) {
    if (scope === 'states') continue
    const claim = join(coord, scope, 'writers', token + '.json')
    try {
      await readFile(claim)
      await writeFile(claim, JSON.stringify(record))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await writeFile(state, JSON.stringify(record))
}

async function expireOwner(coord: string, token: string): Promise<void> {
  // Obtain an actual finished process ID; no fake "probably unused" PID and no GUI.
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    windowsHide: true,
    encoding: 'utf8'
  })
  expect(child.status).toBe(0)
  const pid = Number(child.stdout)
  expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true)
  expect(() => process.kill(pid, 0)).toThrow()
  await rewriteRecord(coord, token, (record) => {
    record.pid = pid
    record.birth = null
  })
}

it('recovers the whole same-transaction chain after two recovery owners crash, retaining every gate until verification completes', async () => {
  const f = await fixture()
  const resources = [f.profile, f.program]
  const original = admitUpdate(resources, f.coord)
  original.markMutating(join(f.root, 'transaction.json'))
  await expireOwner(f.coord, original.token)
  const one = admitUpdate(resources, f.coord, original.token)
  await expireOwner(f.coord, one.token)
  const two = admitUpdate(resources, f.coord, original.token)
  await expireOwner(f.coord, two.token)
  const final = admitUpdate(resources, f.coord, original.token)
  const tokens = [original.token, one.token, two.token, final.token]
  expect(
    inspectUpdateAdmission(resources, f.coord)
      .writers.map((writer) => writer.token)
      .sort()
  ).toEqual(tokens.slice().sort())
  for (const resource of resources) expect(() => admitReader([resource], f.coord)).toThrow()
  await expect(
    final.complete(async () => {
      throw Error('verification has not completed')
    })
  ).rejects.toThrow('verification')
  expect(inspectUpdateAdmission(resources, f.coord).writers).toHaveLength(4)
  await final.complete(async () => {
    const writers = inspectUpdateAdmission(resources, f.coord).writers
    expect(writers).toHaveLength(4)
    expect(writers.every((writer) => writer.phase === 'mutating')).toBe(true)
    for (const resource of resources) expect(() => admitReader([resource], f.coord)).toThrow()
  })
  expect(inspectUpdateAdmission(resources, f.coord).writers).toEqual([])
  for (const token of tokens)
    expect(JSON.parse(await readFile(join(f.coord, 'states', token + '.json'), 'utf8')).phase).toBe(
      'complete'
    )
  expect(() => admitReader(resources, f.coord)).not.toThrow()
})

it('refuses a live recovery owner even when its original token is dead and the transaction matches', async () => {
  const f = await fixture()
  const original = admitUpdate([f.profile, f.program], f.coord)
  original.markMutating(join(f.root, 'transaction.json'))
  await expireOwner(f.coord, original.token)
  const recovery = admitUpdate([f.profile, f.program], f.coord, original.token)
  expect(() => admitUpdate([f.profile, f.program], f.coord, original.token)).toThrow('另一更新')
  expect(inspectUpdateAdmission([f.profile, f.program], f.coord).writers).toHaveLength(2)
  await recovery.complete(async () => {})
})

it('refuses a dead owner belonging to a different canonical transaction', async () => {
  const f = await fixture()
  const original = admitUpdate([f.profile, f.program], f.coord)
  original.markMutating(join(f.root, 'transaction.json'))
  await expireOwner(f.coord, original.token)
  const other = admitUpdate([f.profile, f.program], f.coord, original.token)
  await expireOwner(f.coord, other.token)
  await rewriteRecord(f.coord, other.token, (record) => {
    record.transaction = join(f.root, 'unrelated-transaction.json')
  })
  expect(() => admitUpdate([f.profile, f.program], f.coord, original.token)).toThrow('另一更新')
  expect(inspectUpdateAdmission([f.profile, f.program], f.coord).writers).toHaveLength(2)
  expect(() => admitReader([f.profile], f.coord)).toThrow()
})

it('refuses a dead same-transaction record with a different complete resource scope', async () => {
  const f = await fixture()
  const original = admitUpdate([f.profile, f.program], f.coord)
  original.markMutating(join(f.root, 'transaction.json'))
  await expireOwner(f.coord, original.token)
  const other = admitUpdate([f.profile, f.program], f.coord, original.token)
  await expireOwner(f.coord, other.token)
  const program = await realpath(f.program)
  const pathKey = (path: string): string =>
    process.platform === 'win32' ? path.toLowerCase() : path
  await rewriteRecord(f.coord, other.token, (record) => {
    record.resources = (record.resources as string[]).filter(
      (resource) => pathKey(resource) !== pathKey(program)
    )
  })
  const hash = createHash('sha256').update(pathKey(program)).digest('hex')
  await unlink(join(f.coord, hash, 'writers', other.token + '.json'))
  expect(() => admitUpdate([f.profile, f.program], f.coord, original.token)).toThrow('另一更新')
  expect(inspectUpdateAdmission([f.profile, f.program], f.coord).writers).toHaveLength(2)
})

it('uses the original completed historical token after a crash in chain completion, but never revives a fully completed transaction', async () => {
  const f = await fixture()
  const resources = [f.profile, f.program]
  const original = admitUpdate(resources, f.coord)
  original.markMutating(join(f.root, 'transaction.json'))
  await expireOwner(f.coord, original.token)
  const recovery = admitUpdate(resources, f.coord, original.token)
  const unfinishedState = join(f.coord, 'states', recovery.token + '.json')
  if (process.platform === 'win32') {
    // Windows refuses replacing the readonly final state after the old state was closed.
    await chmod(unfinishedState, 0o444)
    await expect(recovery.complete(async () => {})).rejects.toThrow()
    await chmod(unfinishedState, 0o600)
  } else {
    // POSIX rename can replace a readonly file. Recreate the same durable crash boundary.
    await rewriteRecord(f.coord, original.token, (record) => {
      record.phase = 'complete'
    })
  }
  expect(
    JSON.parse(await readFile(join(f.coord, 'states', original.token + '.json'), 'utf8')).phase
  ).toBe('complete')
  expect(inspectUpdateAdmission(resources, f.coord).writers).toHaveLength(1)
  // A historical dead anchor does not grant entry past its still-live descendant.
  expect(() => admitUpdate(resources, f.coord, original.token)).toThrow('另一更新')
  await expireOwner(f.coord, recovery.token)
  const resumed = admitUpdate(resources, f.coord, original.token)
  expect(inspectUpdateAdmission(resources, f.coord).writers).toHaveLength(2)
  for (const resource of resources) expect(() => admitReader([resource], f.coord)).toThrow()
  await resumed.complete(async () => {})
  expect(inspectUpdateAdmission(resources, f.coord).writers).toEqual([])
  expect(() => admitUpdate(resources, f.coord, original.token)).toThrow('没有可接管')
  expect(inspectUpdateAdmission(resources, f.coord).writers).toEqual([])
})
it('excludes readers and other updates on any shared resource, while unrelated reading is allowed', async () => {
  const f = await fixture(),
    gate = admitUpdate([f.profile, f.program], f.coord)
  expect(() => admitReader([f.profile], f.coord)).toThrow('正在更新')
  expect(() => admitUpdate([f.program], f.coord)).toThrow('另一更新')
  expect(() => admitReader([join(f.root, 'unrelated')], f.coord)).not.toThrow()
  gate.cancel()
  expect(() => admitReader([f.profile], f.coord)).not.toThrow()
  expect(() => admitUpdate([f.profile], f.coord)).toThrow('正常保存并退出')
})
it('does not release mutating state on cancellation or failed verification', async () => {
  const f = await fixture(),
    gate = admitUpdate([f.profile, f.program], f.coord)
  gate.markMutating(join(f.root, 'transaction.json'))
  expect(() => gate.cancel()).toThrow('验证提交或恢复')
  await expect(
    gate.complete(async () => {
      throw Error('not restored')
    })
  ).rejects.toThrow('not restored')
  expect(inspectUpdateAdmission([f.profile], f.coord).writers[0]).toMatchObject({
    token: gate.token,
    phase: 'mutating',
    ownerAlive: true
  })
  expect(() => admitReader([f.profile], f.coord)).toThrow('正在更新')
  expect(() => admitReader([f.program], f.coord)).toThrow('正在更新')
  await gate.complete(async () => {})
  expect(inspectUpdateAdmission([f.profile], f.coord).writers).toEqual([])
})
it('does not unlock any resource when the atomic completion record cannot be published', async () => {
  if (process.platform !== 'win32') return
  const f = await fixture(),
    gate = admitUpdate([f.profile, f.program], f.coord)
  gate.markMutating(join(f.root, 'transaction.json'))
  const state = join(f.coord, 'states', gate.token + '.json')
  await chmod(state, 0o444)
  await expect(gate.complete(async () => {})).rejects.toThrow()
  expect(() => admitReader([f.profile], f.coord)).toThrow('正在更新')
  expect(() => admitReader([f.program], f.coord)).toThrow('正在更新')
  await chmod(state, 0o600)
  await gate.complete(async () => {})
  expect(inspectUpdateAdmission([f.profile, f.program], f.coord).writers).toEqual([])
})
it('treats a reused PID with a different confirmed creation time as an expired preparing owner', async () => {
  const f = await fixture(),
    gate = admitUpdate([f.profile], f.coord)
  const state = join(f.coord, 'states', gate.token + '.json'),
    record = JSON.parse(await readFile(state, 'utf8'))
  const folder = (await readdir(f.coord)).find((name) => name !== 'states')!,
    claim = join(f.coord, folder, 'writers', gate.token + '.json')
  await gate.cancel()
  record.phase = 'preparing'
  record.birth = record.birth ? '100000000000000000' : null
  await writeFile(state, JSON.stringify(record))
  await writeFile(claim, JSON.stringify(record))
  if (record.birth) expect(() => admitReader([f.profile], f.coord)).not.toThrow()
  else expect(() => admitReader([f.profile], f.coord)).toThrow('正在更新')
})
it('refuses overlapping coordination/data directories and recovery of a live owner', async () => {
  const f = await fixture()
  expect(() => admitReader([f.root], f.coord)).toThrow('资料目录之外')
  const gate = admitUpdate([f.profile], f.coord)
  gate.markMutating(join(f.root, 'transaction.json'))
  expect(() => admitUpdate([f.profile], f.coord, gate.token)).toThrow('另一更新')
  await gate.complete(async () => {})
})
