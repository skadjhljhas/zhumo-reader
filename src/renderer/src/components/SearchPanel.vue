<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch
} from 'vue'
import { studio } from '../composables/useStudio'
import { bookState } from '../composables/useBook'
import { requestSearchLanding } from '../composables/readerStore'
import {
  occurrenceContext,
  searchBook,
  SEARCH_BINS,
  SEARCH_PAGE_SIZE,
  type SearchIndex,
  type SearchOccurrence,
  type SearchScope
} from '../composables/bookSearch'
import { createSearchIndex } from '../composables/searchIndex'
import { readingPhraseRequest } from '../composables/readingPhrase'
import { clearSearchHighlight } from '../composables/searchLanding'
import { documentSession, guardDocumentAction } from '../composables/documentSession'
import StudioIcon from './StudioIcon.vue'
import {
  comparisonPassage,
  samePassage,
  type ComparisonPassage
} from '../composables/readingComparison'
import { textDocumentVersion, type TextDocumentVersion } from '../composables/textAddress'
import { navigateTextAddress } from '../composables/textNavigation'
import { findBookHash } from '../composables/bookResources'
const ReadingComparison = defineAsyncComponent(() => import('./ReadingComparison.vue'))

const dialog = ref<HTMLDialogElement>(),
  field = ref<HTMLInputElement>(),
  contextScroll = ref<HTMLElement>()
const query = ref(''),
  scope = ref<SearchScope>('all'),
  caseSensitive = ref(false),
  active = ref(0),
  indexing = ref(false),
  indexProgress = ref(0),
  pending = ref(false),
  notice = ref(''),
  copied = ref('')
const emptyIndex: SearchIndex = { entries: [], lengths: { section: 0, note: 0 } }
const corpus = shallowRef<SearchIndex | null>(null)
const version = shallowRef<TextDocumentVersion>()
const held = shallowRef<ComparisonPassage>()
const pair = shallowRef<{ left: ComparisonPassage; right: ComparisonPassage }>()
const found = shallowRef(searchBook(emptyIndex, ''))
let controller: AbortController | undefined,
  queryTimer: ReturnType<typeof setTimeout> | undefined,
  copyTimer: ReturnType<typeof setTimeout> | undefined,
  alive = true

watch(readingPhraseRequest, (request) => {
  if (
    !request ||
    request.book !== bookState.book ||
    bookState.status !== 'reading' ||
    documentSession.mode !== 'read'
  )
    return
  query.value = request.query
  scope.value = 'all'
  caseSensitive.value = true
  notice.value = ''
  studio.searchOpen = true
})

