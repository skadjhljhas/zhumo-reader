<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 单条注释卡。
 *
 * 层级视觉 = 左侧竖线（深→细/浅）+ 缩进 12px/层 + 字号阶梯（class 驱动，见 notes.css）。
 * 类型徽标显示作者实际用词（note.typeLabel：词表命中词或自定义前缀词，
 * 原样保留），小圆点 + 文字、色相随 type 枚举（type-* class 见 notes.css）；
 * 无类型词不渲染徽标。卡头显示作者标号（note.displayMark，T23）——与正文
 * 锚点 sup 同源，注释卡与锚点的对应由它建立。
 * T24（选项 A）：卡头仅「徽标 + 标号」两级呈现——灰字 label 退役（前缀
 * 已由徽标承载，不再重复），读屏 aria-label 同步改用徽标+标号组合。
 * 多引注释的「引用处」区（T23 引用地图，取代原 ×N 徽标）：正文条目
 * 「见于·〈章名〉」（同章多处加「第N处」）点击跳到该锚点；注内条目
 * 「注于·〈父注标号〉〈类型词〉」点击定位父注卡；当前阅读处条目高亮
 * （activeAnchor，随滚动切换）。missing 呈虚线空卡；cycle 带警告图标。
 * 纯嵌套注（无正文锚、有父注）从「无锚禁用」升级为可点击定位父注卡（T23）；
 * 仅纯孤儿（无正文锚且无父注）仍呈禁用态（T11）。
 * 注内嵌套引用（sup）点击 → emit navigate（侧栏内定位），卡体点击 →
 * emit locate（正文定位，最近锚点），引用处条目 → emit locate(带 spot)/navigate。
 */
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import type { NoteBodySpot, NoteParentSpot, NoteRecord } from '../../../shared/types'

const props = defineProps<{
  note: NoteRecord
  active: boolean
  focused: boolean
  cycle: boolean
  /** 当前活跃锚点身份（T23 引用地图高亮；来自 readerStore.activeAnchor） */
  activeAnchor?: { noteId: string; sectionId: string; order: number } | null
}>()

const emit = defineEmits<{
  (e: 'locate', noteId: string, spot?: { sectionId: string; order: number }): void
  (e: 'navigate', noteId: string): void
}>()

/** 徽标文案 = 作者实际用词（typeLabel，解析层已限长 ≤12 字符）。
 *  无类型词不渲染徽标（普通注不再显示「普通注」）；type 枚举仅决定配色。 */
const badgeLabel = computed(() => props.note.typeLabel?.trim() || '')
const levelClass = computed(() => `level-${Math.min(6, Math.max(1, props.note.level))}`)

/* T23 引用地图：锚点位置按 kind 分组（kind 缺失的旧产出按 body 兼容） */
const bodySpots = computed<NoteBodySpot[]>(() =>
  props.note.anchorSpots.filter((s): s is NoteBodySpot => s.kind !== 'note')
)
const noteSpots = computed<NoteParentSpot[]>(() =>
  props.note.anchorSpots.filter((s): s is NoteParentSpot => s.kind === 'note')
)
/** 有正文锚点（可发起正文跳转） */
const hasAnchor = computed(() => bodySpots.value.length > 0)
/** 第一个父注（纯嵌套注的卡片导航目标，T23） */
const firstParent = computed(() => noteSpots.value[0] ?? null)
/** 引用处区显示条件：多处引用或含注内引用（单正文引用时卡片本身就是它） */
const showSpots = computed(() => props.note.anchorSpots.length > 1 || noteSpots.value.length > 0)
const noAnchorTitle = computed(() =>
  firstParent.value
    ? '该注释仅被其他注释引用，点击定位到引用它的注释'
    : props.note.orphan
      ? '该注释未被引用，无正文锚点'
      : '该注释仅被其他注释引用，无正文锚点'
)

