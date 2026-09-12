<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  aiSelection,
  aiState,
  SYNTAX_DEMOS,
  cancelAi,
  cancelAiRuns,
  handleAiEvent,
  invalidateAiSelection,
  openAiSettings,
  runAi
} from '../composables/aiReading'
import { documentSession } from '../composables/documentSession'
import { studio } from '../composables/useStudio'
import { bookState } from '../composables/useBook'
import AiSyntaxText from './AiSyntaxText.vue'
import ReasoningStream from './ReasoningStream.vue'
import AutomaticSyntaxProgress from './AutomaticSyntaxProgress.vue'
import SyntaxMeaningKey from './SyntaxMeaningKey.vue'
import ReadingColorKey from './ReadingColorKey.vue'
import { automaticSyntax } from '../composables/automaticSyntax'
import { isSyntaxStreamDemo } from '../dev/syntax-stream-demo'
import { SYNTAX_ROLES, aiProfileReady, aiProfileLabel } from '../../../shared/ai-types'
import { syntaxReport } from '../../../shared/syntax-view'
import { displayedSyntax, focusedSyntax, chooseSyntaxReading } from '../composables/syntaxFocus'
const panel = ref<HTMLElement>(),
  output = ref<HTMLElement>(),
  copied = ref(false),
  copyError = ref(''),
  following = ref(true)
