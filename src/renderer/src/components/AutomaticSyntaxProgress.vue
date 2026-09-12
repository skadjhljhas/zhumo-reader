<script setup lang="ts">
import { computed } from 'vue'
import {
  automaticSyntax,
  retryAutomaticSyntax,
  analyzeVisibleSyntax
} from '../composables/automaticSyntax'
import { aiState, loadAiProfiles, openAiSettings } from '../composables/aiReading'
import { settings } from '../composables/useSettings'
import ReasoningStream from './ReasoningStream.vue'
import { syntaxProjection } from '../../../shared/syntax-view'
import { syntaxProgressMessage } from '../../../shared/syntax-progress'
import { aiProfileLabel } from '../../../shared/ai-types'
import ReadingColorKey from './ReadingColorKey.vue'
const entry = computed(() => automaticSyntax.entries.find((e) => e.key === automaticSyntax.latest))
const failed = computed(() => automaticSyntax.entries.filter((e) => e.error))
const projection = computed(() =>
  entry.value?.analysis ? syntaxProjection(entry.value.analysis, entry.value.reading) : undefined
)
function choose(id: string): void {
  if (entry.value) {
    entry.value.reading = id
    automaticSyntax.version++
  }
}
</script>
<template>
  <section class="automatic-syntax-diagnostics" aria-label="句法运行状态">
    <p class="ai-status">{{ automaticSyntax.phase }}</p>
    <p class="ai-field-hint">
      {{ aiProfileLabel(aiState.profiles.syntax) || '未配置句法模型' }} · 可见句段
      {{ automaticSyntax.visibleCount }} · 已达到停留条件 {{ automaticSyntax.qualifiedCount }} ·
      当前标注 {{ automaticSyntax.renderedCount }}
      <template v-if="automaticSyntax.activeCount">
        · 并行分析 {{ automaticSyntax.activeCount }} 句段</template
      >
    </p>
    <p v-if="entry?.analysis?.version === 4" class="ai-field-hint">
      已收到 {{ entry.analysis.marks?.length ?? 0 }} 处字色与荧光标注。
    </p>
    <p v-else-if="entry?.analysis" class="ai-field-hint">
      已收到 {{ entry.analysis.spans.length }} 个成分、{{ entry.analysis.relations?.length ?? 0 }}
      条关系。
    </p>
    <div class="ai-result-actions">
      <button :disabled="Boolean(automaticSyntax.active)" @click="analyzeVisibleSyntax">
        分析当前可见句段
      </button>
      <button @click="loadAiProfiles">刷新模型配置</button>
      <button @click="openAiSettings('syntax')">句法模型设置</button>
    </div>
    <details v-if="failed.length" class="ai-contract">
      <summary>{{ failed.length }} 个句段暂未完成标注</summary>
      <p v-for="item in failed" :key="item.key">
        {{ item.quote.slice(0, 60) }}…<br />{{ item.error }}
      </p>
    </details>
  </section>
  <div
    v-if="automaticSyntax.entries.filter((item) => item.status === 'running').length > 1"
    class="ai-result-actions"
    aria-label="并行句段"
  >
    <button
      v-for="item in automaticSyntax.entries.filter((item) => item.status === 'running')"
      :key="item.key"
      :aria-pressed="automaticSyntax.latest === item.key"
      @click="automaticSyntax.latest = item.key"
    >
      {{ item.quote.slice(0, 18) }}{{ item.quote.length > 18 ? '…' : '' }}
    </button>
  </div>
  <section v-if="entry" class="automatic-syntax-progress" aria-label="自动句法进度">
    <span class="ai-eyebrow">正在阅读的句子</span>
    <blockquote>{{ entry.quote }}</blockquote>
    <p class="ai-status">
      {{ syntaxProgressMessage(entry, automaticSyntax.renderedCount) }}
    </p>
    <p v-if="entry.warning" class="ai-notice" role="status">
      {{
        entry.status === 'running'
          ? entry.warning
          : entry.warning.replace(' 后续有效批次继续显影。', '')
      }}
    </p>
    <p
      v-if="entry.status === 'running' && entry.reasoning && !entry.outputChars"
      class="ai-field-hint"
    >
      思考过程供你查看；只有正式返回且能逐字对应原句的结构才会显影。
      模型参数由简易模式或请求体代码配置。
    </p>
    <ReasoningStream
      :key="entry.id"
      :text="entry.reasoning"
      :running="entry.status === 'running' && !entry.outputChars"
    />
    <p v-if="entry.analysis" class="syntax-summary">{{ entry.analysis.summary }}</p>
    <ReadingColorKey v-if="entry.analysis?.version === 4" :marks="entry.analysis.marks ?? []" />
    <div v-if="entry.analysis?.readings?.length" class="syntax-reading-choices">
      <span>比较读法</span>
      <div>
        <button
          v-for="reading in entry.analysis.readings"
          :key="reading.id"
          :aria-pressed="projection?.reading?.id === reading.id"
          @click="choose(reading.id)"
        >
          {{ reading.label }}
        </button>
      </div>
      <p>{{ projection?.reading?.explanation }}</p>
      <p>区分条件：{{ projection?.reading?.conditions }}</p>
    </div>
    <details v-if="projection?.relations.length" class="syntax-units-disclosure">
      <summary>查看关系与依据</summary>
      <p v-for="r in projection.relations" :key="r.id">
        <strong>{{ r.label }}</strong> · {{ r.explanation }}<br /><small>{{ r.evidence }}</small>
      </p>
    </details>
    <p v-if="automaticSyntax.error" class="ai-error" role="alert">{{ automaticSyntax.error }}</p>
    <button v-if="automaticSyntax.error" @click="retryAutomaticSyntax">重新等待当前句子</button>
    <button v-if="entry.status === 'running'" @click="settings.automaticSyntax = false">
      暂停自动句法
    </button>
  </section>
</template>
