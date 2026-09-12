import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  AiConfigStore,
  endpointUrl,
  validateProfile,
  type KeyVault
} from '../../src/main/ai/config'
import {
  SYNTAX_READING_PROMPT_V17,
  SYNTAX_READING_PROMPT_V26
} from '../../src/shared/syntax-reading-prompt'
import {
  defaultAiProfile,
  LEGACY_SYNTAX_PROMPT,
  SYNTAX_PROMPT,
  type AiProfileInput
} from '../../src/shared/ai-types'
const roots: string[] = []
const secret = randomBytes(32)
const vault: KeyVault = {
  available: () => true,
  encrypt(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, iv)
    const bytes = Buffer.concat([cipher.update(value), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64')
  },
  decrypt(value) {
    const bytes = Buffer.from(value, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()
  }
}
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zhumo-ai-config-'))
  roots.push(path)
  return path
}
it('preserves keys and model-default choices across restart using legacy-readable stored fields', async () => {
  const directory = await root(),
    store = new AiConfigStore(directory, vault)
  const saved = await store.save('syntax', {
    ...defaultAiProfile('syntax'),
    endpoint: 'https://example.test/v1',
    model: 'model',
    apiKey: 'fixed-fixture-key'
  })
  expect(saved.maxTokens).toBe(0)
  expect(saved.context).toBe('default')
  const file = join(directory, 'ai-models.v1.json')
  const original = JSON.parse(await readFile(file, 'utf8'))
  expect(original.syntax.settings).toMatchObject({
    maxTokens: 32768,
    context: 'full',
    defaultOutput: true,
    defaultContext: true
  })
  const restarted = new AiConfigStore(directory, vault)
  const restored = (await restarted.profiles()).syntax
  expect(restored.maxTokens).toBe(0)
  expect(restored.context).toBe('default')
  expect((await restarted.credentials('syntax')).apiKey).toBe('fixed-fixture-key')
  await restarted.save('syntax', { ...restored, maxTokens: 65536, context: 'selection' })
  const changed = JSON.parse(await readFile(file, 'utf8'))
  expect(changed.syntax.cipher).toBe(original.syntax.cipher)
  expect(changed.syntax.settings).not.toHaveProperty('defaultOutput')
  expect(changed.syntax.settings).not.toHaveProperty('defaultContext')
})
const profile = (): AiProfileInput => ({
  ...defaultAiProfile('reading'),
  model: 'test-model',
  endpoint: 'https://example.test/v1',
  apiKey: 'not-a-real-key-secret'
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
describe('independent protected AI settings', () => {
  it('retains legacy request code in code mode while dropping the old Qwen budget switch', async () => {
    const path = await root(),
      cipher = vault.encrypt('fixture-old-key')
    const { configurationMode: _mode, ...legacy } = defaultAiProfile('syntax')
    void _mode
    const code = 'request.body.temperature = 0.4; return request;'
    const raw = JSON.stringify({
      version: 1,
      syntax: {
        revision: 'old-code',
        cipher,
        settings: {
          ...legacy,
          model: 'qwen3.8-flash',
          endpoint: 'https://example.test/v1',
          requestCode: code,
          limitThinking: true,
          thinkingBudget: 2048
        }
      }
    })
    await writeFile(join(path, 'ai-models.v1.json'), raw)
    const store = new AiConfigStore(path, vault),
      profiles = await store.profiles()
    expect(profiles.syntax.configurationMode).toBe('code')
    expect(profiles.syntax.requestCode).toBe(code)
    expect(profiles.syntax).not.toHaveProperty('limitThinking')
    expect((await store.credentials('syntax')).apiKey).toBe('fixture-old-key')
    expect(await readFile(join(path, 'ai-models.v1.json'), 'utf8')).toBe(raw)
  })
  it('preserves inactive code without executing or compiling it, and requires valid code when that mode is saved', async () => {
    const path = await root(),
      store = new AiConfigStore(path, vault)
    const simple = await store.save('reading', {
      ...profile(),
      configurationMode: 'simple',
      requestCode: 'return {'
    })
    expect(simple.configurationMode).toBe('simple')
    expect((await store.profiles()).reading.requestCode).toBe('return {')
    const serialized = JSON.parse(await readFile(join(path, 'ai-models.v1.json'), 'utf8'))
    expect(serialized.reading.settings.requestCode).toBe('')
    expect(serialized.reading.settings.inactiveRequestCode).toBe('return {')
    expect((await new AiConfigStore(path, vault).profiles()).reading.requestCode).toBe('return {')
    await expect(store.save('reading', { ...simple, configurationMode: 'code' })).rejects.toThrow(
      '语法错误'
    )
    await expect(
      store.save('reading', { ...simple, configurationMode: 'code', requestCode: '' })
    ).rejects.toThrow('填写请求体代码')
    expect((await store.credentials('reading')).apiKey).toBe('not-a-real-key-secret')
    expect((await store.profiles()).reading.configurationMode).toBe('simple')
  })
  it('allows a code-defined model without a model name in the simple form', async () => {
    const store = new AiConfigStore(await root(), vault)
    await store.save('syntax', {
      ...profile(),
      model: '',
      configurationMode: 'code',
      requestCode: 'return {model:"code-model",messages:request.body.messages,stream:true};'
    })
    expect((await store.credentials('syntax')).profile.configurationMode).toBe('code')
  })
  it('refreshes externally saved profiles and refuses to overwrite a stale revision', async () => {
    const directory = await root(),
      first = new AiConfigStore(directory, vault),
      second = new AiConfigStore(directory, vault)
    const old = await first.save('syntax', profile())
    await second.profiles()
    await second.save('syntax', { ...profile(), model: 'qwen3.8-flash', apiKey: '' })
    expect((await first.profiles()).syntax.model).toBe('qwen3.8-flash')
    await expect(first.save('syntax', { ...old, model: 'stale-overwrite' })).rejects.toThrow(
      '另一处更新'
    )
    expect((await first.credentials('syntax')).apiKey).toBe('not-a-real-key-secret')
  })
  it('migrates the old 8192 default to 32k without replacing ciphertext, then preserves an explicit new limit', async () => {
    const path = await root(),
      cipher = vault.encrypt('fixture-key')
    const {
      thinkingMode: _mode,
      reasoningEffort: _effort,
      thinkingBudget: _budget,
      ...old
    } = profile()
    void _mode
    void _effort
    void _budget
    await writeFile(
      join(path, 'ai-models.v1.json'),
      JSON.stringify({
        version: 1,
        reading: { settings: { ...old, maxTokens: 8192 }, revision: 'old', cipher }
      })
    )
    const store = new AiConfigStore(path, vault)
    expect((await store.profiles()).reading.maxTokens).toBe(32768)
    expect((await store.credentials('reading')).apiKey).toBe('fixture-key')
    await store.save('reading', { ...(await store.profiles()).reading, maxTokens: 8192 })
    expect((await new AiConfigStore(path, vault).profiles()).reading.maxTokens).toBe(8192)
    expect(JSON.parse(await readFile(join(path, 'ai-models.v1.json'), 'utf8')).reading.cipher).toBe(
      cipher
    )
  })
  it('upgrades only the exact old built-in syntax prompt while preserving custom prompts and keys', async () => {
    const directory = await root(),
      store = new AiConfigStore(directory, vault)
    await store.save('syntax', { ...profile(), systemPrompt: LEGACY_SYNTAX_PROMPT })
    expect((await store.profiles()).syntax.systemPrompt).toBe(SYNTAX_PROMPT)
    expect((await store.credentials('syntax')).apiKey).toBe('not-a-real-key-secret')
    await store.save('syntax', {
      ...profile(),
      systemPrompt: SYNTAX_READING_PROMPT_V17,
      apiKey: ''
    })
    const restarted = new AiConfigStore(directory, vault)
    expect((await restarted.profiles()).syntax.systemPrompt).toBe(SYNTAX_PROMPT)
    expect((await restarted.credentials('syntax')).apiKey).toBe('not-a-real-key-secret')
    await store.save('syntax', { ...profile(), systemPrompt: '用户自己的分析取向', apiKey: '' })
    expect((await store.profiles()).syntax.systemPrompt).toBe('用户自己的分析取向')
    expect((await store.credentials('syntax')).apiKey).toBe('not-a-real-key-secret')
  })
  it('retains the exact shipped candidate 21–26 prompt as a migration identity', () => {
    expect(createHash('sha256').update(SYNTAX_READING_PROMPT_V26, 'utf8').digest('hex')).toBe(
      'dbdcb46717ee093ab59ca703f66e012fb63a2e26adffcf3080c6c07f28de141a'
    )
    expect(SYNTAX_PROMPT.startsWith(SYNTAX_READING_PROMPT_V26)).toBe(false)
    expect(SYNTAX_PROMPT).not.toBe(SYNTAX_READING_PROMPT_V26)
  })
  it('upgrades the persisted candidate 21–26 syntax default without touching the reading lane or ciphertext', async () => {
    const directory = await root(),
      file = join(directory, 'ai-models.v1.json'),
      cipher = vault.encrypt('migration-fixture-key')
    const { apiKey: _key, forgetKey: _forget, ...settings } = validateProfile(profile(), 'reading')
    void _key
    void _forget
    const serialized = JSON.stringify({
      version: 1,
      syntax: {
        settings: { ...settings, systemPrompt: SYNTAX_READING_PROMPT_V26 },
        revision: 'before-upgrade-syntax',
        cipher
      },
      reading: {
        settings: { ...settings, systemPrompt: SYNTAX_READING_PROMPT_V26 },
        revision: 'before-upgrade-reading',
        cipher
      }
    })
    await writeFile(file, serialized)
    const store = new AiConfigStore(directory, vault),
      shown = await store.profiles(),
      request = await store.credentials('syntax', 'before-upgrade-syntax')
    expect(shown.syntax.systemPrompt).toBe(SYNTAX_PROMPT)
    expect(request.profile.systemPrompt).toBe(SYNTAX_PROMPT)
    expect(request.apiKey).toBe('migration-fixture-key')
    expect(shown.reading.systemPrompt).toBe(SYNTAX_READING_PROMPT_V26)
    expect(shown.syntax.revision).toBe('before-upgrade-syntax')
    expect(shown.syntax.model).toBe(settings.model)
    expect(shown.syntax.maxTokens).toBe(settings.maxTokens)
    expect(await readFile(file, 'utf8')).toBe(serialized)
    await store.save('syntax', { ...shown.syntax, apiKey: '' })
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.syntax.settings.systemPrompt).toBe(SYNTAX_PROMPT)
    expect(saved.syntax.cipher).toBe(cipher)
    expect(saved.reading).toEqual(JSON.parse(serialized).reading)
    expect((await new AiConfigStore(directory, vault).credentials('syntax')).apiKey).toBe(
      'migration-fixture-key'
    )
  })
  it('preserves even a one-character customization of the candidate 21–26 default', async () => {
    const directory = await root(),
      store = new AiConfigStore(directory, vault)
    for (const custom of [
      SYNTAX_READING_PROMPT_V26 + '\n',
      SYNTAX_READING_PROMPT_V26.replace('高阶阅读', '定向阅读')
    ]) {
      await store.save('syntax', { ...profile(), systemPrompt: custom })
      const restarted = new AiConfigStore(directory, vault)
      expect((await restarted.profiles()).syntax.systemPrompt).toBe(custom)
      expect((await restarted.credentials('syntax')).profile.systemPrompt).toBe(custom)
      expect((await restarted.credentials('syntax')).apiKey).toBe('not-a-real-key-secret')
    }
  })
  it('keeps a key out of renderer responses and disk plaintext, and decrypts on restart', async () => {
    const path = await root(),
      store = new AiConfigStore(path, vault)
    const result = await store.save('reading', profile())
    expect(result.hasKey).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(await readFile(join(path, 'ai-models.v1.json'), 'utf8')).not.toContain('not-a-real-key')
    const restarted = new AiConfigStore(path, vault)
    expect((await restarted.credentials('reading')).apiKey).toBe('not-a-real-key-secret')
    expect((await restarted.profiles()).syntax.hasKey).toBe(false)
  })
  it('serializes independent saves without losing either lane', async () => {
    const store = new AiConfigStore(await root(), vault)
    await Promise.all([
      store.save('reading', profile()),
      store.save('syntax', { ...profile(), model: 'small-syntax', apiKey: 'second-test-key' })
    ])
    const data = await store.profiles()
    expect(data.reading.model).toBe('test-model')
    expect(data.syntax.model).toBe('small-syntax')
    expect((await store.credentials('syntax')).apiKey).toBe('second-test-key')
  })
  it('retains a blank key field but drops credentials when the origin changes', async () => {
    const store = new AiConfigStore(await root(), vault)
    await store.save('reading', profile())
    await store.save('reading', { ...profile(), apiKey: '', model: 'other-model' })
    expect((await store.credentials('reading')).apiKey).toContain('secret')
    await store.save('reading', { ...profile(), apiKey: '', endpoint: 'https://another.test/v1' })
    expect((await store.credentials('reading')).apiKey).toBe('')
  })
  it('removes a key explicitly', async () => {
    const store = new AiConfigStore(await root(), vault)
    await store.save('reading', profile())
    expect(
      (await store.save('reading', { ...profile(), apiKey: '', forgetKey: true })).hasKey
    ).toBe(false)
  })
  it('rejects a request whose displayed configuration was replaced in another window', async () => {
    const store = new AiConfigStore(await root(), vault)
    const shown = await store.save('reading', profile())
    await store.save('reading', { ...profile(), endpoint: 'https://changed.test/v1' })
    await expect(store.credentials('reading', shown.revision)).rejects.toThrow('另一处改变')
  })
  it('cannot carry a saved key to a new host through an empty intermediate address', async () => {
    const store = new AiConfigStore(await root(), vault)
    await store.save('reading', profile())
    await store.save('reading', { ...profile(), apiKey: '', endpoint: '' })
    expect((await store.profiles()).reading.hasKey).toBe(false)
    await store.save('reading', { ...profile(), apiKey: '', endpoint: 'https://different.test/v1' })
    expect((await store.credentials('reading')).apiKey).toBe('')
  })
  it('uses memory only if system protection is unavailable', async () => {
    const path = await root(),
      insecure = { ...vault, available: () => false }
    const store = new AiConfigStore(path, insecure)
    expect((await store.save('reading', profile())).keyStorage).toBe('session')
    expect((await store.credentials('reading')).apiKey).toContain('secret')
    expect(await readFile(join(path, 'ai-models.v1.json'), 'utf8')).not.toContain('secret')
    expect((await new AiConfigStore(path, insecure).profiles()).reading.hasKey).toBe(false)
  })
  it('does not overwrite corrupted settings', async () => {
    const path = await root(),
      file = join(path, 'ai-models.v1.json')
    await writeFile(file, 'broken')
    await expect(new AiConfigStore(path, vault).save('reading', profile())).rejects.toThrow('损坏')
    expect(await readFile(file, 'utf8')).toBe('broken')
  })
  it('rejects remote cleartext, embedded keys and non-network protocols', () => {
    for (const address of [
      'http://example.test/v1',
      'file:///C:/private',
      'https://user:pass@example.test/v1',
      'https://example.test/v1?key=secret'
    ])
      expect(() => endpointUrl(address, 'chat-completions')).toThrow()
    expect(endpointUrl('http://127.0.0.1:5000/v1', 'chat-completions')).toBe(
      'http://127.0.0.1:5000/v1/chat/completions'
    )
    expect(endpointUrl('https://example.test/v1/messages', 'anthropic')).toBe(
      'https://example.test/v1/messages'
    )
  })
})
