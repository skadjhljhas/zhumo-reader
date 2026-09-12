import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  rename,
  symlink,
  link
} from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { physicalFs } from '../../src/main/physical-fs'
import { createProgramManifest, programManifestHash } from '../../src/main/program-files'
import {
  publishCurrentVersion,
  restoreCurrentVersion,
  readCurrentVersion,
  resolveCurrentVersion,
  type CurrentVersionPointer
} from '../../src/main/current-version'

const roots: string[] = []
async function install(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zhumo-current-'))
  roots.push(root)
  return root
}
async function release(
  root: string,
  version = '2.0.0'
): Promise<{
  pointer: CurrentVersionPointer
  directory: string
  manifestBytes: string
}> {
  const releaseId = randomUUID()
  const directory = join(root, '.zhumo', 'versions', releaseId)
  await mkdir(join(directory, 'resources'), { recursive: true })
  await writeFile(join(directory, 'ZhuMo.exe'), 'fixture-executable-' + version)
  await writeFile(join(directory, 'resources/app.asar'), 'fixture-package-' + version)
  const manifest = await createProgramManifest(
    directory,
    { appId: 'fixture.zhumo', appVersion: version, executable: 'ZhuMo.exe' },
    ['ZhuMo.exe', 'resources/app.asar']
  )
  const manifestBytes = JSON.stringify(manifest)
  await writeFile(join(directory, 'program-files.v1.json'), manifestBytes)
  return {
    pointer: {
      version: 1,
      releaseId,
      transactionId: randomUUID(),
      manifestSha256: programManifestHash(manifestBytes),
      appId: manifest.appId,
      appVersion: manifest.appVersion,
      executable: manifest.executable
    },
    directory,
    manifestBytes
  }
}
const currentPath = (root: string): string => join(root, '.zhumo', 'current.json')
async function existing(
  root: string
): Promise<Awaited<ReturnType<typeof release>> & { bytes: string }> {
  const old = await release(root)
  const bytes = JSON.stringify(old.pointer, null, 2) + '\r\n'
  await writeFile(currentPath(root), bytes)
  return { ...old, bytes }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const actual = await realpath(root)
    const part = relative(await realpath(tmpdir()), actual)
    expect(part.startsWith('zhumo-current-') && !part.includes('..')).toBe(true)
    await rm(actual, { recursive: true, force: true, maxRetries: 10 })
  }
})