const pageNumber = computed(() => Math.floor(active.value / SEARCH_PAGE_SIZE))
const pageCount = computed(() => Math.max(1, Math.ceil(found.value.total / SEARCH_PAGE_SIZE)))
const busy = computed(() => indexing.value || pending.value)
const rows = computed(() =>
  found.value.page(pageNumber.value * SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE).map((hit) => ({
    ...hit,
    entry: corpus.value!.entries[hit.entryIndex],
    excerpt: occurrenceContext(corpus.value!.entries[hit.entryIndex].text, hit)
  }))
)
const current = computed(() => {
  const hit = found.value.at(active.value)
  if (!hit || !corpus.value) return null
  const entry = corpus.value.entries[hit.entryIndex]
  return { hit, entry, excerpt: occurrenceContext(entry.text, hit, 650, 1250) }
})
const passage = computed(() =>
  current.value && corpus.value && bookState.book && version.value
    ? comparisonPassage(bookState.book, corpus.value, current.value.hit, query.value, version.value)
    : undefined
)
const canCompare = computed(
  () => !!held.value && !!passage.value && !samePassage(held.value, passage.value)
)
function hold(): void {
  if (passage.value) held.value = passage.value
}
function compare(): void {
  if (!held.value || !passage.value || !canCompare.value) return
  const selected = { left: held.value, right: passage.value }
  guardDocumentAction(() => {
    documentSession.mode = 'read'
    if (selected.left.book !== bookState.book) {
      query.value = selected.right.query
      notice.value = '文稿已更新，请从新结果重新选择两页。'
      studio.searchOpen = true
      return
    }
    pair.value = selected
  })
}
const tracks = computed(() =>
  (['section', 'note'] as const)
    .filter((kind) => scope.value === 'all' || scope.value === kind)
    .map((kind) => {
      const bins = found.value.bins[kind]
      const max = Math.max(1, ...bins.map((bin) => bin.count))
      const selected = current.value?.entry.kind === kind ? current.value : null
      const selectedBin = selected
        ? Math.min(
            SEARCH_BINS - 1,
            Math.floor(
              ((selected.entry.position + selected.hit.start) /
                Math.max(1, corpus.value!.lengths[kind])) *
                SEARCH_BINS
            )
          )
        : -1
      return {
        kind,
        label: kind === 'section' ? '正文' : '旁注',
        count: found.value.counts[kind],
        selectedBin,
        bins: bins.map((bin, index) => ({
          ...bin,
          index,
          height: bin.count ? 18 + (Math.log1p(bin.count) / Math.log1p(max)) * 72 : 3,
          label:
            (kind === 'section' ? '正文' : '旁注') +
            ' ' +
            Math.floor((index / SEARCH_BINS) * 100) +
            '%–' +
            Math.ceil(((index + 1) / SEARCH_BINS) * 100) +
            '% · ' +
            bin.count +
            ' 处'
        }))
      }
    })
)
function neighbor(delta: number): string {
  const selected = current.value
  if (!selected || !corpus.value) return ''
  const entry = corpus.value.entries[selected.hit.entryIndex + delta]
  if (!entry || entry.id !== selected.entry.id || entry.kind !== selected.entry.kind) return ''
  return entry.text.length > 240
    ? delta < 0
      ? '…' + entry.text.slice(-240)
      : entry.text.slice(0, 240) + '…'
    : entry.text
}

