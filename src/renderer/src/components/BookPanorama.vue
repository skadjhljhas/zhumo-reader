<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import StudioIcon from './StudioIcon.vue'
import { bookState } from '../composables/useBook'
import { studio, openNoteAtlas } from '../composables/useStudio'
import { uiState } from '../composables/useSettings'
import {
  pinTocItem,
  readerState,
  requestScroll,
  requestSearchLanding
} from '../composables/readerStore'
import { findBookHash } from '../composables/bookResources'
import { panoramaChapters, panoramaPosition, panoramaWindow } from '../composables/bookPanorama'
import { createPanoramaProjection, type ChapterMeasure } from '../composables/panoramaProjection'
import { atlasPage } from '../composables/noteAtlas'
import { closeNotePeek } from '../composables/notePeek'

const book = bookState.book!
const originalPath = bookState.payload?.path
const opener = document.activeElement as HTMLElement | null
const chapters = panoramaChapters(book)
const byId = new Map(chapters.map((chapter, index) => [chapter.id, { chapter, index }]))
const notes = new Map(book.notes.map((note) => [note.id, note]))
const projection = createPanoramaProjection(book)
const origin = panoramaPosition(
  chapters,
  readerState.pinnedTocId || readerState.currentHeadingId,
  readerState.currentSectionId
)
const selected = ref(origin)
const current = computed(() => chapters[selected.value])
const preview = computed(() => current.value && projection.preview(current.value))
const measures = shallowRef(new Map<string, ChapterMeasure>())
const measuring = ref(true)
const maxChars = computed(() =>
  [...measures.value.values()].reduce((peak, item) => Math.max(peak, item.chars), 1)
)
const currentMeasure = computed(() => measures.value.get(current.value?.id ?? ''))
const count = (value: number): string => value.toLocaleString('zh-CN')
const number = (value: number): string => String(value + 1).padStart(2, '0')
const dialog = ref<HTMLDialogElement>(),
  field = ref<HTMLInputElement>(),
  stage = ref<HTMLElement>(),
  detail = ref<HTMLElement>()
const radius = ref(7)
const sheets = computed(() => panoramaWindow(chapters, selected.value, radius.value))
const query = ref(''),
  pickerOpen = ref(false),
  resultPage = ref(0),
  activeResult = ref(0),
  notePage = ref(0),
  childPage = ref(0)
