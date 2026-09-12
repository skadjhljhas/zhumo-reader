<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  defaultAiProfile,
  aiConfigurationMode,
  SYNTAX_CONTRACT,
  type AnnotationMode,
  type AiLane,
  type AiProfileInput
} from '../../../shared/ai-types'
import { aiState, loadAiProfiles } from '../composables/aiReading'
import { isSyntaxStreamDemo } from '../dev/syntax-stream-demo'
import { createAiRequestCode } from '../../../shared/ai-request-code'
import { settings } from '../composables/useSettings'
import {
  DOCUMENT_ANNOTATION_PROMPT,
  DOCUMENT_ANNOTATION_CONTRACT
} from '../../../shared/annotation-prompts'
const dialog = ref<HTMLDialogElement>()
const drafts = reactive<Record<AiLane, AiProfileInput>>({
  reading: defaultAiProfile('reading'),
  syntax: defaultAiProfile('syntax')
})
const draft = computed(() => drafts[aiState.settingsLane])
const promptMode = ref<AnnotationMode>('follow')
const promptDraft = computed({
  get: () =>
    aiState.settingsLane === 'syntax' && promptMode.value === 'document'
      ? (draft.value.documentSystemPrompt ?? DOCUMENT_ANNOTATION_PROMPT)
      : draft.value.systemPrompt,
  set: (value: string) => {
    if (aiState.settingsLane === 'syntax' && promptMode.value === 'document')
      draft.value.documentSystemPrompt = value
    else draft.value.systemPrompt = value
  }
})
const outputMode = computed({
  get: () => (draft.value.maxTokens === 0 ? 'default' : 'custom'),
  set: (value: string) => {
    draft.value.maxTokens = value === 'default' ? 0 : 32768
  }
})
function resetPrompt(): void {
  promptDraft.value =
    aiState.settingsLane === 'syntax' && promptMode.value === 'document'
      ? DOCUMENT_ANNOTATION_PROMPT
      : defaultAiProfile(aiState.settingsLane).systemPrompt
}
const codeMode = computed(() => aiConfigurationMode(draft.value) === 'code')
const connectionHint = computed(() => {
  try {
    return new URL(draft.value.endpoint).host
  } catch {
    return '填写 API 地址与密钥'
  }
})
function configureMode(mode: 'simple' | 'code'): void {
  draft.value.configurationMode = mode
  if (mode === 'code' && !draft.value.requestCode?.trim())
    draft.value.requestCode = createAiRequestCode(draft.value)
}
const qwen = computed(() => /^qwen3(?:[.-]|$)/i.test(draft.value.model))
const thinkingStrength = computed({
  get: () =>
    draft.value.thinkingMode === 'disabled'
      ? 'none'
      : qwen.value && draft.value.reasoningEffort === 'high'
        ? 'max'
        : draft.value.reasoningEffort,
  set: (value: 'none' | AiProfileInput['reasoningEffort']) => {
    if (value === 'none') {
      draft.value.thinkingMode = 'disabled'
      draft.value.reasoningEffort = 'default'
      return
    }
    draft.value.reasoningEffort = value
    if (value === 'default') draft.value.thinkingMode = 'default'
    else if (draft.value.thinkingMode !== 'adaptive') draft.value.thinkingMode = 'enabled'
  }
})
const deepseek = computed(() => {
  try {
    return new URL(draft.value.endpoint).hostname === 'api.deepseek.com'
  } catch {
    return false
  }
})
watch(
  () => draft.value.protocol,
  (value) => {
    if (value !== 'anthropic' && draft.value.thinkingMode === 'adaptive')
      draft.value.thinkingMode = 'default'
  }
)
const available = Boolean(window.ai) && !isSyntaxStreamDemo,
  busy = ref(false),
  error = ref(''),
  message = ref(''),
  testing = ref('')
let off: (() => void) | undefined,
  opener: HTMLElement | null = null,
  revision = 0
