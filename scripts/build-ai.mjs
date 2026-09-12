import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Build-time JavaScript.
function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ZHUMO_THEME_PREVIEW: 'standard' },
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(script + ' failed: ' + (signal || code)))
    )
  })
}
try {
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
    'electron-builder.ai.yml'
  ])
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
