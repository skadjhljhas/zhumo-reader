import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateRequestCode } from './request-code'
import { SYNTAX_PROMPT_V2 } from '../../shared/syntax-prompts'
import { SYNTAX_PROMPT_V3 } from '../../shared/syntax-stream-prompt'
import { READING_COLOR_PROMPT_V51 } from '../../shared/reading-colors'
import { DOCUMENT_ANNOTATION_PROMPT } from '../../shared/annotation-prompts'
import {
  SYNTAX_READING_PROMPT_V17,
  SYNTAX_READING_PROMPT_V26,
  SYNTAX_READING_PROMPT
} from '../../shared/syntax-reading-prompt'
import {
  defaultAiProfile,
  aiConfigurationMode,
  aiProfileReady,
  LEGACY_SYNTAX_PROMPT,
  SYNTAX_PROMPT,
  type AiLane,
  type AiProfile,
  type AiProfileInput,
  type AiProfiles
} from '../../shared/ai-types'

export function endpointUrl(value: string, protocol: AiProfile['protocol']): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请填写完整的 API 地址（含 https:// 或本机 http://）。')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('远程 API 使用 HTTPS；本机接口可用 HTTP。请勿把密钥放在地址中。')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1'
  if (!url.pathname.endsWith(protocol === 'anthropic' ? '/messages' : '/chat/completions'))
    url.pathname += protocol === 'anthropic' ? '/messages' : '/chat/completions'
  return url.href
}

export function validateProfile(input: unknown, lane: AiLane): AiProfileInput {
  if (!input || typeof input !== 'object') throw new Error('无效的模型设置。')
  const v = input as AiProfileInput
  if (
    !['chat-completions', 'anthropic'].includes(v.protocol) ||
    typeof v.endpoint !== 'string' ||
    v.endpoint.length > 2048 ||
    typeof v.model !== 'string' ||
    v.model.length > 240 ||
    typeof v.systemPrompt !== 'string' ||
    v.systemPrompt.length > 64000 ||
    !Number.isInteger(v.maxTokens) ||
    (v.maxTokens !== 0 && v.maxTokens < 256) ||
    v.maxTokens > 131072 ||
    (v.thinkingMode !== undefined &&
      !['default', 'enabled', 'disabled', 'adaptive'].includes(v.thinkingMode)) ||
    (v.thinkingBudget !== undefined &&
      (!Number.isInteger(v.thinkingBudget) ||
        v.thinkingBudget < 1024 ||
        v.thinkingBudget > 130048)) ||
    (v.configurationMode !== undefined && !['simple', 'code'].includes(v.configurationMode)) ||
    (v.requestCode !== undefined &&
      (typeof v.requestCode !== 'string' || v.requestCode.length > 64000)) ||
    (v.reasoningEffort !== undefined &&
      !['default', 'low', 'medium', 'high', 'max'].includes(v.reasoningEffort)) ||
    !['max_tokens', 'max_completion_tokens'].includes(v.tokenParameter) ||
    !['default', 'full', 'selection'].includes(v.context) ||
    (v.documentSystemPrompt !== undefined &&
      (typeof v.documentSystemPrompt !== 'string' || v.documentSystemPrompt.length > 64000)) ||
    (v.apiKey !== undefined &&
      (typeof v.apiKey !== 'string' || v.apiKey.length > 8192 || /[\r\n]/.test(v.apiKey)))
  )
    throw new Error('请检查模型设置：提示词最多 64000 字符；输出长度为模型默认或 256–131072。')
  if (aiConfigurationMode(v) === 'code' && !v.requestCode?.trim())
    throw Error('代码模式请填写请求体代码，或切换到简易模式。')
  if (
    aiConfigurationMode(v) === 'simple' &&
    v.thinkingMode === 'adaptive' &&
    v.protocol !== 'anthropic'
  )
    throw Error('自适应思考用于支持它的 Messages 模型。')
  if (
    aiConfigurationMode(v) === 'simple' &&
    v.protocol === 'anthropic' &&
    v.thinkingMode === 'enabled' &&
    v.endpoint.trim() &&
    new URL(endpointUrl(v.endpoint, v.protocol)).hostname !== 'api.deepseek.com' &&
    v.maxTokens !== 0 &&
    (v.thinkingBudget ?? 8192) >= v.maxTokens
  )
    throw Error('手动思考预算必须小于最大输出，为正式结果留出空间。')
  return {
    protocol: v.protocol,
    endpoint: v.endpoint.trim() ? endpointUrl(v.endpoint, v.protocol) : '',
    model: v.model.trim(),
    systemPrompt: v.systemPrompt,
    ...(lane === 'syntax'
      ? { documentSystemPrompt: v.documentSystemPrompt ?? DOCUMENT_ANNOTATION_PROMPT }
      : {}),
    maxTokens: v.maxTokens,
    thinkingMode: v.thinkingMode ?? 'default',
    thinkingBudget: v.thinkingBudget ?? 8192,
    configurationMode: aiConfigurationMode(v),
    reasoningEffort: v.reasoningEffort ?? 'default',
    tokenParameter: v.tokenParameter,
    context: v.context,
    requestCode:
      aiConfigurationMode(v) === 'code'
        ? validateRequestCode(v.requestCode)
        : (v.requestCode ?? ''),
    ...(v.apiKey !== undefined ? { apiKey: v.apiKey.trim() } : {}),
    forgetKey: v.forgetKey === true
  }
}

