/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const project = fileURLToPath(new URL('..', import.meta.url))
function run(script, args = []) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(project, script), ...args], {
      cwd: project,
      env: { ...process.env, ZHUMO_EXPERIMENTAL_SETUP: '1', ZHUMO_THEME_PREVIEW: 'standard' },
      stdio: 'inherit',
      windowsHide: true,
      shell: false
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 ? done() : reject(Error(script + ' failed: ' + (signal || code)))
    )
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output')
    throw Error('Use npm run build:release -- --output <fresh output directory>')
  if (process.platform !== 'win32')
    throw Error('The managed release installer currently targets Windows.')
  const output = resolve(args[1])
  await mkdir(dirname(output), { recursive: true })
  // Claim a fresh output atomically. Never reuse a directory that may contain manuscripts.
  await mkdir(output)
  await run('node_modules/typescript/bin/tsc', [
    '--noEmit',
    '-p',
    'tsconfig.node.json',
    '--composite',
    'false'
  ])
  await run('node_modules/vue-tsc/bin/vue-tsc.js', [
    '--noEmit',
    '-p',
    'tsconfig.web.json',
    '--composite',
    'false'
  ])
  await run('node_modules/electron-vite/bin/electron-vite.js', ['build'])
  await run('node_modules/electron-builder/out/cli/cli.js', [
    '--dir',
    '--config',
    'electron-builder.release.yml',
    '--config.directories.output=' + output
  ])
  const payload = join(output, 'win-unpacked')
  const manifest = JSON.parse(await readFile(join(payload, 'program-files.v1.json'), 'utf8'))
  if (manifest.appId !== 'com.zhumo.reader.v2' || !/^[0-9A-Za-z.+-]+$/.test(manifest.appVersion))
    throw Error('Unexpected release identity; installer was not created.')
  const work = join(project, 'work/release-builds', randomUUID())
  await mkdir(work, { recursive: true })
  const plan = join(work, 'installer-plan.json')
  await writeFile(
    plan,
    JSON.stringify(
      {
        payload,
        output: join(output, `zhumo-${manifest.appVersion}-win-x64-setup.exe`)
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
  await run('scripts/build-managed-installer.mjs', ['--plan', plan])
  console.log('Release candidate saved: ' + output)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
