/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function buildNativeFileOps(
  output = resolve('out/main/native/ConditionalDelete.exe')
) {
  if (process.platform !== 'win32') return
  const compiler = join(
    process.env.SystemRoot ?? 'C:/Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  )
  await stat(compiler)
  await mkdir(dirname(output), { recursive: true })
  for (const name of ['ConditionalDelete', 'ProfileChooser'])
    await new Promise((done, reject) => {
      const child = spawn(
        compiler,
        [
          '/nologo',
          '/target:winexe',
          '/optimize+',
          '/reference:System.Web.Extensions.dll',
          ...(name === 'ProfileChooser'
            ? ['/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll']
            : []),
          '/out:' + (name === 'ConditionalDelete' ? output : join(dirname(output), name + '.exe')),
          resolve('build/native/' + name + '.cs')
        ],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let log = ''
      child.stdout.on('data', (part) => {
        log += String(part)
      })
      child.stderr.on('data', (part) => {
        log += String(part)
      })
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? done() : reject(Error(log))))
    })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeFileOps().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