const sourceExpanded = ref(false)
const run = computed(() => aiState.runs[aiState.lane])
const profile = computed(() => aiState.profiles[aiState.lane])
const analysis = displayedSyntax
const syntaxFocus = computed(() => (analysis.value ? focusedSyntax(analysis.value) : undefined))
function unitQuote(id: string): string {
  return analysis.value?.spans.find((span) => span.id === id)?.quote ?? id
}
function chooseExample(index: number): void {
  aiState.syntaxExample = index
  chooseSyntaxReading('')
}
function chooseRelation(id: string): void {
  aiState.syntaxRelation = id
  aiState.activeSpan = -1
}
const hasApi = Boolean(window.ai)
const full = computed(() => aiState.lane === 'reading' || profile.value.context === 'full')
const count = computed(() => (full.value ? aiSelection.value?.source.length : 0) ?? 0)
const origin = computed(() => {
  try {
    return new URL(profile.value.endpoint).host
  } catch {
    return '尚未配置模型'
  }
})
let off: (() => void) | undefined, copyTimer: ReturnType<typeof setTimeout> | undefined
function close(): void {
  aiState.open = false
  cancelAiRuns()
}
function key(event: KeyboardEvent): void {
  if (!aiState.open || aiState.settingsOpen || document.querySelector('dialog[open]')) return
  if (event.key === 'Escape' && panel.value?.contains(document.activeElement)) {
    event.preventDefault()
    close()
  }
}
async function copy(): Promise<void> {
  const text =
    aiState.lane === 'syntax' && analysis.value ? syntaxReport(analysis.value) : run.value.output
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    copyError.value = ''
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    copyError.value = '复制暂不可用，可选择结果文字使用 Ctrl C。'
  }
}
async function exportText(): Promise<void> {
  try {
    await window.api.saveBookAs(
      aiState.lane === 'reading' ? '朱墨-AI阅读札记' : '朱墨-句法分析',
      aiState.lane === 'syntax' && analysis.value ? syntaxReport(analysis.value) : run.value.output
    )
  } catch (error) {
    copyError.value = error instanceof Error ? error.message : '另存失败。'
  }
}
function scrolled(): void {
  const el = output.value
  if (el) following.value = el.scrollHeight - el.clientHeight - el.scrollTop < 64
}
watch(
  () => run.value.output,
  () => {
    if (following.value)
      void nextTick(() => {
        output.value?.scrollTo({ top: output.value.scrollHeight })
      })
  }
)
watch(
  () => aiSelection.value,
  () => {
    following.value = true
    copied.value = false
    copyError.value = ''
    sourceExpanded.value = false
    void nextTick(() =>
      panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true })
    )
  }
)
watch(
  () => [documentSession.source, documentSession.path, documentSession.mode, bookState.status],
  invalidateAiSelection
)
onMounted(() => {
  off = window.ai?.onEvent(handleAiEvent)
  window.addEventListener('keydown', key)
  if (!window.ai && new URLSearchParams(location.search).get('aiDemo') === 'syntax') {
    aiState.open = true
    aiState.lane = 'syntax'
    aiState.demonstration = true
  }
})
onBeforeUnmount(() => {
  cancelAiRuns()
  off?.()
  clearTimeout(copyTimer)
  window.removeEventListener('keydown', key)
})
</script>
<template>
  <aside
    v-if="aiState.open"
    ref="panel"
    class="ai-reading-panel"
    :class="{ 'is-syntax-demo': aiState.demonstration && aiState.lane === 'syntax' }"
    aria-label="AI 细读"
    :data-motion="studio.effectsMode"
  >
    <header class="ai-head">
      <div>
        <span class="ai-eyebrow">循着一句话，走向深处</span>
        <h2>与文字对话</h2>
      </div>
      <div class="ai-head-actions">
        <button aria-label="配置 AI 模型" title="模型与提示词" @click="openAiSettings()">
          设置</button
        ><button class="ai-close" aria-label="收起 AI 细读" @click="close">×</button>
      </div>
    </header>
    <div class="ai-tabs" role="tablist" aria-label="AI 阅读方式">
      <button
        role="tab"
        :aria-selected="aiState.lane === 'reading'"
        @click="aiState.lane = 'reading'"
      >
        细读 <i v-if="aiState.runs.reading.status === 'running'" class="ai-busy-dot" />
      </button>
      <button
        role="tab"
        :aria-selected="aiState.lane === 'syntax'"
        @click="aiState.lane = 'syntax'"
      >
        句法之光 <i v-if="aiState.runs.syntax.status === 'running'" class="ai-busy-dot" />
      </button>
    </div>
    <div class="ai-panel-scroll">
      <AutomaticSyntaxProgress v-if="aiState.lane === 'syntax'" />
      <SyntaxMeaningKey v-if="aiState.lane === 'syntax' && analysis && analysis.version !== 4" />
      <template v-if="aiSelection">
        <div class="ai-context">
          <span class="ai-eyebrow">{{ aiSelection.origin }}</span>
          <blockquote>{{ aiSelection.quote }}</blockquote>
          <details @toggle="sourceExpanded = ($event.target as HTMLDetailsElement).open">
            <summary>
              {{
                full
                  ? aiState.lane === 'syntax'
                    ? '发送句段及前后各最多100k字符'
                    : `发送 Markdown 全文 · ${count.toLocaleString()} 字符 + 选句`
                  : `仅发送选句 · ${aiSelection.quote.length.toLocaleString()} 字符`
              }}
            </summary>
            <p>
              发往 {{ origin }} ·
              {{ aiProfileLabel(profile) || '请先设置模型' }}。只有点击下方生成按钮才会发送。
            </p>
            <p v-if="full && aiState.lane === 'reading'">
              包含 Markdown
              源文、注释及其中的文字；不读取外链、图片文件或其他本机文件。全文不自动截断。
            </p>
            <pre
              v-if="full && sourceExpanded && aiState.lane === 'reading'"
              class="ai-source-preview"
              >{{ aiSelection.source }}</pre>
          </details>
        </div>
        <p v-if="aiState.stale" class="ai-notice">
          文稿已改变或已进入编辑。此结果保留供复制，请回到阅读页重新选句后再生成。
        </p>
        <template v-else>
          <label class="ai-instruction-label"
            >{{ aiState.lane === 'reading' ? '这次想怎样理解它？' : '这次侧重哪种结构？' }}
            <textarea
              v-if="aiState.lane === 'reading'"
              v-model="aiState.instruction"
              aria-label="本次阅读要求"
              rows="2"
              placeholder="解释这段论证；追踪一个概念；写一则旁注……"
              :disabled="run.status === 'running'"
            />
            <textarea
              v-else
              v-model="aiState.syntaxInstruction"
              aria-label="本次句法要求"
              rows="2"
              placeholder="分析关键关系、否定范围、隐含成分，或比较不同读法。"
              :disabled="run.status === 'running'"
            />
          </label>
          <div class="ai-generate-row">
            <span>{{ aiProfileLabel(profile) || '独立模型，独立提示词' }}</span>
            <button v-if="run.status === 'running'" @click="cancelAi(aiState.lane)">
              停止生成
            </button>
            <button v-else class="ai-primary" @click="runAi(aiState.lane)">
              {{
                !hasApi || !aiProfileReady(profile)
                  ? '设置模型'
                  : aiState.lane === 'reading'
                    ? '发送全文与选句'
                    : full
                      ? '发送上下文并分析句法'
                      : '发送选句并分析句法'
              }}
            </button>
          </div>
        </template>
      </template>
      <div
        v-else-if="!aiState.demonstration && !(aiState.lane === 'syntax' && automaticSyntax.latest)"
        class="ai-empty"
      >
        <span class="ai-empty-ray" aria-hidden="true" />
        <h3>从你停留的那句话开始</h3>
        <p>
          选区解释按全局设置自动开始；句法之光会在阅读停留后逐批显影。两种理解，各有自己的模型与提示词。
        </p>
        <button @click="openAiSettings()">连接我的模型</button>
      </div>
      <p v-if="run.status === 'running'" class="ai-status" role="status">
        {{ run.output ? '文字正在抵达…' : '已发送，正在等待模型…' }} 可随时停止。
      </p>
      <p v-if="run.status === 'cancelled'" class="ai-status" role="status">
        已停止。已接收的内容保留在此。
      </p>
      <p v-if="run.error" class="ai-error" role="alert">{{ run.error }}</p>
      <p v-if="run.warning && !run.error" class="ai-notice">{{ run.warning }}</p>
      <ReasoningStream :key="run.id" :text="run.reasoning" :running="run.status === 'running'" />
      <div
        v-if="aiState.lane === 'reading' && run.output"
        ref="output"
        class="ai-answer"
        tabindex="0"
        aria-label="AI 生成结果"
        @scroll="scrolled"
      >
        {{ run.output }}
      </div>
      <template v-if="aiState.lane === 'syntax' && (aiSelection || aiState.demonstration)">
        <div class="syntax-light-controls">
          <div
            v-if="analysis && analysis.version !== 4"
            class="ai-light-options"
            role="group"
            aria-label="句法光效变体"
          >
            <button
              v-for="style in [
                ['spectrum', '折光'],
                ['tide', '潮汐'],
                ['constellation', '共鸣']
              ] as const"
              :key="style[0]"
              :aria-pressed="aiState.lightStyle === style[0]"
              @click="aiState.lightStyle = style[0]"
            >
              {{ style[1] }}
            </button>
          </div>
          <label class="ai-light-switch"
            ><input v-model="aiState.lightsOn" type="checkbox" />显示光效</label
          >
        </div>
        <label class="syntax-intensity"
          >光的分寸<input
            v-model.number="aiState.intensity"
            type="range"
            min="0.15"
            max="1"
            step="0.05"
            aria-label="句法光效强度"
        /></label>
        <button
          v-if="!analysis && run.status !== 'running'"
          class="ai-demo-button"
          @click="aiState.demonstration = true"
        >
          先看光效示意 · 不调用模型
        </button>
        <template v-if="analysis">
          <p v-if="aiState.demonstration" class="ai-notice">
            光效示意 · 固定例句，未调用模型，也未标注你的文稿。
          </p>
          <div v-if="aiState.demonstration" class="syntax-reading-choices">
            <span>选择一个语言现象</span>
            <div>
              <button
                v-for="(example, index) in SYNTAX_DEMOS"
                :key="example.id"
                :aria-pressed="aiState.syntaxExample === index"
                @click="chooseExample(index)"
              >
                {{ example.title }}
              </button>
            </div>
          </div>
          <div
            v-if="analysis.readings?.length"
            class="syntax-reading-choices"
            aria-label="候选读法"
          >
            <span>比较读法</span>
            <div>
              <button
                v-for="reading in analysis.readings"
                :key="reading.id"
                :aria-pressed="syntaxFocus?.reading?.id === reading.id"
                @click="chooseSyntaxReading(reading.id)"
              >
                {{ reading.label }}
              </button>
            </div>
            <p>{{ syntaxFocus?.reading?.explanation }}</p>
            <p>区分条件：{{ syntaxFocus?.reading?.conditions }}</p>
          </div>
          <AiSyntaxText :analysis="analysis" />
          <p
            v-if="!aiState.demonstration && aiSelection && !aiSelection.anchors.length"
            class="ai-notice"
          >
            这个选区含有无法直接对应的排版结构，先在下方显示分析，未给正文猜测标注位置。
          </p>
          <p class="syntax-summary">{{ analysis.summary }}</p>
          <ReadingColorKey v-if="analysis.version === 4" :marks="analysis.marks ?? []" />
          <p v-if="!analysis.spans.length && !analysis.marks?.length" class="ai-status">
            本段没有选择需要标注的词句。
          </p>
          <div
            v-if="syntaxFocus?.relations.length"
            class="syntax-relations"
            aria-label="语法关系与范围"
          >
            <template v-for="relation in syntaxFocus.relations" :key="relation.id">
              <button
                class="syntax-relation-option"
                :data-relation-id="relation.id"
                :aria-pressed="syntaxFocus.relation?.id === relation.id"
                @click="chooseRelation(relation.id)"
                @focus="chooseRelation(relation.id)"
              >
                <strong>{{ relation.label }}</strong
                ><small
                  >{{ unitQuote(relation.from) }} →
                  {{ relation.to.map(unitQuote).join(' · ') }}</small
                ><span>{{ relation.explanation }}</span>
                <small v-if="relation.status !== 'supported'">{{
                  relation.status === 'possible' ? '一种有依据的读法' : '此处仍待判断'
                }}</small>
              </button>
              <p v-if="syntaxFocus.relation?.id === relation.id" class="syntax-relation-evidence">
                依据：{{ relation.evidence }}
              </p>
            </template>
          </div>
          <details
            v-if="analysis.version !== 4"
            class="syntax-units-disclosure"
            :open="!analysis.relations?.length"
          >
            <summary>查看成分与依据</summary>
            <div class="syntax-legend" aria-label="句法标签与解释">
              <button
                v-for="{ span, index } in syntaxFocus?.units ?? []"
                :key="index"
                :data-role="span.role"
                :class="{ 'is-active': aiState.activeSpan === index }"
                @mouseenter="aiState.activeSpan = index"
                @mouseleave="aiState.activeSpan = -1"
                @focus="aiState.activeSpan = index"
                @blur="aiState.activeSpan = -1"
              >
                <span class="syntax-role-dot" /><span
                  ><strong>{{ span.implicit ? '〔隐含〕' : '' }}{{ span.quote }}</strong
                  ><small
                    >{{ span.label || SYNTAX_ROLES[span.role]
                    }}<em v-if="span.status === 'possible' || span.status === 'unresolved'">
                      · {{ span.status === 'possible' ? '可讨论' : '待判断' }}</em
                    ></small
                  ><span class="syntax-explanation">{{ span.explanation }}</span
                  ><small v-if="span.evidence">依据：{{ span.evidence }}</small></span
                >
              </button>
            </div>
          </details>
          <p class="ai-field-hint">
            {{
              analysis.version === 4
                ? '字色与荧光由模型依据你的提示词选择，原文保持原样。'
                : '光呈现当前考察的关系；原文、依据和其他读法始终可查。'
            }}
          </p>
        </template>
        <details v-if="run.output && (!analysis || run.status === 'error')" class="ai-contract">
          <summary>查看模型原始输出</summary>
          <pre>{{ run.output }}</pre>
        </details>
      </template>
      <div v-if="run.output || (aiState.lane === 'syntax' && analysis)" class="ai-result-actions">
        <button @click="copy">{{ copied ? '已复制' : '复制结果' }}</button
        ><button v-if="run.output" @click="exportText">另存结果</button
        ><span>{{ run.model ? '来自 ' + run.model : '原文保持原样' }}</span>
      </div>
      <p v-if="copyError" class="ai-error" role="alert">{{ copyError }}</p>
    </div>
    <footer class="ai-panel-footer">
      {{
        isSyntaxStreamDemo
          ? '固定流式示意 · 未调用模型'
          : aiState.demonstration
            ? '固定例句 · 未调用模型'
            : hasApi
              ? '由你选择的模型回应 · 生成结果不自动写入文稿'
              : '浏览器预览 · 真实模型连接请使用桌面程序'
      }}
    </footer>
  </aside>
</template>
