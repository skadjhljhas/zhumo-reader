<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StudioIcon from './StudioIcon.vue'
import NoteCard from './NoteCard.vue'
import { bookState } from '../composables/useBook'
import { studio } from '../composables/useStudio'
import { settings } from '../composables/useSettings'
import { readerState, requestScroll, requestSidebarLocate } from '../composables/readerStore'
import { atlasPage, createNoteAtlas, type AtlasEntry } from '../composables/noteAtlas'
import { searchBlocks, searchableText } from '../composables/searchText'

const dialog = ref<HTMLDialogElement>(),
  plot = ref<HTMLElement>(),
  detail = ref<HTMLElement>()
const field = ref<HTMLInputElement>(),
  focusNode = ref<HTMLButtonElement>(),
  searchBox = ref<HTMLElement>()
const originalPath = bookState.payload?.path
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
const notes = computed(() => bookState.book?.notes ?? [])
const index = computed(() => createNoteAtlas(notes.value))
const first =
  index.value.byId.get(studio.atlasNoteId) ??
  index.value.byLabel.get(studio.noteJourney.visits[studio.noteJourney.index]?.label ?? '') ??
  index.value.byId.get(readerState.focusNoteId) ??
  notes.value[0]
interface Visit {
  label: string
  place?: { block: number; offset: number; height: number }
}
const history = ref<Visit[]>(first ? [{ label: first.label }] : [])
const position = ref(0)
const current = computed(() => index.value.byLabel.get(history.value[position.value]?.label ?? ''))
const neighborhood = computed(() => index.value.neighborhood(current.value?.id ?? ''))
const capacity = ref(4),
  incomingPage = ref(0),
  outgoingPage = ref(0)
const incoming = computed(() =>
  atlasPage(neighborhood.value.incoming, incomingPage.value, capacity.value)
)
const outgoing = computed(() =>
  atlasPage(neighborhood.value.outgoing, outgoingPage.value, capacity.value)
)
const lanes = computed(() => [
  { side: 'incoming', title: '来处', page: incoming.value },
  { side: 'outgoing', title: '支线', page: outgoing.value }
])
const hovered = ref('')
const ordinate = (at: number, count: number): number => ((at + 1) * 100) / (count + 1)
function curve(side: string, at: number, count: number): string {
  const y = ordinate(at, count) * 6
  const middle = (y + 300) / 2
  return side === 'incoming'
    ? `M112 ${y} C200 ${y} 245 ${middle} 300 ${middle} S380 300 450 300`
    : `M450 300 C535 300 600 ${middle} 650 ${middle} S725 ${y} 788 ${y}`
}
function pageBy(side: string, delta: number): void {
  if (side === 'incoming')
    incomingPage.value = Math.max(
      0,
      Math.min(incoming.value.pages - 1, incoming.value.page + delta)
    )
  else
    outgoingPage.value = Math.max(
      0,
      Math.min(outgoing.value.pages - 1, outgoing.value.page + delta)
    )
}

let alive = true,
  restoreToken = 0,
  resizeObserver: ResizeObserver | undefined
