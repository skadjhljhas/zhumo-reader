import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env, ZHUMO_THEME_PREVIEW: 'chaosheng' }
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Runs directly as JavaScript in Node.
function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(script + ' failed: ' + (signal || code)))
    })
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
    'electron-builder.chaosheng.yml'
  ])
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