describe('current version disk pointer', () => {
  it('preserves an optional external profile without opening it and rejects invalid profile path syntax', async () => {
    const root = await install()
    const old = await existing(root)
    const profile = join(root, '..', 'zhumo-profile-not-created-' + randomUUID(), '设置')
    const pointer = { ...old.pointer, profile }
    await writeFile(currentPath(root), JSON.stringify(pointer))
    expect((await readCurrentVersion(root))?.pointer.profile).toBe(profile)
    expect((await resolveCurrentVersion(root)).pointer.profile).toBe(profile)
    await expect(readFile(join(profile, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const invalid of [
      null,
      12,
      '',
      'relative/profile',
      parse(root).root,
      root + '\0x',
      root + '\r\nx'
    ]) {
      await writeFile(currentPath(root), JSON.stringify({ ...old.pointer, profile: invalid }))
      await expect(readCurrentVersion(root)).rejects.toThrow()
    }
    await writeFile(currentPath(root), old.bytes)
    expect((await readCurrentVersion(root))?.pointer).toEqual(old.pointer)
  }, 60000)

  it('publishes first install, upgrades and explicitly rolls back while retaining every release and user file', async () => {
    const root = await install()
    expect(await readCurrentVersion(root)).toBeNull()
    await expect(resolveCurrentVersion(root)).rejects.toThrow('不存在')
    const old = await release(root)
    const next = await release(root, '2.1.0')
    const manuscript = Buffer.from('\uFEFF# 用户文稿\r\n\r\n旧版本与新版本都不能改动。\r\n')
    await writeFile(join(root, '文稿.md'), manuscript)
    expect(await readCurrentVersion(root)).toBeNull()
    await publishCurrentVersion(root, old.pointer, null)
    const first = await readCurrentVersion(root)
    expect(first?.pointer).toEqual(old.pointer)
    expect(first?.bytes).toBe(await readFile(currentPath(root), 'utf8'))
    await publishCurrentVersion(root, next.pointer, first!.bytes)
    const upgraded = await resolveCurrentVersion(root)
    expect(upgraded.directory).toBe(await realpath(next.directory))
    expect(upgraded.manifestBytes).toEqual(Buffer.from(next.manifestBytes))
    const rollback = { ...old.pointer, transactionId: randomUUID() }
    await publishCurrentVersion(root, rollback, (await readCurrentVersion(root))!.bytes)
    expect((await resolveCurrentVersion(root)).pointer).toEqual(rollback)
    expect(await readFile(join(old.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.0.0')
    expect(await readFile(join(next.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.1.0')
    expect(await readFile(join(root, '文稿.md'))).toEqual(manuscript)
    expect((await readdir(join(root, '.zhumo'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    )
  }, 120000)

  it('compares original bytes, not equivalent parsed JSON, and never silently overwrites an existing pointer', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    for (const expected of [null, JSON.stringify(old.pointer), old.bytes + '\n']) {
      await expect(publishCurrentVersion(root, next.pointer, expected)).rejects.toThrow('原始指针')
      expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
    }
  }, 60000)

  it('admits only one concurrent publication with the same expected bytes inside one coordinator', async () => {
    const root = await install()
    const old = await existing(root)
    const a = await release(root, '2.1.0')
    const b = await release(root, '2.2.0')
    const outcomes = await Promise.allSettled([
      publishCurrentVersion(root, a.pointer, old.bytes),
      publishCurrentVersion(root, b.pointer, old.bytes)
    ])
    expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await readCurrentVersion(root))?.pointer.releaseId).toBe(a.pointer.releaseId)
    expect(await readFile(join(b.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.2.0')
  }, 60000)

  it('rejects corrupt, ambiguous or extra pointer fields instead of interpreting them as first install', async () => {
    const root = await install()
    const old = await existing(root)
    const invalid: Array<string | Buffer> = [
      '{"version":1,',
      'null',
      '[]',
      JSON.stringify({ ...old.pointer, releaseId: old.pointer.releaseId.toUpperCase() }),
      JSON.stringify({ ...old.pointer, transactionId: '../../escape' }),
      JSON.stringify({ ...old.pointer, manifestSha256: 'A'.repeat(64) }),
      JSON.stringify({ ...old.pointer, appId: ' fixture.zhumo' }),
      JSON.stringify({ ...old.pointer, executable: '../outside.exe' }),
      JSON.stringify({ ...old.pointer, executable: 'resources\\outside.exe' }),
      JSON.stringify({ ...old.pointer, executable: 'NUL.exe' }),
      JSON.stringify({ ...old.pointer, extra: true }),
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d])
    ]
    for (const bytes of invalid) {
      await writeFile(currentPath(root), bytes)
      await expect(readCurrentVersion(root)).rejects.toThrow()
      await expect(publishCurrentVersion(root, old.pointer, null)).rejects.toThrow()
      expect(await readFile(currentPath(root))).toEqual(Buffer.from(bytes))
    }
  }, 120000)

  it('rejects a changed manifest digest or mismatching app identity without switching the old pointer', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    await writeFile(join(next.directory, 'program-files.v1.json'), next.manifestBytes + '\n')
    await expect(publishCurrentVersion(root, next.pointer, old.bytes)).rejects.toThrow('受信校验')
    expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
    await writeFile(join(next.directory, 'program-files.v1.json'), next.manifestBytes)
    await expect(
      publishCurrentVersion(root, { ...next.pointer, appId: 'other.app' }, old.bytes)
    ).rejects.toThrow('身份不一致')
    await writeFile(currentPath(root), JSON.stringify(next.pointer))
    await writeFile(join(next.directory, 'program-files.v1.json'), '{}')
    await expect(resolveCurrentVersion(root)).rejects.toThrow('受信校验')
  }, 60000)

  it('rejects disk roots, linked install ancestors, metadata junctions and linked version targets', async () => {
    const root = await install()
    const old = await existing(root)
    await expect(readCurrentVersion(parse(root).root)).rejects.toThrow('盘根')
    await expect(readCurrentVersion('relative-root')).rejects.toThrow('绝对')
    const alias = join(root, 'alias')
    const holder = await install()
    await symlink(holder, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(holder, 'nested'))
    await expect(readCurrentVersion(join(alias, 'nested'))).rejects.toThrow('链接')
    const actualMetadata = join(root, 'metadata-held')
    await rename(join(root, '.zhumo'), actualMetadata)
    await symlink(
      actualMetadata,
      join(root, '.zhumo'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(readCurrentVersion(root)).rejects.toThrow('链接')
    await physicalFs.unlink(join(root, '.zhumo'))
    await rename(actualMetadata, join(root, '.zhumo'))
    const moved = join(holder, 'release')
    await rename(old.directory, moved)
    await symlink(moved, old.directory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveCurrentVersion(root)).rejects.toThrow('链接')
    expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
  }, 60000)

  it('rejects linked metadata files and executable ancestors, even when the target has a valid manifest', async () => {
    const root = await install()
    const old = await existing(root)
    const copy = join(root, 'pointer-held.json')
    await rename(currentPath(root), copy)
    await link(copy, currentPath(root))
    await expect(readCurrentVersion(root)).rejects.toThrow('链接')
    await physicalFs.unlink(currentPath(root))
    await rename(copy, currentPath(root))
    const manifest = join(old.directory, 'program-files.v1.json')
    await link(manifest, join(root, 'manifest-hardlink.json'))
    await expect(resolveCurrentVersion(root)).rejects.toThrow('链接')
    await physicalFs.unlink(join(root, 'manifest-hardlink.json'))
    const nested = JSON.parse(old.manifestBytes)
    nested.executable = 'bin/ZhuMo.exe'
    nested.files.find((file: { path: string }) => file.path === 'ZhuMo.exe').path = 'bin/ZhuMo.exe'
    const bytes = JSON.stringify(nested)
    await writeFile(manifest, bytes)
    await mkdir(join(root, 'external-bin'))
    await writeFile(join(root, 'external-bin/ZhuMo.exe'), 'external executable')
    await symlink(
      join(root, 'external-bin'),
      join(old.directory, 'bin'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await writeFile(
      currentPath(root),
      JSON.stringify({
        ...old.pointer,
        executable: nested.executable,
        manifestSha256: programManifestHash(bytes)
      })
    )
    await expect(resolveCurrentVersion(root)).rejects.toThrow('链接')
  }, 60000)

  it('leaves the exact old pointer on publish rename failure and removes only its owned temporary', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    const nativeRename = physicalFs.rename.bind(physicalFs)
    const fault = vi.spyOn(physicalFs, 'rename').mockImplementation(async (from, to) => {
      if (to.toString() === currentPath(root))
        throw Object.assign(Error('simulated sharing violation'), { code: 'EPERM' })
      return nativeRename(from, to)
    })
    await expect(publishCurrentVersion(root, next.pointer, old.bytes)).rejects.toThrow(
      'sharing violation'
    )
    fault.mockRestore()
    expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
    expect(
      (await readdir(dirname(currentPath(root)))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
    expect(await readFile(join(next.directory, 'program-files.v1.json'), 'utf8')).toBe(
      next.manifestBytes
    )
    expect((await resolveCurrentVersion(root)).pointer.releaseId).toBe(old.pointer.releaseId)
  }, 60000)

  it('rechecks expected bytes after writing the temporary, keeping a concurrently changed pointer', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    const changed = old.bytes + '\n'
    const nativeOpen = physicalFs.open.bind(physicalFs)
    const fault = vi.spyOn(physicalFs, 'open').mockImplementation(async (file, ...args) => {
      const handle = await nativeOpen(file, ...args)
      if (file.toString().endsWith('.tmp') && args[0] === 'wx')
        await writeFile(currentPath(root), changed)
      return handle
    })
    await expect(publishCurrentVersion(root, next.pointer, old.bytes)).rejects.toThrow(
      '原始指针不匹配'
    )
    fault.mockRestore()
    expect(await readFile(currentPath(root), 'utf8')).toBe(changed)
    expect(
      (await readdir(dirname(currentPath(root)))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
  }, 60000)

  it('does not publish a partial temporary or a file whose fsync failed', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    const nativeOpen = physicalFs.open.bind(physicalFs)
    for (const stage of ['write', 'sync']) {
      const fault = vi.spyOn(physicalFs, 'open').mockImplementation(async (file, ...args) => {
        const handle = await nativeOpen(file, ...args)
        if (file.toString().endsWith('.tmp') && args[0] === 'wx') {
          if (stage === 'write') {
            const write = handle.writeFile.bind(handle)
            vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
              await write('{"version":1,')
              throw Object.assign(Error('simulated disk full'), { code: 'ENOSPC' })
            })
          } else vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('simulated fsync failure'))
        }
        return handle
      })
      await expect(publishCurrentVersion(root, next.pointer, old.bytes)).rejects.toThrow(
        'simulated'
      )
      fault.mockRestore()
      expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
      expect(
        (await readdir(dirname(currentPath(root)))).filter((name) => name.endsWith('.tmp'))
      ).toEqual([])
    }
  }, 60000)
})

describe('journaled current version rollback', () => {
  it('restores real absence after a first publication, archiving its exact pointer and retaining all versions', async () => {
    const root = await install()
    const first = await release(root)
    const unused = await release(root, '2.1.0')
    await publishCurrentVersion(root, first.pointer, null)
    const published = (await readCurrentVersion(root))!.bytes
    await restoreCurrentVersion(root, null, published)
    expect(await readCurrentVersion(root)).toBeNull()
    await expect(resolveCurrentVersion(root)).rejects.toThrow('不存在')
    await expect(readFile(currentPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
    const archives = (await readdir(join(root, '.zhumo'))).filter((name) =>
      name.startsWith('current.aborted.')
    )
    expect(archives).toHaveLength(1)
    expect(archives[0]).toMatch(/^current\.aborted\.[0-9a-f-]{36}\.json$/)
    expect(await readFile(join(root, '.zhumo', archives[0]), 'utf8')).toBe(published)
    expect(await readFile(join(first.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.0.0')
    expect(await readFile(join(unused.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.1.0')
  }, 60000)

  it('restores the previous raw bytes including CRLF and indentation, not reserialized JSON', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    await publishCurrentVersion(root, next.pointer, old.bytes)
    await restoreCurrentVersion(root, old.bytes, (await readCurrentVersion(root))!.bytes)
    expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
    expect((await resolveCurrentVersion(root)).pointer).toEqual(old.pointer)
    expect(await readFile(join(next.directory, 'resources/app.asar'), 'utf8')).toContain('2.1.0')
  }, 60000)

  it('does not change or archive a current pointer when the expected bytes differ', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    await writeFile(currentPath(root), JSON.stringify(next.pointer))
    const current = await readFile(currentPath(root), 'utf8')
    for (const previous of [null, old.bytes]) {
      await expect(restoreCurrentVersion(root, previous, current + '\n')).rejects.toThrow(
        '原始指针不匹配'
      )
      expect(await readFile(currentPath(root), 'utf8')).toBe(current)
    }
    expect(
      (await readdir(join(root, '.zhumo'))).some((name) => name.startsWith('current.aborted.'))
    ).toBe(false)
  }, 60000)

  it('preserves current on either archival or replacement rename failure', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    await writeFile(currentPath(root), JSON.stringify(next.pointer))
    const current = await readFile(currentPath(root), 'utf8')
    const nativeRename = physicalFs.rename.bind(physicalFs)
    const fault = vi.spyOn(physicalFs, 'rename').mockImplementation(async (from, to) => {
      if (from.toString() === currentPath(root) || to.toString() === currentPath(root))
        throw Error('simulated rollback rename failure')
      return nativeRename(from, to)
    })
    for (const previous of [null, old.bytes]) {
      await expect(restoreCurrentVersion(root, previous, current)).rejects.toThrow(
        'rollback rename failure'
      )
      expect(await readFile(currentPath(root), 'utf8')).toBe(current)
    }
    fault.mockRestore()
    expect(
      (await readdir(join(root, '.zhumo'))).filter(
        (name) => name.endsWith('.tmp') || name.startsWith('current.aborted.')
      )
    ).toEqual([])
    expect(await readFile(join(old.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.0.0')
  }, 60000)

  it('refuses to overwrite a colliding archival name', async () => {
    const root = await install()
    const old = await existing(root)
    const nativeLstat = physicalFs.lstat.bind(physicalFs)
    let archive = ''
    const collision = vi.spyOn(physicalFs, 'lstat').mockImplementation(async (file, ...args) => {
      if (!archive && file.toString().includes('current.aborted.')) {
        archive = file.toString()
        await writeFile(archive, 'already existing recovery record')
      }
      return nativeLstat(file, ...args)
    })
    await expect(restoreCurrentVersion(root, null, old.bytes)).rejects.toThrow('名称已存在')
    collision.mockRestore()
    expect(await readFile(currentPath(root), 'utf8')).toBe(old.bytes)
    expect(await readFile(archive, 'utf8')).toBe('already existing recovery record')
  }, 60000)

  it('refuses unsafe previous manifest or linked current rather than restoring an unverified state', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    await writeFile(currentPath(root), JSON.stringify(next.pointer))
    const current = await readFile(currentPath(root), 'utf8')
    await writeFile(join(old.directory, 'program-files.v1.json'), old.manifestBytes + '\n')
    await expect(restoreCurrentVersion(root, old.bytes, current)).rejects.toThrow('受信校验')
    expect(await readFile(currentPath(root), 'utf8')).toBe(current)
    await link(currentPath(root), join(root, 'linked-current.json'))
    await expect(restoreCurrentVersion(root, null, current)).rejects.toThrow('链接')
    expect(await readFile(currentPath(root), 'utf8')).toBe(current)
  }, 60000)

  it('serializes restore with publish rather than allowing both to consume the same current bytes', async () => {
    const root = await install()
    const old = await existing(root)
    const next = await release(root, '2.1.0')
    const outcomes = await Promise.allSettled([
      restoreCurrentVersion(root, null, old.bytes),
      publishCurrentVersion(root, next.pointer, old.bytes)
    ])
    expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await readCurrentVersion(root)).toBeNull()
    expect(await readFile(join(next.directory, 'ZhuMo.exe'), 'utf8')).toContain('2.1.0')
  }, 60000)
})