const matches = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return chapters.filter((chapter) =>
    [chapter.title, ...chapter.ancestors.map((id) => byId.get(id)!.chapter.title)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(term)
  )
})
const results = computed(() => atlasPage(matches.value, resultPage.value, 12))
const noteEntries = computed(() => atlasPage(current.value?.noteIds ?? [], notePage.value, 6))
const children = computed(() => atlasPage(current.value?.children ?? [], childPage.value, 6))
function close(): void {
  dialog.value?.close()
  studio.panoramaOpen = false
}
function closed(): void {
  if (alive) studio.panoramaOpen = false
}
function choose(index: number, focus = false): void {
  selected.value = Math.max(0, Math.min(chapters.length - 1, index))
  pickerOpen.value = false
  notePage.value = childPage.value = 0
  if (detail.value) detail.value.scrollTop = 0
  if (focus) void nextTick().then(() => stage.value?.focus({ preventScroll: true }))
}
function pick(id: string): void {
  choose(byId.get(id)!.index, true)
}
function clearSearch(): void {
  query.value = ''
  field.value?.focus()
}
function pageResults(delta: number): void {
  resultPage.value += delta
  activeResult.value = 0
}
async function read(): Promise<void> {
  const chapter = current.value
  if (!chapter) return
  close()
  if (window.innerWidth < 1120) uiState.tocOpen = false
  await nextTick()
  if (chapter.heading) {
    const item = chapter.heading
    pinTocItem(item.id, item.sectionId, item.title)
    requestScroll('section', item.sectionId, item.title, undefined, item.id)
  } else if (chapter.slices[0]) requestSearchLanding(chapter.slices[0].sectionId, 0)
}
function note(id: string): void {
  pickerOpen.value = false
  openNoteAtlas(id)
}
function detailClick(event: MouseEvent): void {
  if (!(event.target instanceof Element) || event.defaultPrevented) return
  if (window.getSelection()?.toString()) return
  const reference = event.target.closest<HTMLElement>('.zmu-ref')
  if (reference?.dataset.noteId && notes.has(reference.dataset.noteId)) {
    event.preventDefault()
    event.stopPropagation()
    note(reference.dataset.noteId)
    return
  }
  const anchor = event.target.closest('a[href]')
  const hash = anchor?.getAttribute('href') ?? ''
  if (hash.startsWith('#') && !anchor?.closest('.zmu-math')) {
    const target = findBookHash(book, hash)
    if (target) {
      event.preventDefault()
      event.stopPropagation()
      close()
      requestSearchLanding(target.sectionId, target.blockIndex)
    }
  }
}
function detailKey(event: KeyboardEvent): void {
  if (!['Enter', ' '].includes(event.key) || !(event.target instanceof HTMLElement)) return
  const reference = event.target.closest<HTMLElement>('.zmu-ref')
  if (reference?.dataset.noteId) {
    event.preventDefault()
    event.stopPropagation()
    note(reference.dataset.noteId)
  }
}
function stageKey(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'ArrowLeft') choose(selected.value - 1, true)
  else if (event.key === 'ArrowRight') choose(selected.value + 1, true)
  else if (event.key === 'Home') choose(0, true)
  else if (event.key === 'End') choose(chapters.length - 1, true)
  else return
  event.preventDefault()
}
function searchKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    pickerOpen.value = true
    activeResult.value = Math.max(
      0,
      Math.min(
        results.value.entries.length - 1,
        activeResult.value + (event.key === 'ArrowDown' ? 1 : -1)
      )
    )
    void nextTick().then(() =>
      dialog.value
        ?.querySelector('.panorama-result.is-active')
        ?.scrollIntoView({ block: 'nearest' })
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    field.value?.focus()
    pickerOpen.value = true
  }
}
function move(event: PointerEvent): void {
  if (!stage.value || event.pointerType !== 'mouse' || studio.effectsMode !== 'full') return
  const rect = stage.value.getBoundingClientRect()
  stage.value.style.setProperty(
    '--pointer-x',
    `${((event.clientX - rect.left) / rect.width) * 100}%`
  )
  stage.value.style.setProperty(
    '--pointer-y',
    `${((event.clientY - rect.top) / rect.height) * 100}%`
  )
  stage.value.style.setProperty(
    '--tilt',
    `${((event.clientX - rect.left) / rect.width - 0.5) * 5}deg`
  )
}
function resetPointer(): void {
  stage.value?.style.removeProperty('--tilt')
  stage.value?.style.removeProperty('--pointer-x')
  stage.value?.style.removeProperty('--pointer-y')
}
let alive = true,
observer: ResizeObserver | undefined
let relaxTimer = 0
let skinWatcher: MutationObserver | undefined
async function measureBook(): Promise<void> {
  const values = new Map<string, ChapterMeasure>()
  const ordered = current.value
    ? [current.value, ...chapters.filter((chapter) => chapter !== current.value)]
    : []
  let start = performance.now()
  for (const chapter of ordered) {
    if (!alive) return
    values.set(chapter.id, projection.measure(chapter))
    if (performance.now() - start > 8) {
      measures.value = new Map(values)
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      start = performance.now()
    }
  }
  if (alive) {
    measures.value = values
    measuring.value = false
  }
}
watch(query, () => {
  resultPage.value = activeResult.value = 0
  pickerOpen.value = true
})
watch(() => studio.effectsMode, resetPointer)
watch(selected, scheduleRelax)
watch(
  () => bookState.book,
  (value) => {
    if (value !== book) close()
  }
)
watch(
  () => bookState.payload?.path,
  (path) => {
    if (path !== originalPath) close()
  }
)
/* 遮挡松绑：卡片按 data-level 分级尺寸，外层小卡的包围盒可能被内层大卡完全盖住。
   实测包围盒后把被含卡片沿瀑布方向平移，直到它的边缘露出内层卡，保证每张都可见可点。 */