/** 正文条目文案：「见于·〈章名〉」，同章第 2+ 处加「·第N处」 */
function bodySpotText(spot: NoteBodySpot): string {
  const sameSection = bodySpots.value.filter((s) => s.sectionId === spot.sectionId)
  const occ = sameSection.filter((s) => s.order < spot.order).length + 1
  const title = spot.sectionTitle || spot.sectionId
  return sameSection.length > 1 ? `见于·${title}·第${occ}处` : `见于·${title}`
}

/** 正文条目是否为当前阅读处（T23：activeAnchor 匹配即高亮，随滚动切换） */
function isActiveBody(spot: NoteBodySpot): boolean {
  const a = props.activeAnchor
  return !!a && a.noteId === props.note.id && a.sectionId === spot.sectionId && a.order === spot.order
}

function onSpotClick(spot: NoteBodySpot): void {
  emit('locate', props.note.id, { sectionId: spot.sectionId, order: spot.order })
}

function onCardClick(ev: MouseEvent): void {
  const target = ev.target
  if (target instanceof Element) {
    const sup = target.closest('.zmu-ref')
    if (sup instanceof HTMLElement && sup.dataset.noteId) {
      // 注内引用：侧栏内跳转，不触发正文定位（无锚点卡也保留此交互）
      emit('navigate', sup.dataset.noteId)
      return
    }
  }
  if (hasAnchor.value) {
    emit('locate', props.note.id) // 默认：距阅读线最近的正文锚点（T11 不变）
  } else if (firstParent.value) {
    // 纯嵌套注（无正文锚点）：点击定位第一个父注卡（T23）
    emit('navigate', firstParent.value.parentNoteId)
  }
}

function onCardKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ' ') {
    if (!hasAnchor.value && !firstParent.value) return
    ev.preventDefault()
    if (hasAnchor.value) emit('locate', props.note.id)
    else if (firstParent.value) emit('navigate', firstParent.value.parentNoteId)
  }
}
</script>

<template>
  <article
    class="note-card"
    :class="[
      levelClass,
      `type-${note.type}`,
      {
        'is-active': active,
        'is-focused': focused,
        'is-missing': note.missing,
        'is-noanchor': !hasAnchor && !firstParent
      }
    ]"
    :data-note-id="note.id"
    :data-level="note.level"
    tabindex="0"
    :aria-label="badgeLabel ? `${badgeLabel} ${note.displayMark}` : note.displayMark"
    :aria-disabled="hasAnchor || firstParent ? undefined : 'true'"
    :title="hasAnchor || firstParent ? undefined : noAnchorTitle"
    @click="onCardClick"
    @keydown="onCardKeydown"
  >
    <header class="note-head">
      <span v-if="badgeLabel" class="note-type-badge" :title="badgeLabel">{{ badgeLabel }}</span>
      <span class="note-mark" :title="note.displayMark">{{ note.displayMark }}</span>
      <span v-if="cycle" class="note-state-icon" title="注释引用存在循环">
        <AppIcon name="warning" :size="13" />
      </span>
    </header>
    <div v-if="!note.missing" class="zmu-note-body" v-html="note.html"></div>
    <div v-else class="zmu-note-body">未找到此注释的定义。</div>
    <footer v-if="showSpots" class="note-spots">
      <span class="note-spots-title">引用处</span>
      <ul class="note-spots-list">
        <li v-for="s in bodySpots" :key="`b-${s.order}`">
          <button
            class="note-spot"
            :class="{ 'is-active': isActiveBody(s) }"
            type="button"
            :title="bodySpotText(s)"
            @click.stop="onSpotClick(s)"
            @keydown.stop
          >
            {{ bodySpotText(s) }}
          </button>
        </li>
        <li v-for="(s, i) in noteSpots" :key="`n-${i}`">
          <button
            class="note-spot is-note"
            type="button"
            :title="`定位到引用本注的注释：${s.parentDisplayMark || s.parentNoteId}`"
            @click.stop="emit('navigate', s.parentNoteId)"
            @keydown.stop
          >
            注于·{{ s.parentDisplayMark || s.parentNoteId }}<span
              v-if="s.parentTypeLabel"
              class="note-spot-type"
              >{{ s.parentTypeLabel }}</span
            >
          </button>
        </li>
      </ul>
    </footer>
  </article>
</template>