async function ensureIndex(): Promise<void> {
  if (corpus.value || indexing.value || !bookState.book || !studio.searchOpen) return
  const book = bookState.book
  const path = bookState.payload?.path ?? documentSession.path
  const source = bookState.payload?.content ?? documentSession.savedSource
  const own = new AbortController()
  controller = own
  indexing.value = true
  indexProgress.value = 0
  try {
    const index = await createSearchIndex(book, own.signal, (progress) => {
      if (!own.signal.aborted) indexProgress.value = progress
    })
    const identity = index && (await textDocumentVersion(path, source))
    if (
      index &&
      identity &&
      alive &&
      book === bookState.book &&
      !own.signal.aborted &&
      path === bookState.payload?.path &&
      source === bookState.payload?.content
    ) {
      version.value = identity
      corpus.value = index
    }
  } catch {
    if (!own.signal.aborted) notice.value = '暂时无法检索这份文稿，请关闭后重试。'
  } finally {
    if (controller === own) indexing.value = false
  }
}
function cancelIndex(): void {
  controller?.abort()
  controller = undefined
  indexing.value = false
}
watch([query, scope, caseSensitive, corpus], () => {
  clearTimeout(queryTimer)
  active.value = 0
  found.value = searchBook(emptyIndex, '')
  pending.value = Boolean(corpus.value && query.value.trim())
  if (!pending.value) return
  queryTimer = setTimeout(() => {
    found.value = searchBook(corpus.value!, query.value, scope.value, caseSensitive.value)
    pending.value = false
  }, 90)
})
watch(
  () => bookState.book,
  () => {
    readingPhraseRequest.value = null
    cancelIndex()
    corpus.value = null
    version.value = undefined
    held.value = undefined
    pair.value = undefined
    query.value = ''
    notice.value = ''
    clearSearchHighlight()
    void ensureIndex()
  }
)
watch(
  () => bookState.status,
  (status) => {
    if (status !== 'reading') studio.searchOpen = false
  }
)
watch(
  () => documentSession.mode,
  () => clearSearchHighlight()
)
watch(
  () => studio.searchOpen,
  async (open) => {
    if (!open) {
      cancelIndex()
      pair.value = undefined
    }
    await nextTick()
    if (!alive || studio.searchOpen !== open) return
    if (open) {
      dialog.value?.showModal()
      field.value?.focus({ preventScroll: true })
      void ensureIndex()
    } else dialog.value?.close()
  }
)
watch(current, async () => {
  copied.value = ''
  await nextTick()
  const root = contextScroll.value
  const mark = root?.querySelector('mark')
  if (root && mark)
    root.scrollTop += mark.getBoundingClientRect().top - root.getBoundingClientRect().top - 100
})
function activate(ordinal: number): void {
  if (busy.value || !found.value.total) return
  active.value = Math.max(0, Math.min(found.value.total - 1, ordinal))
  void nextTick().then(() =>
    dialog.value?.querySelector('.search-row.active')?.scrollIntoView({ block: 'nearest' })
  )
}
function go(hit: SearchOccurrence): void {
  if (busy.value || !corpus.value || !bookState.book || !version.value) return
  const target = comparisonPassage(bookState.book, corpus.value, hit, query.value, version.value)
  if (target) goPassage(target)
}
function goPassage(target: ComparisonPassage): void {
  const book = target.book
  const term = target.query
  pair.value = undefined
  studio.searchOpen = false
  guardDocumentAction(() => {
    documentSession.mode = 'read'
    // Saving an edited draft can replace every parser address. Re-index that
    // text before offering a destination instead of jumping to a stale ID.
    if (book !== bookState.book) {
      query.value = term
      notice.value = '文稿已更新，请从新结果继续。'
      studio.searchOpen = true
      return
    }
    void nextTick().then(async () => {
      if (book !== bookState.book) return
      const result = await navigateTextAddress(target.address)
      if (result.status !== 'landed' && result.status !== 'cancelled' && book === bookState.book) {
        notice.value = '这处原文尚未可靠定位，请从检索结果重新选择。'
        studio.searchOpen = true
      }
    })
  })
}
function followComparisonHash(hash: string): void {
  const target = bookState.book && findBookHash(bookState.book, hash)
  if (!target) return
  pair.value = undefined
  studio.searchOpen = false
  requestSearchLanding(target.sectionId, target.blockIndex)
}
function queryKey(event: KeyboardEvent): void {
  if (event.isComposing || busy.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    activate(active.value + (event.key === 'ArrowDown' ? 1 : -1))
  } else if (event.key === 'Enter' && current.value) {
    event.preventDefault()
    go(current.value.hit)
  }
}
function key(event: KeyboardEvent): void {
  if (event.isComposing || !event.altKey) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    activate(active.value + (event.key === 'ArrowRight' ? 1 : -1))
  }
}
async function copy(): Promise<void> {
  if (!current.value) return
  try {
    await navigator.clipboard.writeText(current.value.entry.text)
    copied.value = '已复制完整段落'
  } catch {
    copied.value = '未能复制，请选中文字复制'
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copied.value = ''), 2500)
}
function close(): void {
  studio.searchOpen = false
}
function nativeClose(): void {
  if (!dialog.value?.open) close()
}
onBeforeUnmount(() => {
  alive = false
  cancelIndex()
  clearTimeout(queryTimer)
  clearTimeout(copyTimer)
  clearSearchHighlight()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="search-dialog"
    aria-label="全文检索"
    @close="nativeClose"
    @cancel.prevent="close"
    @keydown="key"
    @click="$event.target === dialog && close()"
  >
    <header class="search-heading">
      <div>
        <span class="eyebrow">WORDS, ELSEWHERE</span>
        <h2>文句回响</h2>
      </div>
      <p>一个词，经过不同的语境。</p>
      <button class="studio-icon-button" aria-label="关闭检索" @click="close">
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="search-input">
      <StudioIcon name="search" />
      <input
        ref="field"
        v-model="query"
        placeholder="在正文与旁注中寻找…"
        aria-label="搜索正文与旁注"
        @keydown="queryKey"
      />
      <span class="search-input-count">{{
        busy ? '正在寻找' : found.total.toLocaleString() + ' 处'
      }}</span>
    </div>
    <div class="search-options">
      <div class="search-scopes" role="group" aria-label="检索范围">
        <button
          v-for="option in [
            ['all', '全部'],
            ['section', '正文'],
            ['note', '旁注']
          ] as const"
          :key="option[0]"
          :aria-pressed="scope === option[0]"
          @click="scope = option[0]"
        >
          {{ option[1] }}
        </button>
      </div>
      <label class="search-case"><input v-model="caseSensitive" type="checkbox" />区分大小写</label>
      <span>按原文字面匹配</span>
    </div>
    <div v-if="indexing" class="search-indexing" role="status">
      <span>正在整理正文与旁注… {{ Math.round(indexProgress * 100) }}%</span>
      <progress :value="indexProgress" max="1" aria-label="检索索引进度"></progress>
    </div>
    <p v-if="notice" class="search-notice" role="status">{{ notice }}</p>
    <div v-if="held" class="search-held">
      <span class="search-held-label">左页已留</span>
      <span class="search-held-title"
        >{{ held.entry.title }} · {{ held.entry.text.slice(held.hit.start, held.hit.end) }}</span
      >
      <button class="search-held-clear" aria-label="清除对读左页" @click="held = undefined">
        清除
      </button>
      <button class="studio-primary" :disabled="busy || !canCompare" @click="compare">
        并置阅读
      </button>
    </div>
    <div class="search-body" :aria-busy="busy">
      <aside class="search-list-pane" aria-label="匹配结果">
        <div class="search-count" role="status" aria-live="polite">
          <strong>{{ found.total.toLocaleString() }} 处</strong>
          <span
            >{{ found.paragraphs.toLocaleString() }} 个段落 · 正文
            {{ found.counts.section.toLocaleString() }} / 旁注
            {{ found.counts.note.toLocaleString() }}</span
          >
        </div>
        <div class="search-results">
          <div
            v-for="row in rows"
            :key="row.ordinal"
            class="search-row"
            :class="{ active: active === row.ordinal }"
          >
            <button
              class="search-result"
              :class="{ active: active === row.ordinal }"
              @focus="activate(row.ordinal)"
              @click="go(row)"
            >
              <span class="search-ordinal">{{ String(row.ordinal + 1).padStart(2, '0') }}</span>
              <div>
                <strong
                  ><span class="search-kind">{{ row.entry.kind === 'note' ? '旁注' : '正文' }}</span
                  >{{ row.entry.title }}</strong
                >
                <p>
                  {{ row.excerpt.leading ? '…' : '' }}{{ row.excerpt.before
                  }}<mark>{{ row.excerpt.match }}</mark
                  >{{ row.excerpt.after }}{{ row.excerpt.trailing ? '…' : '' }}
                </p>
              </div>
              <StudioIcon name="arrow" :size="15" />
            </button>
            <button
              class="search-preview-button"
              :aria-label="'查看第 ' + (row.ordinal + 1) + ' 处上下文'"
              @click="activate(row.ordinal)"
            >
              <StudioIcon name="book" :size="13" />上下文
            </button>
          </div>
          <div v-if="!rows.length" class="search-empty">
            <StudioIcon name="search" :size="34" />
            <strong>{{
              query.trim() ? (busy ? '字句正在汇集' : '尚未找到这段文字') : '从一个词开始'
            }}</strong>
            <p>
              {{
                query.trim()
                  ? '可以缩短词句，或调整检索范围。'
                  : '正文、深层旁注与尚未读到的章节，都在这里。'
              }}
            </p>
          </div>
        </div>
        <nav class="search-pagination" aria-label="检索结果翻页">
          <button aria-label="第一页结果" :disabled="busy || !pageNumber" @click="activate(0)">
            首页
          </button>
          <button
            aria-label="上一页结果"
            :disabled="busy || !pageNumber"
            @click="activate((pageNumber - 1) * SEARCH_PAGE_SIZE)"
          >
            <StudioIcon name="back" :size="15" />
          </button>
          <span>{{ pageNumber + 1 }} / {{ pageCount }}</span>
          <button
            aria-label="下一页结果"
            :disabled="busy || pageNumber + 1 >= pageCount"
            @click="activate((pageNumber + 1) * SEARCH_PAGE_SIZE)"
          >
            <StudioIcon name="arrow" :size="15" />
          </button>
          <button
            aria-label="最后一页结果"
            :disabled="busy || pageNumber + 1 >= pageCount"
            @click="activate((pageCount - 1) * SEARCH_PAGE_SIZE)"
          >
            末页
          </button>
        </nav>
      </aside>
      <section class="search-context-pane" aria-label="文句上下文">
        <div class="search-map">
          <div class="search-map-title">
            <span>字句在何处相遇</span><small>按文字位置 · 从前到后</small>
          </div>
          <div
            v-for="track in tracks"
            :key="track.kind"
            class="search-track"
            :data-kind="track.kind"
          >
            <span>{{ track.label }}</span>
            <div class="search-track-bins">
              <button
                v-for="bin in track.bins"
                :key="bin.index"
                :aria-label="bin.label"
                :title="bin.label"
                :disabled="busy || !bin.count"
                :class="{ selected: track.selectedBin === bin.index, populated: bin.count > 0 }"
                :style="{ '--hit-height': bin.height + '%' }"
                @click="activate(bin.first)"
              >
                <i></i><b></b>
              </button>
            </div>
            <small>{{ track.count.toLocaleString() }}</small>
          </div>
        </div>
        <template v-if="current">
          <div class="search-context-heading">
            <div>
              <span class="eyebrow">{{
                current.entry.kind === 'note' ? 'MARGINALIA' : 'MANUSCRIPT'
              }}</span>
              <h3>{{ current.entry.title }}</h3>
            </div>
            <span>{{ active + 1 }} / {{ found.total.toLocaleString() }}</span>
          </div>
          <div
            ref="contextScroll"
            class="search-context-scroll"
            tabindex="0"
            aria-label="当前匹配的原文上下文"
          >
            <p v-if="neighbor(-1)" class="search-neighbor">{{ neighbor(-1) }}</p>
            <p class="search-context-text">
              {{ current.excerpt.leading ? '…' : '' }}{{ current.excerpt.before
              }}<mark>{{ current.excerpt.match }}</mark
              >{{ current.excerpt.after }}{{ current.excerpt.trailing ? '…' : '' }}
            </p>
            <p v-if="neighbor(1)" class="search-neighbor">{{ neighbor(1) }}</p>
            <small
              v-if="current.excerpt.leading || current.excerpt.trailing"
              class="search-excerpt-notice"
              >长段节选 · 从此处阅读可看全文</small
            >
          </div>
          <footer class="search-context-actions">
            <div class="search-stepper">
              <button aria-label="上一处匹配" :disabled="!active" @click="activate(active - 1)">
                <StudioIcon name="back" :size="16" />
              </button>
              <button
                aria-label="下一处匹配"
                :disabled="active + 1 >= found.total"
                @click="activate(active + 1)"
              >
                <StudioIcon name="arrow" :size="16" />
              </button>
              <button aria-label="复制完整段落" title="复制完整段落" @click="copy">
                <StudioIcon name="copy" :size="16" />
              </button>
              <button class="search-hold-button" aria-label="将当前段落留作左页" @click="hold">
                留作左页
              </button>
            </div>
            <button class="studio-primary" @click="go(current.hit)">
              从此处阅读<StudioIcon name="arrow" :size="15" />
            </button>
          </footer>
        </template>
        <div v-else class="search-context-empty" aria-hidden="true">
          <span>回</span>
          <p>重读，让同一句话有了距离。</p>
        </div>
      </section>
    </div>
    <footer class="search-footer">
      <span role="status">{{
        copied || '↑ ↓ 选结果 · Enter 阅读 · Alt + ← → 逐处回看 · Esc 返回'
      }}</span>
      <span>预览上下文时，正文停在原处。</span>
    </footer>
  </dialog>
  <ReadingComparison
    v-if="pair && studio.searchOpen"
    :left="pair.left"
    :right="pair.right"
    @close="pair = undefined"
    @read="goPassage"
    @hash="followComparisonHash"
    @leave="close"
  />
</template>