interface StoredProfile {
  settings: Omit<AiProfile, 'hasKey' | 'keyStorage' | 'revision'> & {
    inactiveRequestCode?: string
    defaultOutput?: boolean
    defaultContext?: boolean
  }
  revision: string
  cipher?: string
}
function storedSettings(settings: StoredProfile['settings']): StoredProfile['settings'] {
  const {
    inactiveRequestCode: _inactive,
    defaultOutput: _output,
    defaultContext: _context,
    ...values
  } = settings
  void _inactive
  void _output
  void _context
  // Keep the old numeric/context fields readable by earlier previews. New readers
  // interpret these flags as omitted provider parameters and untrimmed context.
  const active = {
    ...values,
    ...(values.maxTokens === 0 ? { maxTokens: 32768, defaultOutput: true } : {}),
    ...(values.context === 'default' ? { context: 'full' as const, defaultContext: true } : {})
  }
  if (aiConfigurationMode(settings) === 'simple')
    return {
      ...active,
      requestCode: '',
      ...(settings.requestCode ? { inactiveRequestCode: settings.requestCode } : {})
    }
  return active
}
export interface KeyVault {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}
/** Keys never return to the renderer. Insecure stores retain new keys in memory only. */
export class AiConfigStore {
  private data: Partial<Record<AiLane, StoredProfile>> = {}
  private keys = new Map<AiLane, string>()
  private ready: Promise<void> | undefined
  private snapshot = ''
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private vault: KeyVault
  ) {}
  private load(): Promise<void> {
    this.ready ??= (async () => {
      let text: string
      try {
        text = await readFile(join(this.directory, 'ai-models.v1.json'), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new Error('无法读取模型设置。')
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed.version !== 1) throw new Error()
        for (const lane of ['reading', 'syntax'] as const) {
          if (!parsed[lane]) continue
          const saved = parsed[lane].settings
          if (
            (saved.defaultOutput !== undefined && typeof saved.defaultOutput !== 'boolean') ||
            (saved.defaultContext !== undefined && typeof saved.defaultContext !== 'boolean')
          )
            throw Error()
          if (saved.defaultOutput) saved.maxTokens = 0
          if (saved.defaultContext) saved.context = 'default'
          if (saved.configurationMode === 'simple' && saved.inactiveRequestCode !== undefined) {
            if (
              typeof saved.inactiveRequestCode !== 'string' ||
              saved.inactiveRequestCode.length > 64000
            )
              throw Error()
            saved.requestCode = saved.inactiveRequestCode
          }
          // Once-only migration of the previous shipped default, before the new fields existed.
          // Explicit choices saved by this version (including 8192) remain untouched.
          if (saved.thinkingMode === undefined && saved.maxTokens === 8192) saved.maxTokens = 32768
          if (
            lane === 'syntax' &&
            saved.thinkingMode === undefined &&
            [SYNTAX_PROMPT_V2, LEGACY_SYNTAX_PROMPT].includes(saved.systemPrompt)
          )
            saved.context = 'full'
          const { apiKey: _key, forgetKey: _forget, ...settings } = validateProfile(saved, lane)
          void _key
          void _forget
          const cipher = parsed[lane].cipher
          if (cipher !== undefined && typeof cipher !== 'string') throw new Error()
          const persisted = storedSettings(settings)
          // Loading another lane must not rewrite its pre-flag representation when
          // only this lane is saved. Explicit saves adopt the compatible flags.
          if (saved.maxTokens === 0 && !saved.defaultOutput) {
            persisted.maxTokens = 0
            delete persisted.defaultOutput
          }
          if (saved.context === 'default' && !saved.defaultContext) {
            persisted.context = 'default'
            delete persisted.defaultContext
          }
          this.data[lane] = {
            settings: persisted,
            revision:
              typeof parsed[lane].revision === 'string' ? parsed[lane].revision : randomUUID(),
            ...(cipher ? { cipher } : {})
          }
        }
        this.snapshot = text
      } catch {
        throw new Error('模型设置文件损坏，未覆盖原文件。')
      }
    })()
    return this.ready
  }
  private async refreshDisk(): Promise<void> {
    const content = await readFile(join(this.directory, 'ai-models.v1.json'), 'utf8').catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw Error('无法刷新模型设置。')
      }
    )
    if (content === this.snapshot) return
    const previous = this.data
    this.data = {}
    this.ready = undefined
    try {
      await this.load()
      if (!content) this.snapshot = ''
      for (const lane of ['reading', 'syntax'] as const)
        if (previous[lane]?.revision !== this.data[lane]?.revision) this.keys.delete(lane)
    } catch (error) {
      this.data = previous
      this.ready = undefined
      throw error
    }
  }
  private key(lane: AiLane): string {
    if (this.keys.has(lane)) return this.keys.get(lane)!
    const cipher = this.data[lane]?.cipher
    if (!cipher) return ''
    if (!this.vault.available()) throw new Error('系统密钥保护暂不可用，请重新填写密钥供本次使用。')
    try {
      return this.vault.decrypt(cipher)
    } catch {
      throw new Error('无法解密原密钥，请重新填写。')
    }
  }
  private public(lane: AiLane): AiProfile {
    const item = this.data[lane]
    const stored: Partial<StoredProfile['settings']> = item?.settings ?? {}
    const { inactiveRequestCode, defaultOutput, defaultContext, ...visibleSettings } = stored
    let keyStorage: AiProfile['keyStorage'] = this.keys.has(lane)
      ? 'session'
      : item?.cipher
        ? 'encrypted'
        : 'none'
    if (item?.cipher && !this.keys.has(lane)) {
      try {
        this.key(lane)
      } catch {
        keyStorage = 'unavailable'
      }
    }
    return {
      ...defaultAiProfile(lane),
      ...visibleSettings,
      ...(defaultOutput ? { maxTokens: 0 } : {}),
      ...(defaultContext ? { context: 'default' as const } : {}),
      ...(visibleSettings.configurationMode === 'simple' && inactiveRequestCode !== undefined
        ? { requestCode: inactiveRequestCode }
        : {}),
      ...(lane === 'syntax' &&
      [
        LEGACY_SYNTAX_PROMPT,
        SYNTAX_PROMPT_V2,
        SYNTAX_PROMPT_V3,
        SYNTAX_READING_PROMPT_V17,
        SYNTAX_READING_PROMPT_V26,
        READING_COLOR_PROMPT_V51,
        SYNTAX_READING_PROMPT
      ].includes(item?.settings.systemPrompt ?? '')
        ? { systemPrompt: SYNTAX_PROMPT }
        : {}),
      revision: item?.revision ?? '',
      hasKey: this.keys.has(lane) || Boolean(item?.cipher),
      keyStorage
    }
  }
  async profiles(): Promise<AiProfiles> {
    await this.load()
    await this.queue
    await this.refreshDisk()
    return { reading: this.public('reading'), syntax: this.public('syntax') }
  }
  async credentials(
    lane: AiLane,
    expectedRevision?: string
  ): Promise<{ profile: AiProfile; apiKey: string }> {
    await this.load()
    await this.queue
    await this.refreshDisk()
    const profile = this.public(lane)
    if (expectedRevision !== undefined && expectedRevision !== profile.revision)
      throw new Error('模型配置已在另一处改变。请重新打开模型设置核对后再发送；本次未发送文稿。')
    if (!aiProfileReady(profile))
      throw new Error(
        aiConfigurationMode(profile) === 'code'
          ? '请先保存 API 地址和请求体代码。'
          : '请先填写并保存这套模型的 API 地址和模型名。'
      )
    return { profile, apiKey: this.key(lane) }
  }
  save(lane: AiLane, input: unknown): Promise<AiProfile> {
    const job = this.queue.then(async () => {
      await this.load()
      await this.refreshDisk()
      const shownRevision = (input as Partial<AiProfile>)?.revision
      if (shownRevision && shownRevision !== this.data[lane]?.revision)
        throw Error('模型配置已在另一处更新，请重新打开设置后再保存。')
      const { apiKey, forgetKey, ...settings } = validateProfile(input, lane)
      const previous = this.data[lane]
      const oldEndpoint = previous?.settings.endpoint ?? ''
      const changedOrigin =
        oldEndpoint !== settings.endpoint &&
        (!oldEndpoint ||
          !settings.endpoint ||
          new URL(oldEndpoint).origin !== new URL(settings.endpoint).origin)
      const next: StoredProfile = { settings: storedSettings(settings), revision: randomUUID() }
      let sessionKey = !forgetKey && !changedOrigin ? this.keys.get(lane) : undefined
      if (!forgetKey && !changedOrigin && previous?.cipher) next.cipher = previous.cipher
      if (apiKey) {
        if (this.vault.available()) {
          try {
            next.cipher = this.vault.encrypt(apiKey)
            sessionKey = undefined
          } catch {
            throw new Error('系统未能保护密钥，设置尚未保存。')
          }
        } else {
          delete next.cipher
          sessionKey = apiKey
        }
      }
      const data = { ...this.data, [lane]: next }
      await mkdir(this.directory, { recursive: true })
      const temp = join(this.directory, 'ai-models.v1.json.tmp')
      const serialized = JSON.stringify({ version: 1, ...data }, null, 2)
      await writeFile(temp, serialized, { mode: 0o600 })
      await rename(temp, join(this.directory, 'ai-models.v1.json'))
      this.data = data
      this.snapshot = serialized
      if (sessionKey !== undefined) this.keys.set(lane, sessionKey)
      else this.keys.delete(lane)
      return this.public(lane)
    })
    this.queue = job.catch(() => undefined)
    return job
  }
}