async function relaxPass(pass: number): Promise<void> {
  const host = stage.value
  if (!host || !alive) return
  const els = [...host.querySelectorAll<HTMLElement>(".panorama-sheet")]
  if (!els.length) return
  const byD = new Map<number, HTMLElement>()
  for (const el of els) byD.set(Math.round(Number(el.style.getPropertyValue("--d"))), el)
  const dir = parseFloat(getComputedStyle(host).getPropertyValue("--sheet-drop")) < 0 ? -1 : 1
  if (pass === 0) {
    host.classList.add("is-relaxing")
    for (const el of els) el.style.setProperty("--nudge", "0px")
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (!alive) return
  let changed = false
  for (const side of [-1, 1]) {
    for (let d = side; byD.has(d) && byD.has(d - side); d += side) {
      const el = byD.get(d)!
      const inner = byD.get(d - side)!
      const box = el.getBoundingClientRect()
      const base = inner.getBoundingClientRect()
      const aside = side < 0 ? box.left < base.left - 8 : box.right > base.right + 8
      const aedge = dir > 0 ? box.bottom > base.bottom + 14 : box.top < base.top - 14
      if (aside || aedge) continue
      const need = dir > 0 ? base.bottom + 20 - box.bottom : box.top - base.top + 20
      const cur = parseFloat(el.style.getPropertyValue("--nudge")) || 0
      el.style.setProperty("--nudge", (cur + (need > 4 ? need : 16) * dir).toFixed(1) + "px")
      changed = true
    }
  }
  if (changed && pass < 3) void relaxPass(pass + 1)
  else host.classList.remove("is-relaxing")
}
function scheduleRelax(): void {
  window.clearTimeout(relaxTimer)
  relaxTimer = window.setTimeout(() => void relaxPass(0), 760)
}
onMounted(async () => {
  closeNotePeek()
  // 长卷是模态视图：打开时收起目录抽屉，避免关闭长卷后目录突然弹出
  uiState.tocOpen = false
  dialog.value?.showModal()
  observer = new ResizeObserver(() => {
    radius.value = (stage.value?.clientWidth ?? 0) < 600 ? 5 : 7
    scheduleRelax()
  })
  if (stage.value) observer.observe(stage.value)
  stage.value?.focus({ preventScroll: true })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (alive) void measureBook()
  skinWatcher = new MutationObserver(scheduleRelax)
  skinWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-skin"]
  })
  scheduleRelax()
})
onBeforeUnmount(() => {
  alive = false
  window.clearTimeout(relaxTimer)
  skinWatcher?.disconnect()
  observer?.disconnect()
  dialog.value?.close()
  studio.panoramaOpen = false
  if (opener?.isConnected) opener.focus({ preventScroll: true })
})
</script>

