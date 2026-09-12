// This hook sees the final Windows executable after resource editing, fuse changes and signing.
// Its allowlist comes from trusted build inputs, not from the installation being updated.
module.exports = async function programManifestAfterSign(context) {
  if (context.electronPlatformName !== 'win32') return
  const { readdir, writeFile, readFile, mkdir, open, rename } = await import('node:fs/promises')
  const { join, resolve } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { spawn } = await import('node:child_process')
  const project = resolve(__dirname, '..'),
    runtime = join(project, 'node_modules/electron/dist')
  const executable =
    (context.packager.platformSpecificBuildOptions.executableName ||
      context.packager.appInfo.productFilename) + '.exe'
  const allowed = new Set(['resources/app.asar'])
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Build-time JavaScript helper.
  async function walk(root, directory, collect) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory ? directory + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) throw Error('Trusted build inputs cannot contain links')
      if (entry.isDirectory()) await walk(root, path, collect)
      else if (entry.isFile()) collect(path)
    }
  }
  await walk(runtime, '', (path) => {
    if (path === 'electron.exe') allowed.add(executable)
    else if (path === 'LICENSE') allowed.add('LICENSE.electron.txt')
    else if (!path.startsWith('resources/')) allowed.add(path)
  })
  await walk(join(project, 'resources'), '', (path) =>
    allowed.add('resources/app.asar.unpacked/resources/' + path)
  )
  // Fixed build-generated native entry, not arbitrary files discovered in the output.
  allowed.add('resources/app.asar.unpacked/out/main/native/ConditionalDelete.exe')
  allowed.add('resources/app.asar.unpacked/out/main/native/ProfileChooser.exe')
  const directory = join(context.outDir, 'build-manifests')
  await mkdir(directory, { recursive: true })
  const planPath = join(directory, randomUUID() + '.json')
  await writeFile(
    planPath,
    JSON.stringify({
      version: 1,
      stage: context.appOutDir,
      identity: {
        appId: context.packager.appInfo.id,
        appVersion: context.packager.appInfo.version,
        executable
      },
      allowed: [...allowed].sort()
    }),
    { flag: 'wx' }
  )
  await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [join(project, 'out/main/update-helper.js'), '--build-program-manifest', planPath],
      { windowsHide: true, stdio: 'inherit' }
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error('Program ownership manifest was not completed'))
    )
  })
  const receipt = JSON.parse(await readFile(planPath + '.result.json', 'utf8'))
  // Detached build evidence. A future installer must pin this digest in its trusted payload;
  // the mutable manifest next to an installed executable is not its own trust authority.
  const target = join(context.outDir, 'program-files-build-receipt.json'),
    temp = target + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temp, target)
  console.log(`[zhumo] Program manifest: ${receipt.files} files, sha256=${receipt.manifestHash}`)
}
