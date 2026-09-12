<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { bookState } from '../composables/useBook'
import { documentSession } from '../composables/documentSession'
import { navigateTextAddress } from '../composables/textNavigation'
import {
  tidalMemory,
  tidalExcerpt,
  clearTidalPlaces,
  undoTidalClear,
  setTidalRecording
} from '../composables/tidalMemory'
import { tidalPlaceKey, type TidalPlace } from '../composables/tidalPlaces'
import TidalMemoryChart from './TidalMemoryChart.vue'
import TidalAfterlight from './TidalAfterlight.vue'
import StudioIcon from './StudioIcon.vue'
import { studio } from '../composables/useStudio'

const dialog = ref<HTMLDialogElement>()
let alive = true
let navigation: AbortController | undefined
const pending = ref(false)
const shown = ref(80)
const allPlaces = computed(() => [...tidalMemory.places].reverse())
const places = computed(() => allPlaces.value.slice(0, shown.value))
const selected = computed(
  () =>
    tidalMemory.places.find((place) => tidalPlaceKey(place) === tidalMemory.selected) ??
    tidalMemory.places.at(-1)
)
const selectedKey = computed(() => (selected.value ? tidalPlaceKey(selected.value) : ''))
const excerpt = computed(() => (selected.value ? tidalExcerpt(selected.value) : undefined))
const selectedIndex = computed(() =>
  Math.max(
    0,
    tidalMemory.places.findIndex((place) => tidalPlaceKey(place) === selectedKey.value)
  )
)
function choose(place: TidalPlace): void {
  tidalMemory.selected = tidalPlaceKey(place)
  tidalMemory.error = ''
}
function when(place: TidalPlace): string {
  return new Date(place.at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}
function close(): void {
  tidalMemory.open = false
  if (dialog.value?.open) dialog.value.close()
}
async function go(): Promise<void> {
  const place = selected.value,
    book = bookState.book,
    source = documentSession.source
  if (
    !place ||
    !book ||
    !excerpt.value ||
    bookState.status !== 'reading' ||
    !tidalMemory.ready ||
    documentSession.mode !== 'read'
  )
    return
  navigation?.abort()
  const own = new AbortController()
  navigation = own
  pending.value = true
  close()
  await nextTick()
  try {
    const result = await navigateTextAddress(place.address, { signal: own.signal })
    if (
      !alive ||
      navigation !== own ||
      own.signal.aborted ||
      bookState.book !== book ||
      bookState.status !== 'reading' ||
      !tidalMemory.ready ||
      documentSession.source !== source ||
      documentSession.mode !== 'read'
    )
      return
    if (result.status === 'landed' || result.status === 'cancelled') return
    tidalMemory.error =
      result.status === 'timeout'
        ? '这次没有完成定位。可以重试，或从全文检索寻找原句。'
        : result.status === 'version-changed'
          ? '文稿已经更新，请重新停留，再回到这一句。'
          : '这处原句的位置暂时无法核对，请从全文检索重新寻找。'
    navigation = undefined
    tidalMemory.open = true
  } catch {
    if (
      alive &&
      navigation === own &&
      !own.signal.aborted &&
      bookState.book === book &&
      bookState.status === 'reading' &&
      tidalMemory.ready &&
      documentSession.source === source &&
      documentSession.mode === 'read'
    ) {
      tidalMemory.error = '这次没有完成定位，请稍后重试。'
      navigation = undefined
      tidalMemory.open = true
    }
  } finally {
    if (navigation === own) navigation = undefined
    if (!navigation) pending.value = false
  }
}
function key(event: KeyboardEvent): void {
  if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const at = allPlaces.value.findIndex((place) => tidalPlaceKey(place) === selectedKey.value)
  const next =
    allPlaces.value[
      Math.max(0, Math.min(allPlaces.value.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1)))
    ]
  if (next) choose(next)
}
watch(
  () => tidalMemory.open,
  async (open) => {
    await nextTick()
    if (!alive || tidalMemory.open !== open) return
    if (open) {
      navigation?.abort()
      navigation = undefined
      pending.value = false
      dialog.value?.showModal()
    } else dialog.value?.close()
  }
)
watch(
  () => documentSession.mode,
  (mode) => {
    if (mode !== 'read') {
      navigation?.abort()
      close()
    }
  }
)
watch(
  () => bookState.status,
  (status) => {
    if (status !== 'reading') {
      navigation?.abort()
      close()
    }
  }
)
onBeforeUnmount(() => {
  alive = false
  navigation?.abort()
  close()
})
</script>
<template>
  <dialog
    ref="dialog"
    class="tidal-memory-dialog"
    aria-labelledby="tidal-memory-title"
    @cancel.prevent="close"
    @close="!dialog?.open && close()"
    @keydown="key"
  >
    <header class="tidal-memory-head">
      <div>
        <span>WHERE YOUR READING RETURNS</span>
        <h2 id="tidal-memory-title">回声</h2>
      </div>
      <p>走远之后，仍能回到停过的那一句。</p>
      <button class="studio-icon-button" aria-label="关闭回声" @click="close">
        <StudioIcon name="close" />
      </button>
    </header>
    <div class="tidal-memory-content">
      <aside class="tidal-memory-index">
        <TidalMemoryChart :places="tidalMemory.places" :selected="selectedKey" @choose="choose" />
        <p class="tidal-chart-caption">字句的位置、停留与重访，共同形成星图。</p>
        <div class="tidal-place-list" aria-label="停留的字句">
          <button
            v-for="place in places"
            :key="tidalPlaceKey(place)"
            class="tidal-place"
            :class="{ active: tidalPlaceKey(place) === selectedKey }"
            :aria-pressed="tidalPlaceKey(place) === selectedKey"
            @click="choose(place)"
          >
            <span class="tidal-place-word">{{ place.address.match.text }}</span>
            <span class="tidal-place-title">{{ place.title }}</span>
            <small>{{ when(place) }} · {{ place.visits }} 次停留</small>
          </button>
          <button v-if="shown < allPlaces.length" class="tidal-place" @click="shown += 80">
            继续查看更早的回声
          </button>
        </div>
      </aside>
      <section class="tidal-place-reading">
        <TidalAfterlight
          v-if="tidalMemory.open && selected && studio.themeId === 'chaosheng'"
          :count="tidalMemory.places.length"
          :selected="selectedIndex"
        />
        <div
          v-if="tidalMemory.open && selected && studio.themeId === 'lucent'"
          class="echo-prism-afterlight"
          aria-hidden="true"
        ></div>
        <template v-if="selected">
          <div class="tidal-place-kicker">
            <span>{{
              selected.address.origin.kind === 'section' ? '正文中的来处' : '旁注中的来处'
            }}</span
            ><small>{{ when(selected) }}</small>
          </div>
          <h3>{{ selected.title }}</h3>
          <blockquote class="tidal-place-context">
            <span>{{ excerpt?.before ?? '' }}</span
            ><mark>{{ selected.address.match.text }}</mark
            ><span>{{ excerpt?.after ?? '' }}</span>
          </blockquote>
          <p class="tidal-place-note">
            {{
              excerpt
                ? '原句仍在。点击返回，阅读会落在这次停留的位置。'
                : '这处原句暂时无法核对，请从全文检索重新寻找。'
            }}
          </p>
          <p v-if="tidalMemory.error" role="alert" class="tidal-memory-error">
            {{ tidalMemory.error }}
          </p>
          <button
            class="studio-primary tidal-place-return"
            :disabled="pending || !excerpt"
            @click="go"
          >
            回到这句 <StudioIcon name="arrow" :size="16" />
          </button>
        </template>
        <div v-else class="tidal-memory-empty">
          <span aria-hidden="true">∿</span>
          <h3>留一点时间给文字。</h3>
          <p>在丰沛光影中，让光标在一个词上稍作停留。页边会留下它的来处。</p>
          <p>先读，后来再回来。</p>
          <p v-if="tidalMemory.error" role="alert" class="tidal-memory-error">
            {{ tidalMemory.error }}
          </p>
        </div>
      </section>
    </div>
    <footer class="tidal-memory-footer">
      <label
        ><input
          type="checkbox"
          :checked="tidalMemory.enabled"
          @change="setTidalRecording(($event.target as HTMLInputElement).checked)"
        />记住停留</label
      >
      <span
        >{{ tidalMemory.local ? '保存在本机' : '仅本次打开' }} · 本书
        {{ tidalMemory.places.length }} 处</span
      >
      <button v-if="tidalMemory.undo" @click="undoTidalClear">撤销清除</button>
      <button :disabled="!tidalMemory.places.length" @click="clearTidalPlaces">清除本书停留</button>
    </footer>
  </dialog>
</template>