<template>
  <dialog
    ref="dialog"
    class="panorama-dialog"
    aria-labelledby="panorama-title"
    @close="closed"
    @cancel.prevent="close"
    @keydown="key"
    @pointerdown="!($event.target as Element).closest('.panorama-search') && (pickerOpen = false)"
  >
    <header class="panorama-head">
      <div>
        <span class="panorama-eyebrow">{{ book.title || '当前文稿' }}</span>
        <h2 id="panorama-title">全书长卷 <span>在此刻，看见远处。</span></h2>
      </div>
      <div class="panorama-head-actions">
        <span>{{ count(chapters.length) }} 处篇章 · {{ count(book.notes.length) }} 则注释</span>
      </div>
    </header>
    <div class="panorama-toolbar">
      <div class="panorama-search">
        <StudioIcon name="search" :size="17" />
        <input
          ref="field"
          v-model="query"
          role="combobox"
          aria-label="查找长卷章节"
          :aria-expanded="pickerOpen"
          aria-controls="panorama-results"
          :aria-activedescendant="
            pickerOpen && results.entries.length ? `panorama-result-${activeResult}` : undefined
          "
          placeholder="查找章节，或沿着长卷漫游"
          @click="pickerOpen = true"
          @keydown="searchKey"
        />
        <button v-if="query" aria-label="清空章节搜索" @click="clearSearch">
          <StudioIcon name="close" :size="14" />
        </button>
        <div v-if="pickerOpen" class="panorama-picker">
          <div class="panorama-picker-caption">
            {{
              results.total
                ? `${results.start}–${results.end} / ${count(results.total)} 处篇章`
                : '没有匹配的章节'
            }}
          </div>
          <div id="panorama-results" role="listbox" aria-label="长卷章节结果">
            <button
              v-for="(chapter, i) in results.entries"
              :id="`panorama-result-${i}`"
              :key="chapter.id"
              class="panorama-result"
              :class="{ 'is-active': activeResult === i }"
              role="option"
              :aria-selected="activeResult === i"
              @click="pick(chapter.id)"
            >
              <span>{{ number(byId.get(chapter.id)!.index) }}</span
              ><strong>{{ chapter.title }}</strong>
              <small>{{
                chapter.ancestors.map((id) => byId.get(id)!.chapter.title).join(' / ') || '卷中'
              }}</small>
            </button>
          </div>
          <footer>
            <button
              aria-label="上一页章节结果"
              :disabled="results.page === 0"
              @click="pageResults(-1)"
            >
              上一页
            </button>
            <span>{{ results.page + 1 }} / {{ results.pages }}</span>
            <button
              aria-label="下一页章节结果"
              :disabled="results.page >= results.pages - 1"
              @click="pageResults(1)"
            >
              下一页
            </button>
          </footer>
        </div>
      </div>
    </div>
    <div v-if="current" class="panorama-content">
      <section class="panorama-landscape" aria-label="篇章空间">
        <div
          ref="stage"
          class="panorama-stage"
          tabindex="0"
          role="group"
          aria-label="浏览篇章，左右方向键切换，Home 到卷首，End 到卷末"
          @keydown="stageKey"
          @pointermove="move"
          @pointerleave="resetPointer"
        >
          <div class="panorama-aura" aria-hidden="true"></div>
          <div class="panorama-light" aria-hidden="true"></div>
          <svg
            class="panorama-orbits"
            viewBox="0 0 800 480"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <ellipse cx="400" cy="252" rx="357" ry="125" />
            <ellipse cx="400" cy="252" rx="314" ry="176" />
            <path d="M-50 400 Q390 500 850 72" />
            <path d="M-30 113 Q360 420 830 375" />
          </svg>
          <div class="panorama-sheets">
            <button
              v-for="chapter in sheets"
              :key="chapter.id"
              class="panorama-sheet"
              :class="{
                'is-selected': chapter.id === current.id,
                'is-origin': byId.get(chapter.id)!.index === origin
              }"
              :data-level="chapter.level"
              :data-chapter-id="chapter.id"
              :aria-label="`浏览篇章 ${number(byId.get(chapter.id)!.index)} ${chapter.title}`"
              :aria-pressed="chapter.id === current.id"
              tabindex="-1"
              :style="{
                '--d': byId.get(chapter.id)!.index - selected,
                '--distance': Math.abs(byId.get(chapter.id)!.index - selected),
                '--length': (measures.get(chapter.id)?.chars ?? 0) / maxChars,
                zIndex: 10 - Math.abs(byId.get(chapter.id)!.index - selected)
              }"
              @click="pick(chapter.id)"
            >
              <span class="panorama-sheet-edge" aria-hidden="true"></span>
              <span class="panorama-sheet-top"
                ><span>{{ number(byId.get(chapter.id)!.index) }}</span
                ><span>{{
                  chapter.heading ? ['篇', '节', '目'][chapter.level - 1] : '卷首'
                }}</span></span
              >
              <strong>{{ chapter.title }}</strong>
              <span class="panorama-sheet-text">{{
                measures.get(chapter.id)?.excerpt ||
                (chapter.children.length ? '篇章在此展开' : '留白亦在卷中')
              }}</span>
              <span class="panorama-sheet-bottom"
                ><span>{{ count(chapter.noteIds.length) }} 则旁注</span
                ><i v-if="byId.get(chapter.id)!.index === origin">你在这里</i></span
              >
              <span class="panorama-measure" aria-hidden="true"><i></i></span>
              <span class="panorama-note-stars" aria-hidden="true"
                ><i v-for="n in Math.min(9, chapter.noteIds.length)" :key="n"></i
              ></span>
            </button>
          </div>
        </div>
      </section>
      <section class="panorama-reading" aria-label="篇章原文预览">
        <div ref="detail" class="panorama-detail">
          <nav v-if="current.ancestors.length" class="panorama-breadcrumbs" aria-label="上级篇章">
            <button v-for="id in current.ancestors" :key="id" @click="pick(id)">
              {{ byId.get(id)!.chapter.title }}
            </button>
          </nav>
          <div class="panorama-reading-kicker">
            {{ number(selected) }} / 原文起首 <span v-if="selected === origin">当前阅读处</span>
          </div>
          <h3>{{ current.title }}</h3>
          <p class="panorama-stats">
            {{ currentMeasure ? count(currentMeasure.chars) : '…' }} 正文字符 ·
            {{ count(current.noteIds.length) }} 则旁注 · {{ count(current.references) }} 处引用
          </p>
          <div
            class="panorama-excerpt section-body"
            @click="detailClick"
            @keydown="detailKey"
            v-html="preview?.html"
          ></div>
          <p v-if="preview?.abbreviated" class="panorama-excerpt-end">
            文字仍在展开，进入正文继续阅读。
          </p>
          <div v-if="children.total" class="panorama-children">
            <h4>由此展开</h4>
            <button v-for="id in children.entries" :key="id" @click="pick(id)">
              <span>{{ number(byId.get(id)!.index) }}</span
              >{{ byId.get(id)!.chapter.title }}<StudioIcon name="arrow" :size="14" />
            </button>
            <div v-if="children.pages > 1" class="panorama-pagination">
              <button
                aria-label="上一组下级篇章"
                :disabled="children.page === 0"
                @click="childPage--"
              >
                上一组</button
              ><span>{{ children.start }}–{{ children.end }} / {{ children.total }}</span
              ><button
                aria-label="下一组下级篇章"
                :disabled="children.page >= children.pages - 1"
                @click="childPage++"
              >
                下一组
              </button>
            </div>
          </div>
          <div v-if="noteEntries.total" class="panorama-notes">
            <h4>旁注</h4>
            <div>
              <button
                v-for="id in noteEntries.entries"
                :key="id"
                :aria-label="`从长卷查看注释 ${notes.get(id)!.displayMark}`"
                @click="note(id)"
              >
                {{ notes.get(id)!.displayMark }}<StudioIcon name="branches" :size="13" />
              </button>
            </div>
            <div v-if="noteEntries.pages > 1" class="panorama-pagination">
              <button
                aria-label="上一组长卷注释"
                :disabled="noteEntries.page === 0"
                @click="notePage--"
              >
                上一组</button
              ><span>{{ noteEntries.start }}–{{ noteEntries.end }} / {{ noteEntries.total }}</span
              ><button
                aria-label="下一组长卷注释"
                :disabled="noteEntries.page >= noteEntries.pages - 1"
                @click="notePage++"
              >
                下一组
              </button>
            </div>
          </div>
        </div>
        <footer class="panorama-footer-actions">
          <button @click="choose(origin, true)">回到当前阅读处</button>
          <button class="studio-primary" @click="read">
            从此处阅读<StudioIcon name="arrow" :size="16" />
          </button>
        </footer>
      </section>
    </div>
    <p v-else class="panorama-empty">这份文稿尚无正文。</p>
  </dialog>
</template>

<style src="../styles/panorama.css"></style>
