import { Worker } from 'node:worker_threads'
import { Script } from 'node:vm'

export interface PreparedAiRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
export function validateRequestCode(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 64000) throw Error('请求代码最多 64000 字符。')
  try {
    new Script(`(function(request) { "use strict";\n${value}\n})`)
  } catch (error) {
    const line =
      error instanceof Error ? error.stack?.match(/evalmachine\.<anonymous>:(\d+)/)?.[1] : ''
    throw Error(
      `请求代码有语法错误${line ? `（第 ${Math.max(1, Number(line) - 1)} 行附近）` : ''}，尚未保存。`
    )
  }
  return value
}

// A disposable worker bounds runtime and memory. No host functions/objects or credentials
// are passed into the VM. This is a user-authored request transformer, not a plugin runtime.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { runInNewContext } = require('node:vm');
try {
  const result = runInNewContext(
    'JSON.stringify((function(request) { "use strict";\\n' + workerData.code +
    '\\n})(JSON.parse(input)))',
    { input: workerData.input },
    { timeout: 250, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' }
  );
  if (typeof result !== 'string' || result.length > 20000000) throw Error();
  parentPort.postMessage({ result });
} catch { parentPort.postMessage({ error: true }); }
`

export async function transformAiRequest(
  code: string,
  input: PreparedAiRequest,
  signal: AbortSignal
): Promise<PreparedAiRequest> {
  if (!code.trim()) return input
  if (signal.aborted) throw Error('cancelled')
  const result = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { code, input: JSON.stringify(input) },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    })
    let settled = false
    const finish = (value?: string, message?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      if (message) reject(Error(message))
      else resolve(value!)
    }
    const cancel = (): void => finish(undefined, 'cancelled')
    const timer = setTimeout(() => finish(undefined, '请求代码执行超时，未发送。'), 3000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.once('message', (data) =>
      data.error
        ? finish(undefined, '请求代码执行失败，请检查变量、return 和循环；未发送。')
        : finish(data.result)
    )
    worker.once('error', () => finish(undefined, '请求代码执行失败或超出资源限制，未发送。'))
    worker.once('exit', () => finish(undefined, '请求代码提前退出，未发送。'))
    if (signal.aborted) cancel()
  })
  const parsed = JSON.parse(result)
  // Code mode may return the request body directly. Existing full-request transformers
  // remain valid; credentials and the endpoint stay with the application's prepared request.
  const output =
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    !('url' in parsed) &&
    !('headers' in parsed) &&
    !('body' in parsed)
      ? { ...input, body: parsed }
      : (parsed as PreparedAiRequest)
  if (
    !output ||
    typeof output.url !== 'string' ||
    !output.body ||
    typeof output.body !== 'object' ||
    Array.isArray(output.body) ||
    !output.headers ||
    typeof output.headers !== 'object' ||
    Array.isArray(output.headers)
  )
    throw Error('请求代码应返回请求体对象，或包含 url、headers、body 的完整请求。')
  let url: URL
  try {
    url = new URL(output.url)
  } catch {
    throw Error('请求代码返回的接口地址无效。')
  }
  if (
    url.origin !== new URL(input.url).origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw Error(
      '代码可修改接口路径；更换服务商请修改上方 API 地址并重新填写密钥。地址不含查询参数。'
    )
  if (
    Object.entries(output.headers).some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)
    )
  )
    throw Error('请求代码返回的请求头无效。')
  if (output.body.stream !== true)
    throw Error('请保留 body.stream = true，让解释和句法关系能够逐批抵达。')
  return { url: url.href, headers: output.headers, body: output.body }
}