function remember(): void {
  const root = detail.value,
    visit = history.value[position.value]
  if (!root || !visit) return
  const boundary = root.getBoundingClientRect().top
  const blocks = searchBlocks(root.querySelector('.zmu-note-body') ?? root)
  const block = blocks.findIndex((el) => el.getBoundingClientRect().bottom > boundary + 12)
  if (block >= 0) {
    const rect = blocks[block].getBoundingClientRect()
    visit.place = { block, offset: rect.top - boundary, height: rect.height }
  }
}
async function reveal(): Promise<boolean> {
  const token = ++restoreToken
  incomingPage.value = outgoingPage.value = 0
  hovered.value = ''
  await nextTick()
  await document.fonts.ready
  if (token !== restoreToken || !detail.value) return false
  const root = detail.value,
    place = history.value[position.value]?.place
  const target = place && searchBlocks(root.querySelector('.zmu-note-body') ?? root)[place.block]
  if (target && place) {
    const rect = target.getBoundingClientRect()
    const offset =
      place.offset < 0 && place.height > 0
        ? (place.offset * rect.height) / place.height
        : place.offset
    root.scrollTop += rect.top - root.getBoundingClientRect().top - offset
  } else root.scrollTop = 0
  return true
}
function choose(id: string, moveFocus = true): void {
  const note = index.value.byId.get(id)
  if (!note || note.id === current.value?.id) return
  remember()
  history.value = [...history.value.slice(0, position.value + 1), { label: note.label }].slice(-50)
  position.value = history.value.length - 1
  void reveal().then((restored) => {
    if (restored && moveFocus) focusNode.value?.focus({ preventScroll: true })
  })
}
function travel(delta: number): void {
  const next = position.value + delta
  if (next < 0 || next >= history.value.length) return
  remember()
  position.value = next
  void reveal().then((restored) => {
    if (restored) focusNode.value?.focus({ preventScroll: true })
  })
}
function close(): void {
  dialog.value?.close()
  studio.atlasOpen = false
}
function closed(): void {
  if (alive) studio.atlasOpen = false
}
async function readNote(): Promise<void> {
  const id = current.value?.id
  if (!id) return
  close()
  studio.panoramaOpen = false
  studio.searchOpen = false
  settings.sidebarVisible = true
  studio.focusMode = false
  await nextTick()
  requestSidebarLocate(id)
}
function readBody(noteId: string, spot?: { sectionId: string; order: number }): void {
  close()
  studio.panoramaOpen = false
  studio.searchOpen = false
  requestScroll('note', noteId, undefined, spot)
}
function enter(entry: AtlasEntry): void {
  if (entry.kind === 'note') choose(entry.note.id)
  else if (current.value) readBody(current.value.id, entry.spot)
}
function detailLink(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const hash = target.closest('a[href]')?.getAttribute('href')
  if (hash?.startsWith('#') && !target.closest('.zmu-math')) {
    close()
    studio.panoramaOpen = false
    studio.searchOpen = false
  }
}

const query = ref(''),
  pickerOpen = ref(false),
  resultPage = ref(0),
  activeResult = ref(0)