async function opened(): Promise<void> {
  const own = ++revision
  if (!aiState.settingsOpen) {
    dialog.value?.close()
    stopTest()
    return
  }
  opener = document.activeElement as HTMLElement | null
  await nextTick()
  promptMode.value = settings.annotationMode
  dialog.value?.showModal()
  error.value = ''
  message.value = ''
  await loadAiProfiles()
  if (own !== revision || !aiState.settingsOpen) return
  for (const lane of ['reading', 'syntax'] as const)
    drafts[lane] = { ...aiState.profiles[lane], apiKey: '', forgetKey: false }
}
function close(): void {
  aiState.settingsOpen = false
  opener?.focus({ preventScroll: true })
}
function stopTest(): void {
  if (testing.value) void window.ai?.cancel(testing.value).catch(() => undefined)
  testing.value = ''
}
function stopConnectionTest(): void {
  stopTest()
  message.value = '测试已停止。'
}
async function save(): Promise<boolean> {
  if (!window.ai || busy.value) return false
  busy.value = true
  error.value = ''
  message.value = ''
  const lane = aiState.settingsLane
  try {
    const profile = await window.ai.saveProfile(lane, { ...drafts[lane] })
    aiState.profiles[lane] = profile
    drafts[lane] = { ...profile, apiKey: '', forgetKey: false }
    message.value = `${lane === 'reading' ? '阅读模型' : '句法模型'}已保存。`
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败。'
    return false
  } finally {
    busy.value = false
  }
}
async function testConnection(): Promise<void> {
  const own = revision,
    lane = aiState.settingsLane
  if (!(await save()) || !window.ai) return
  if (own !== revision || !aiState.settingsOpen || lane !== aiState.settingsLane) return
  stopTest()
  const id = crypto.randomUUID()
  testing.value = id
  message.value = '正在测试连接…'
  try {
    await window.ai.start({
      id,
      profileRevision: aiState.profiles[lane].revision,
      lane,
      document: '',
      selectedText: '',
      instruction: '',
      test: true
    })
  } catch (cause) {
    if (testing.value === id) {
      testing.value = ''
      error.value = cause instanceof Error ? cause.message : '连接失败。'
    }
  }
}
watch(() => aiState.settingsOpen, opened)
watch(
  () => aiState.settingsLane,
  () => {
    stopTest()
    message.value = ''
    error.value = ''
  }
)
onMounted(() => {
  off = window.ai?.onEvent((event) => {
    if (event.id !== testing.value || event.type === 'delta' || event.type === 'reasoning') return
    testing.value = ''
    if (event.type === 'done') message.value = '连接成功，模型返回了文本。'
    else if (event.type === 'error') {
      error.value = event.message
      message.value = ''
    } else message.value = '测试已停止。'
  })
  if (aiState.settingsOpen) void opened()
})
onBeforeUnmount(() => {
  revision++
  stopTest()
  off?.()
})
</script>
<template>
  <dialog
    ref="dialog"
    class="ai-settings"
    aria-label="AI 模型与提示词"
    @cancel.prevent="close"
    @close="aiState.settingsOpen = false"
  >
    <header class="ai-head">
      <div>
        <span class="ai-eyebrow">让理解各有所长</span>
        <h2>模型与提示词</h2>
      </div>
      <button class="ai-close" aria-label="关闭模型设置" @click="close">×</button>
    </header>
    <div class="ai-tabs" role="tablist" aria-label="配置独立模型">
      <button
        role="tab"
        :aria-selected="aiState.settingsLane === 'reading'"
        @click="aiState.settingsLane = 'reading'"
      >
        阅读 · 理解与解释
      </button>
      <button
        role="tab"
        :aria-selected="aiState.settingsLane === 'syntax'"
        @click="aiState.settingsLane = 'syntax'"
      >
        句法 · 结构与光
      </button>
    </div>
    <div class="ai-settings-body">
      <p class="ai-description">
        {{
          aiState.settingsLane === 'reading'
            ? '把全文与选句交给擅长理解的模型。你的系统提示词决定它怎样回应。'
            : '为语言结构配置独立模型和提示词。完整的小批关系抵达后即开始显影。'
        }}
      </p>
      <p v-if="!available" class="ai-notice">
        此浏览器页面可以预览界面与光效。真实 API 连接和密钥保存请在朱墨桌面程序中使用。
      </p>
      <p v-if="aiState.configError" class="ai-error" role="alert">{{ aiState.configError }}</p>
      <fieldset :disabled="!available || busy || Boolean(testing)">
        <div class="ai-tabs ai-configuration-modes" role="tablist" aria-label="模型配置方式">
          <button
            type="button"
            role="tab"
            :aria-selected="!codeMode"
            @click="configureMode('simple')"
          >
            简易模式
          </button>
          <button type="button" role="tab" :aria-selected="codeMode" @click="configureMode('code')">
            代码模式
          </button>
        </div>
        <component :is="codeMode ? 'details' : 'div'" class="ai-connection-fields">
          <summary v-if="codeMode">连接设置 · {{ connectionHint }}</summary>
          <div class="ai-form-pair">
            <label
              >接口协议<select v-model="draft.protocol" aria-label="接口协议">
                <option value="chat-completions">OpenAI 兼容 · Chat Completions</option>
                <option value="anthropic">Anthropic · Messages</option>
              </select></label
            ><label v-if="!codeMode"
              >模型名<input
                v-model="draft.model"
                aria-label="模型名"
                placeholder="填写服务商提供的模型 ID"
                spellcheck="false"
                autocomplete="off"
            /></label>
          </div>
          <label
            >API 地址<input
              v-model="draft.endpoint"
              aria-label="API 地址"
              placeholder="https://你的服务商/v1"
              spellcheck="false"
              autocomplete="off"
          /></label>
          <p class="ai-field-hint">
            可填基础地址或完整接口地址；本机模型支持 http://127.0.0.1:端口/v1。
          </p>
          <label
            >API 密钥<input
              v-model="draft.apiKey"
              aria-label="API 密钥"
              type="password"
              autocomplete="new-password"
              :placeholder="
                aiState.profiles[aiState.settingsLane].hasKey
                  ? '已保存；留空保留，填写则替换'
                  : '本机无鉴权接口可留空'
              "
          /></label>
          <div class="ai-key-info">
            <span>{{
              aiState.profiles[aiState.settingsLane].keyStorage === 'encrypted'
                ? '密钥已由系统加密保存'
                : aiState.profiles[aiState.settingsLane].keyStorage === 'session'
                  ? '系统保护不可用，密钥仅供本次运行使用'
                  : aiState.profiles[aiState.settingsLane].keyStorage === 'unavailable'
                    ? '原密钥无法解密，请重新填写'
                    : '密钥仅交给你配置的接口'
            }}</span>
            <label v-if="aiState.profiles[aiState.settingsLane].hasKey"
              ><input v-model="draft.forgetKey" type="checkbox" />移除已存密钥</label
            >
          </div>
          <p class="ai-field-hint">更换为另一服务地址时，旧密钥不会自动沿用。</p>
        </component>
        <section v-if="codeMode" class="ai-code-config" aria-label="代码模式配置">
          <label for="ai-request-body-code">请求体代码 · JavaScript</label>
          <p>
            返回你要发送的请求体。软件提供选句和上下文，代码决定模型与参数；也兼容原来的 return
            request 写法。
          </p>
          <div class="ai-result-actions">
            <button type="button" @click="draft.requestCode = createAiRequestCode(draft)">
              填入代码模板
            </button>
          </div>
          <textarea
            id="ai-request-body-code"
            v-model="draft.requestCode"
            aria-label="请求配置代码"
            class="ai-request-code"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            placeholder="return { model: '模型 ID', messages: request.body.messages, stream: true };"
          />
          <p class="ai-field-hint">
            密钥使用占位符
            <code v-text="'{{API_KEY}}'"></code>，软件发送时注入；不要在代码里粘贴密钥。
            代码可以修改同一服务地址下的路径；不提供文件、网络和模块 API。 保留 body.stream =
            true；请勿删除句法系统提示词中的输出契约。
          </p>
        </section>
        <div v-if="!codeMode" class="ai-form-pair">
          <label
            >输出长度<select v-model="outputMode" aria-label="输出长度模式">
              <option value="default">模型默认</option>
              <option value="custom">自定义</option>
            </select></label
          >
          <label v-if="outputMode === 'custom'"
            >最大输出 tokens<input
              v-model.number="draft.maxTokens"
              type="number"
              min="256"
              max="131072"
              step="256"
              aria-label="最大输出 tokens"
          /></label>
          <label v-if="outputMode === 'custom' && draft.protocol === 'chat-completions'"
            >输出长度参数<select v-model="draft.tokenParameter" aria-label="输出长度参数">
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </select></label
          >
        </div>
        <label v-if="aiState.settingsLane === 'syntax'"
          >句法上下文<select v-model="draft.context" aria-label="句法上下文">
            <option value="default">模型默认 · 完整上下文</option>
            <option value="selection">仅发送当前句段</option>
            <option value="full">句段前后各最多100k字符 · 用于消歧</option>
          </select></label
        >
        <div v-if="!codeMode" class="ai-form-pair">
          <label
            >思考模式<select v-model="draft.thinkingMode" aria-label="思考模式">
              <option value="default">服务商默认</option>
              <option value="enabled">启用思考</option>
              <option value="disabled">关闭思考</option>
              <option v-if="draft.protocol === 'anthropic' && !deepseek" value="adaptive">
                自适应 · 新版 Claude
              </option>
            </select></label
          >
          <label
            >思考强度<select v-model="thinkingStrength" aria-label="思考强度">
              <option value="none">不思考</option>
              <option value="default">服务商默认</option>
              <option value="low">低 · 更快交付</option>
              <option value="medium">中 · 平衡速度与推理</option>
              <option v-if="!qwen" value="high">高</option>
              <option value="max">最大</option>
            </select></label
          >
        </div>
        <label
          v-if="
            !codeMode &&
            draft.protocol === 'anthropic' &&
            !deepseek &&
            draft.thinkingMode === 'enabled'
          "
          >手动思考预算 tokens<input
            v-model.number="draft.thinkingBudget"
            type="number"
            min="1024"
            :max="draft.maxTokens ? draft.maxTokens - 1 : 130048"
            step="1024"
            aria-label="手动思考预算 tokens"
        /></label>
        <p v-if="!codeMode && qwen" class="ai-field-hint">
          思考参数由具体模型及服务接口决定。如果接口不支持“不思考”，请启用思考或选择服务商默认。
          两套模型独立保存。
        </p>
        <p v-if="!codeMode && !qwen" class="ai-field-hint">
          两套模型独立设置。DeepSeek
          支持上述模式和强度；其他兼容服务需支持相应参数。接口返回的思考内容会边生成边显示。更高强度可能延后首条标注的交付。
        </p>
        <div
          v-if="aiState.settingsLane === 'syntax'"
          class="ai-tabs"
          role="tablist"
          aria-label="独立标注提示词"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="promptMode === 'follow'"
            @click="promptMode = 'follow'"
          >
            跟随阅读提示词
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="promptMode === 'document'"
            @click="promptMode = 'document'"
          >
            全文标注提示词
          </button>
        </div>
        <div class="ai-prompt-label">
          <label :for="'ai-system-' + aiState.settingsLane">系统提示词</label
          ><button type="button" @click="resetPrompt">恢复内置提示词</button>
        </div>
        <textarea
          :id="'ai-system-' + aiState.settingsLane"
          v-model="promptDraft"
          aria-label="系统提示词"
          class="ai-system-prompt"
          spellcheck="false"
        />
        <details v-if="aiState.settingsLane === 'syntax'" class="ai-contract">
          <summary>查看着色输出格式</summary>
          <p>
            你的提示词决定阅读取向、标注的原词及字色与荧光色。完整记录到达就能开始显影；固定格式负责逐字定位与渲染。
          </p>
          <pre>{{
            promptMode === 'document' ? DOCUMENT_ANNOTATION_CONTRACT : SYNTAX_CONTRACT
          }}</pre>
        </details>
      </fieldset>
      <p v-if="error" class="ai-error" role="alert">{{ error }}</p>
      <p v-if="message" class="ai-status" role="status">{{ message }}</p>
    </div>
    <footer class="ai-settings-footer">
      <span>测试不含文稿，沿用当前思考与输出配置；可能产生 API 费用。</span>
      <div>
        <button v-if="testing" @click="stopConnectionTest">停止测试</button>
        <button v-else :disabled="!available || busy" @click="testConnection">
          保存并测试连接
        </button>
        <button class="ai-primary" :disabled="!available || busy || Boolean(testing)" @click="save">
          {{ busy ? '保存中…' : '保存这套配置' }}
        </button>
      </div>
    </footer>
  </dialog>
</template>
