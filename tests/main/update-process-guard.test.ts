import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { assertProgramsClosed } from '../../src/main/update-process-guard'
it('refuses a running program inside the old tree without confusing a sibling path, and rejects unknown ZhuMo process locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-process-guard-'))
  try {
    const old = join(root, '朱墨'),
      sibling = join(root, '朱墨旧')
    await mkdir(old)
    await mkdir(sibling)
    const exe = join(old, 'ZhuMo.exe'),
      other = join(sibling, 'ZhuMo.exe')
    await writeFile(exe, 'fixture')
    await writeFile(other, 'fixture')
    await expect(
      assertProgramsClosed([old], async () => [{ pid: 100, name: 'ZhuMo.exe', executable: exe }])
    ).rejects.toThrow('仍在运行')
    await expect(
      assertProgramsClosed([old], async () => [{ pid: 101, name: 'ZhuMo.exe', executable: other }])
    ).resolves.toBeUndefined()
    await expect(
      assertProgramsClosed([old], async () => [
        { pid: 102, name: 'ZhuMo-AI.exe', executable: null }
      ])
    ).rejects.toThrow('无法读取')
    await expect(
      assertProgramsClosed([old], async () => {
        throw Error('inventory unavailable')
      })
    ).rejects.toThrow('inventory unavailable')
  } finally {
    const rel = relative(await realpath(tmpdir()), await realpath(root))
    expect(rel.startsWith('zhumo-process-guard-') && !rel.includes('..')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
