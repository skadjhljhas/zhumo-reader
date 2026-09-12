/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { UUID } from 'builder-util-runtime'

const project = fileURLToPath(new URL('..', import.meta.url))
function execute(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += String(data)
    })
    child.stderr.on('data', (data) => {
      output += String(data)
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done(output) : reject(Error(output || 'NSIS compilation failed'))
    )
  })
}
async function compiler() {
  if (process.env.ZHUMO_MAKENSIS) return process.env.ZHUMO_MAKENSIS
  const cache = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis-3.0.4.1')
  for (const directory of await readdir(cache)) {
    const file = join(cache, directory, 'Bin/makensis.exe')
    if ((await stat(file).catch(() => undefined))?.isFile()) return file
  }
  throw Error('Set ZHUMO_MAKENSIS to a local NSIS compiler')
}
const literal = (value) => {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw Error('Invalid NSIS literal')
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"')
}

export async function buildManagedInstaller(options) {
  const payload = resolve(options.payload),
    output = resolve(options.output)
  const bytes = await readFile(join(payload, 'program-files.v1.json'))
  const manifest = JSON.parse(bytes),
    hash = createHash('sha256').update(bytes).digest('hex')
  const receipt = JSON.parse(
    await readFile(join(dirname(payload), 'program-files-build-receipt.json'), 'utf8')
  )
  if (receipt.manifestHash !== hash || receipt.appId !== manifest.appId)
    throw Error('Payload does not match its independent build receipt')
  // Full bytes are checked by setup-action again after extraction.
  for (const file of manifest.files) {
    const data = await readFile(join(payload, file.path))
    if (
      data.length !== file.size ||
      createHash('sha256').update(data).digest('hex') !== file.sha256
    )
      throw Error('Payload file changed: ' + file.path)
  }
  const archive = join(payload, 'resources/app.asar')
  if (
    !listPackage(archive).some((path) =>
      path.replaceAll('\\', '/').endsWith('/out/main/setup-action.js')
    )
  )
    throw Error('Build the payload with ZHUMO_EXPERIMENTAL_SETUP=1 before compiling the installer')
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
  const stable = manifest.appId === 'com.zhumo.reader.v2' && pkg.zhumoChannel === 'stable'
  const aiPreview =
    manifest.appId === 'com.zhumo.reader.ai-preview' &&
    (pkg.zhumoChannel === 'preview-ai' ||
      (pkg.zhumoChannel === undefined && pkg.name === 'zhumo-ai-preview'))
  if (!stable && !aiPreview)
    throw Error('The payload product identity is not supported by this installer')
  const guid = UUID.v5(manifest.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
  const values = {
    DISPLAY_NAME: stable ? '朱墨 2.0' : '朱墨 AI 阅读预览',
    OUTPUT_FILE: output,
    REGISTRY_KEY: 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid,
    ICON_FILE: resolve(project, 'build/icon.ico'),
    PAYLOAD_DIR: payload,
    EXECUTABLE_NAME: manifest.executable,
    MANIFEST_HASH: hash,
    APP_ID: manifest.appId,
    APP_NAME: pkg.productName || pkg.name,
    APP_VERSION: manifest.appVersion,
    ...(options.defines ?? {})
  }
  const defaults = {
    DEFAULT_INSTALL: stable
      ? '$LOCALAPPDATA\\Programs\\朱墨 2'
      : '$LOCALAPPDATA\\Programs\\朱墨 AI',
    PROFILE_DIR: stable ? '$APPDATA\\ZhuMo-2.0' : '$APPDATA\\ZhuMo-AI-preview',
    RUNTIME_BASE: '$LOCALAPPDATA\\ZhuMo\\Runtimes',
    WORK_DIR: '$LOCALAPPDATA\\ZhuMo\\UpdateRecords',
    COORDINATOR_DIR: '$APPDATA\\ZhuMo-update-coordination',
    DESKTOP_DIR: '$DESKTOP',
    MENU_DIR: stable ? '$SMPROGRAMS\\朱墨 2.0' : '$SMPROGRAMS\\朱墨 AI'
  }
  values.INSTALLER_MUTEX ??=
    'Local\\ZhuMoSetup-' +
    createHash('sha256').update(values.REGISTRY_KEY.toLowerCase()).digest('hex').slice(0, 32)
  for (const [key, value] of Object.entries(defaults))
    if (!(key in values)) values[key] = { raw: value }
  if (await stat(output).catch(() => undefined)) throw Error('Choose a fresh installer output path')
  await mkdir(dirname(output), { recursive: true })
  const work = join(project, 'work', 'nsis-build-' + randomUUID())
  await mkdir(work, { recursive: true })
  const script = join(work, 'installer.nsi')
  const audit = join(work, 'payload-audit.json')
  await writeFile(audit, JSON.stringify({ version: 1, stage: payload, manifestHash: hash }))
  await execute(process.execPath, [
    join(project, 'out/main/update-helper.js'),
    '--audit-build-output',
    audit
  ])
  const definitions = Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Z_]+$/.test(key)) throw Error('Unknown NSIS definition name')
      const encoded = typeof value === 'object' && value.raw ? value.raw : literal(value)
      return '!define ' + key + ' "' + encoded + '"'
    })
    .join('\n')
  const source =
    '\ufeff' +
    definitions +
    '\n!include "' +
    literal(join(project, 'build/managed-installer.nsi')) +
    '"\n'
  await writeFile(script, source)
  const log = await execute(await compiler(), ['/V3', script])
  await execute(process.execPath, [
    join(project, 'out/main/update-helper.js'),
    '--audit-build-output',
    audit
  ])
  await writeFile(output + '.build.log', log)
  const result = {
    output,
    appId: manifest.appId,
    version: manifest.appVersion,
    manifestHash: hash,
    installerSha256: createHash('sha256')
      .update(await readFile(output))
      .digest('hex')
  }
  await writeFile(output + '.receipt.json', JSON.stringify(result, null, 2))
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--plan')
    throw Error('Use --plan with a local build-options JSON file')
  buildManagedInstaller(JSON.parse(await readFile(resolve(args[1]), 'utf8')))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