const plain = new Map<string, { html: string; text: string }>()
function textFor(note: (typeof notes.value)[number]): string {
  const cached = plain.get(note.id)
  if (cached?.html === note.html) return cached.text
  const container = document.createElement('div')
  container.innerHTML = note.html
  const text = searchableText(container).replace(/\s+/g, ' ').trim()
  plain.set(note.id, { html: note.html, text })
  return text
}
const matches = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  if (!term) return notes.value
  return notes.value.filter(
    (note) =>
      `${note.label} ${note.typeLabel ?? ''}`.toLocaleLowerCase().includes(term) ||
      textFor(note).toLocaleLowerCase().includes(term)
  )
})
const results = computed(() => atlasPage(matches.value, resultPage.value, 12))
watch(query, () => {
  resultPage.value = 0
  activeResult.value = 0
  pickerOpen.value = true
})
function pick(id: string): void {
  choose(id, true)
  query.value = ''
  pickerOpen.value = false
  void nextTick().then(() => {
    pickerOpen.value = false
    focusNode.value?.focus({ preventScroll: true })
  })
}
function resultPageBy(delta: number): void {
  resultPage.value = Math.max(0, Math.min(results.value.pages - 1, results.value.page + delta))
  activeResult.value = 0
}
function searchKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    if (!pickerOpen.value) {
      pickerOpen.value = true
      activeResult.value = 0
    } else
      activeResult.value = Math.max(
        0,
        Math.min(results.value.entries.length - 1, activeResult.value + direction)
      )
    void nextTick().then(() =>
      dialog.value?.querySelector('.atlas-result.is-active')?.scrollIntoView({ block: 'nearest' })
    )
  } else if (event.key === 'Enter' && pickerOpen.value) {
    event.preventDefault()
    const result = results.value.entries[activeResult.value]
    if (result) pick(result.id)
  } else if (event.key === 'Escape' && pickerOpen.value) {
    event.preventDefault()
    event.stopPropagation()
    pickerOpen.value = false
  }
}
function key(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (
    event.target instanceof Node &&
    detail.value?.contains(event.target) &&
    ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
  )
    restoreToken++
  if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault()
    travel(event.key === 'ArrowLeft' ? -1 : 1)
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    field.value?.focus()
    pickerOpen.value = true
  }
}
function outsideSearch(event: PointerEvent): void {
  if (event.target instanceof Node && !searchBox.value?.contains(event.target))
    pickerOpen.value = false
}
onMounted(async () => {
  dialog.value?.showModal()
  resizeObserver = new ResizeObserver(() => {
    if (plot.value)
      capacity.value = Math.max(1, Math.min(4, Math.floor(plot.value.clientHeight / 92) - 1))
  })
  if (plot.value) resizeObserver.observe(plot.value)
  await nextTick()
  focusNode.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  alive = false
  studio.atlasOpen = false
  restoreToken++
  resizeObserver?.disconnect()
  dialog.value?.close()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
watch(
  () => bookState.payload?.path,
  (path) => {
    if (path !== originalPath) close()
  }
)
</script>

<template>
  <dialog
    ref="dialog"
    class="atlas-dialog"
    aria-labelledby="atlas-title"
    @close="closed"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
    @keydown="key"
    @pointerdown="outsideSearch"
  >
    <header class="atlas-head">
      <div>
        <span class="atlas-eyebrow">{{ bookState.book?.title || '当前文稿' }}</span>
        <h2 id="atlas-title">注释脉络<span>在字句之间，循迹而读。</span></h2>
      </div>
      <div class="atlas-head-actions">
        <span>{{ notes.length }} 则注释 · {{ index.edgeCount }} 条注内联系</span
        ><button class="studio-icon-button" aria-label="关闭注释脉络" @click="close">
          <StudioIcon name="close" />
        </button>
      </div>
    </header>
    <div class="atlas-toolbar">
      <div class="atlas-history">
        <button
          aria-label="脉络返回"
          title="返回 · Alt+←"
          :disabled="position <= 0"
          @click="travel(-1)"
        >
          <StudioIcon name="back" :size="17" /></button
        ><span>{{ history.length ? position + 1 : 0 }} / {{ history.length }}</span
        ><button
          aria-label="脉络前进"
          title="前进 · Alt+→"
          :disabled="position >= history.length - 1"
          @click="travel(1)"
        >
          <StudioIcon name="arrow" :size="17" />
        </button>
      </div>
      <div ref="searchBox" class="atlas-search">
        <StudioIcon name="search" :size="16" /><input
          ref="field"
          v-model="query"
          role="combobox"
          aria-label="查找注释脉络"
          aria-autocomplete="list"
          :aria-expanded="pickerOpen"
          aria-controls="atlas-results"
          :aria-activedescendant="
            pickerOpen && results.entries[activeResult] ? `atlas-result-${activeResult}` : undefined
          "
          placeholder="按标号、文字寻找一条注释…"
          @focus="pickerOpen = true"
          @keydown="searchKey"
        />
        <button aria-label="浏览全部注释" title="浏览全部注释" @click="pickerOpen = !pickerOpen">
          <StudioIcon name="toc" :size="17" />
        </button>
        <div v-if="pickerOpen" class="atlas-picker">
          <div class="atlas-picker-count">
            {{ results.total }} 则{{ query.trim() ? '匹配' : '注释' }} · {{ results.start }}–{{
              results.end
            }}
          </div>
          <div id="atlas-results" class="atlas-results" role="listbox" aria-label="可浏览的注释">
            <button
              v-for="(note, i) in results.entries"
              :id="`atlas-result-${i}`"
              :key="note.id"
              class="atlas-result"
              :class="{ 'is-active': i === activeResult }"
              role="option"
              :aria-selected="current?.id === note.id"
              @mouseenter="activeResult = i"
              @click="pick(note.id)"
            >
              <span
                ><strong>{{ note.displayMark }}</strong
                ><small v-if="note.typeLabel">{{ note.typeLabel }}</small
                ><small v-if="note.missing">缺少定义</small
                ><small v-if="note.orphan">未引用</small></span
              >
              <p>{{ textFor(note).slice(0, 94) || '这条引用尚无对应内容。' }}</p>
            </button>
            <p v-if="!results.total" class="atlas-no-results">没有找到这段文字。</p>
          </div>
          <div v-if="results.pages > 1" class="atlas-picker-pages">
            <button
              aria-label="上一页注释结果"
              :disabled="results.page === 0"
              @click="resultPageBy(-1)"
            >
              上一页</button
            ><span>{{ results.page + 1 }} / {{ results.pages }}</span
            ><button
              aria-label="下一页注释结果"
              :disabled="results.page + 1 === results.pages"
              @click="resultPageBy(1)"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
      <span class="atlas-scope">当前注释的直接联系</span>
    </div>
    <div v-if="current" class="atlas-body">
      <section class="atlas-map" aria-label="引用关系">
        <div class="atlas-lane-heads">
          <div v-for="lane in lanes" :key="lane.side" :class="lane.side">
            <strong>{{ lane.title }}</strong
            ><span>{{ lane.page.start }}–{{ lane.page.end }} / {{ lane.page.total }}</span>
            <div v-if="lane.page.pages > 1" class="atlas-lane-pager">
              <button
                :aria-label="`上一组${lane.title}`"
                :disabled="lane.page.page === 0"
                @click="pageBy(lane.side, -1)"
              >
                <StudioIcon name="back" :size="13" /></button
              ><button
                :aria-label="`下一组${lane.title}`"
                :disabled="lane.page.page + 1 === lane.page.pages"
                @click="pageBy(lane.side, 1)"
              >
                <StudioIcon name="arrow" :size="13" />
              </button>
            </div>
          </div>
        </div>
        <div ref="plot" class="atlas-plot">
          <svg
            viewBox="0 0 900 600"
            preserveAspectRatio="none"
            class="atlas-lines"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="atlas-arrow"
                viewBox="0 0 8 8"
                refX="4"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0 0L8 4L0 8" fill="currentColor" />
              </marker>
              <radialGradient id="atlas-halo">
                <stop stop-color="currentColor" stop-opacity=".12" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0" />
              </radialGradient>
            </defs>
            <ellipse
              cx="450"
              cy="300"
              rx="280"
              ry="290"
              fill="url(#atlas-halo)"
              class="atlas-halo"
            />
            <ellipse cx="450" cy="300" rx="174" ry="201" class="atlas-orbit" />
            <ellipse cx="450" cy="300" rx="120" ry="254" class="atlas-orbit is-crossed" />
            <template v-for="lane in lanes" :key="lane.side">
              <path
                v-for="(entry, i) in lane.page.entries"
                :key="entry.key"
                :d="curve(lane.side, i, lane.page.entries.length)"
                class="atlas-connection"
                :class="{
                  'is-body': entry.kind === 'body',
                  'is-lit': hovered === `${lane.side}:${entry.key}`
                }"
                marker-mid="url(#atlas-arrow)"
              />
            </template>
            <path
              v-if="neighborhood.selfReference"
              d="M435 250 C290 105 610 105 470 250"
              class="atlas-self-loop"
              marker-end="url(#atlas-arrow)"
            />
          </svg>
          <template v-for="lane in lanes" :key="lane.side"
            ><button
              v-for="(entry, i) in lane.page.entries"
              :key="entry.key"
              class="atlas-neighbor"
              :class="[lane.side, { 'is-body': entry.kind === 'body' }]"
              :style="{ top: `${ordinate(i, lane.page.entries.length)}%` }"
              :data-note-id="entry.kind === 'note' ? entry.note.id : undefined"
              :aria-label="
                entry.kind === 'body'
                  ? `定位正文 ${entry.title} 第${entry.occurrence}处`
                  : `${lane.side === 'incoming' ? '进入父注' : '进入子注'} ${entry.note.displayMark}`
              "
              :title="
                entry.kind === 'body'
                  ? `${entry.title} · 第${entry.occurrence}处`
                  : entry.note.label
              "
              @mouseenter="hovered = `${lane.side}:${entry.key}`"
              @mouseleave="hovered = ''"
              @focus="hovered = `${lane.side}:${entry.key}`"
              @blur="hovered = ''"
              @click="enter(entry)"
            >
              <span class="atlas-node-kind"
                ><StudioIcon :name="entry.kind === 'body' ? 'book' : 'notes'" :size="12" />{{
                  entry.kind === 'body' ? '正文入口' : entry.note.typeLabel || '注释'
                }}</span
              ><strong>{{ entry.kind === 'body' ? entry.title : entry.note.displayMark }}</strong
              ><small>{{
                entry.kind === 'body'
                  ? `第 ${entry.occurrence} 处 · 定位原句`
                  : entry.note.missing
                    ? '缺少定义'
                    : `${entry.note.refCount} 处引用`
              }}</small>
            </button></template
          >
          <button
            ref="focusNode"
            class="atlas-focus-node"
            :data-note-id="current.id"
            :aria-label="`正在浏览注释 ${current.displayMark}`"
            @click="detail?.focus({ preventScroll: true })"
          >
            <span>此刻，读到</span><strong>{{ current.displayMark }}</strong
            ><small>{{ current.typeLabel || `第 ${current.level} 层注释` }}</small
            ><i v-if="neighborhood.selfReference">自引用</i>
          </button>
          <p v-if="!incoming.total" class="atlas-lane-empty incoming">
            {{ current.orphan ? '尚无引用入口' : '没有其他来处' }}
          </p>
          <p v-if="!outgoing.total" class="atlas-lane-empty outgoing">这条思路在此展开</p>
        </div>
        <footer class="atlas-map-footer">
          <span><i class="atlas-legend-line is-body"></i>正文入口</span
          ><span><i class="atlas-legend-line"></i>注内引用</span
          ><span class="atlas-map-help">点击来处或支线，继续阅读</span>
        </footer>
      </section>
      <section class="atlas-reading" aria-label="脉络中的注释全文">
        <header>
          <span>这条注释</span><strong>{{ current.displayMark }}</strong
          ><small>{{ current.typeLabel }}</small>
        </header>
        <div
          ref="detail"
          class="atlas-detail"
          tabindex="0"
          aria-label="当前注释全文"
          @wheel="restoreToken++"
          @pointerdown="restoreToken++"
          @click="detailLink"
        >
          <NoteCard
            :key="current.id"
            :note="current"
            :active="false"
            :focused="false"
            :cycle="!!current.cycle"
            in-atlas
            @navigate="choose($event)"
            @locate="readBody"
          />
        </div>
        <footer>
          <span
            >{{ current.refCount }} 处引用{{
              current.missing ? ' · 缺少定义' : current.orphan ? ' · 未引用' : ''
            }}</span
          ><button class="studio-primary" @click="readNote">
            在旁注中阅读<StudioIcon name="arrow" :size="16" />
          </button>
        </footer>
      </section>
    </div>
    <div v-else class="atlas-empty">这篇文稿尚无可浏览的注释。</div>
  </dialog>
</template>

<style src="../styles/atlas.css"></style>
