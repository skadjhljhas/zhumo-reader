import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  annotationContract,
  effectiveSystemPrompt,
  aiConfigurationMode,
  type AiProfile,
  type AiRequest
} from '../../shared/ai-types'
import type { KeyVault } from './config'
interface Entry {
  key: string
  cipher: string
  at: number
}
export function selectionCacheKey(profile: AiProfile, request: AiRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 3,
        lane: request.lane,
        contract: request.lane === 'syntax' ? annotationContract(request) : undefined,
        annotationMode: request.annotationMode ?? 'follow',
        documentBlocks: request.documentBlocks,
        endpoint: profile.endpoint,
        model: profile.model,
        protocol: profile.protocol,
        prompt: effectiveSystemPrompt(profile, request),
        maxTokens: profile.maxTokens,
        thinkingMode: profile.thinkingMode,
        thinkingBudget: profile.thinkingBudget,
        configurationMode: aiConfigurationMode(profile),
        reasoningEffort: profile.reasoningEffort,
        tokenParameter: profile.tokenParameter,
        requestCode: aiConfigurationMode(profile) === 'code' ? profile.requestCode : undefined,
        context: request.selectionContext ?? request.document,
        instruction: request.instruction,
        text: request.selectedText,
        syntaxTarget: request.syntaxTarget,
        readingAppearance: request.readingAppearance
      })
    )
    .digest('hex')
}
export class AiResultCache {
  private entries: Entry[] = []
  private loaded?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private vault: KeyVault
  ) {}
  private load(): Promise<void> {
    return (this.loaded ??= (async () => {
      try {
        const data = JSON.parse(
          await readFile(join(this.directory, 'selection-explanations.v1.json'), 'utf8')
        )
        if (data.version === 1 && Array.isArray(data.entries))
          this.entries = data.entries
            .filter(
              (e: Entry) =>
                typeof e.key === 'string' &&
                /^[a-f0-9]{64}$/.test(e.key) &&
                typeof e.cipher === 'string' &&
                e.cipher.length < 48 * 1024 * 1024 &&
                Number.isFinite(e.at)
            )
            .slice(-96)
      } catch {
        /* A cache failure does not stop reading. */
      }
    })())
  }
  async get(key: string): Promise<string | undefined> {
    await this.load()
    await this.queue
    const entry = this.entries.find((e) => e.key === key)
    if (!entry || !this.vault.available()) return
    try {
      return this.vault.decrypt(entry.cipher)
    } catch {
      return
    }
  }
  async put(key: string, value: string): Promise<void> {
    if (!value || value.length > 16 * 1024 * 1024 || !this.vault.available()) return
    const job = this.queue.then(async () => {
      await this.load()
      const cipher = this.vault.encrypt(value)
      const entries = [
        ...this.entries.filter((e) => e.key !== key),
        { key, cipher, at: Date.now() }
      ].slice(-96)
      while (entries.reduce((sum, e) => sum + e.cipher.length, 0) > 192 * 1024 * 1024)
        entries.shift()
      await mkdir(this.directory, { recursive: true })
      const tmp = join(this.directory, 'selection-explanations.' + randomUUID() + '.tmp')
      try {
        await writeFile(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
        await rename(tmp, join(this.directory, 'selection-explanations.v1.json'))
        this.entries = entries
      } finally {
        await unlink(tmp).catch(() => undefined)
      }
    })
    this.queue = job.catch(() => undefined)
    await job.catch(() => undefined)
  }
}
