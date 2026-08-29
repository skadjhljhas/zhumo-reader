<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 内联 SVG 线性图标集（1.5px stroke，round 线帽）。
 * 自己绘制的极简图标，不用 emoji、不引图标库。
 */
import { computed } from 'vue'

export type IconName =
  | 'toc'
  | 'sidebar'
  | 'settings'
  | 'open'
  | 'close'
  | 'warning'
  | 'trash'
  | 'chevron'
  | 'book'
  | 'quote'
  | 'home'

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 18 })

const PATHS: Record<IconName, string> = {
  // 目录：三条长短不一的横线
  toc: 'M4 6.5h16M4 12h11M4 17.5h14',
  // 侧栏：外框 + 右分栏线
  sidebar:
    'M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM14.5 5.5v13',
  // 设置：双滑杆
  settings: 'M4 8.2h16M4 15.8h16M9.2 5.7v5M15.4 13.3v5',
  // 打开：书页
  open: 'M12 6.6C10.2 5.1 7.7 4.6 4.5 4.6v13.4c3.2 0 5.7.5 7.5 2 1.8-1.5 4.3-2 7.5-2V4.6c-3.2 0-5.7.5-7.5 2zM12 6.6V20',
  // 关闭
  close: 'M6 6l12 12M18 6L6 18',
  // 警告
  warning: 'M12 4.2 21 19.2H3zM12 10v4.2M12 16.9h.01',
  // 移除（回收站）
  trash:
    'M5 7h14M9.6 7V5.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1V7M7.2 7l.7 11.6a1.6 1.6 0 0 0 1.6 1.5h5a1.6 1.6 0 0 0 1.6-1.5L16.8 7M10.2 10.6v5.6M13.8 10.6v5.6',
  // 展开/收起
  chevron: 'M6 9.5l6 6 6-6',
  // 书（最近列表）
  book: 'M6 4.5h9.5a3 3 0 0 1 3 3v12H9a3 3 0 0 0-3 3zM6 4.5v15M6 19.5a3 3 0 0 1 3-3h9.5',
  // 引文/注释
  quote:
    'M5 16.5c-1 0-1.8-.9-1.8-2.1 0-3 1.7-5.4 4.3-6.4l.6 1c-1.7.8-2.7 2.2-2.9 3.5.2-.1.5-.2.8-.2 1.2 0 2.1 1 2.1 2.1S7.2 16.5 6 16.5zM14 16.5c-1 0-1.8-.9-1.8-2.1 0-3 1.7-5.4 4.3-6.4l.6 1c-1.7.8-2.7 2.2-2.9 3.5.2-.1.5-.2.8-.2 1.2 0 2.1 1 2.1 2.1s-.9 2.1-2.1 2.1z',
  // 返回首页
  home: 'M4.5 11 12 4.5 19.5 11M6.5 9.5V19h11V9.5M10.2 19v-5h3.6v5'
}

const d = computed(() => PATHS[props.name])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="d" />
  </svg>
</template>
