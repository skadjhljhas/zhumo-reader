module.exports = async function requireManifestStage(context) {
  if (
    context.electronPlatformName === 'win32' &&
    context.packager.platformSpecificBuildOptions.signAndEditExecutable === false
  ) {
    throw Error(
      'ZhuMo requires the final Windows resource/signing stage for its icon and program-file manifest. Use signExecutable: false to disable signing alone.'
    )
  }
  if (context.electronPlatformName !== 'win32') return
  const { lstat, readFile, writeFile, mkdir } = await import('node:fs/promises')
  const { join, resolve } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { spawn } = await import('node:child_process')
  const existing = await lstat(context.appOutDir).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!existing) return
  if (existing.isSymbolicLink() || !existing.isDirectory())
    throw Error('Existing build output is not a plain directory; it will not be overwritten')
  const receipt = JSON.parse(
    await readFile(join(context.outDir, 'program-files-build-receipt.json'), 'utf8').catch(() => {
      throw Error(
        'Existing output has no verified build receipt; preserve it and choose a new output directory'
      )
    })
  )
  if (receipt.appId !== context.packager.appInfo.id)
    throw Error('Existing build output belongs to a different application')
  const jobs = join(context.outDir, 'build-manifests')
  await mkdir(jobs, { recursive: true })
  const plan = join(jobs, randomUUID() + '.preflight.json')
  await writeFile(
    plan,
    JSON.stringify({ version: 1, stage: context.appOutDir, manifestHash: receipt.manifestHash }),
    { flag: 'wx' }
  )
  await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(__dirname, '../out/main/update-helper.js'), '--audit-build-output', plan],
      { windowsHide: true, stdio: 'inherit' }
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? done()
        : reject(Error('Build output contains retained data or changes; overwrite was stopped'))
    )
  })
}
