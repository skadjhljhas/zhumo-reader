<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  more: 'M4.5 12h1 M11.5 12h1 M18.5 12h1',
  new: 'M14 3H5v18h14V8z M14 3v5h5 M8 14h8 M12 10v8',
  export: 'M5 15v6h14v-6 M12 3v13 M7 11l5 5 5-5',
  panorama: 'M2 7l5-3 5 3 5-3 5 3v14l-5-3-5 3-5-3-5 3z M7 4v14 M12 7v14 M17 4v14',
  book: 'M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v15h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3z M12 6v15',
  edit: 'm15 4 5 5 M4 20l4-1L21 6a2 2 0 0 0-5-5L3 14l-1 7z',
  palette:
    'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8z M7 10h.01 M10 6h.01 M15 6h.01 M18 10h.01',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  open: 'M3 7V4h7l2 3h8v3 M2 10h20l-3 10H5z',
  close: 'm6 6 12 12 M6 18 18 6',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  notes: 'M4 4h16v13H9l-5 4z M8 8h8 M8 12h5',
  arrow: 'M5 12h14 m-6-6 6 6-6 6',
  back: 'M19 12H5 m6-6-6 6 6 6',
  pin: 'm8 3 8 0-1 6 3 3v2H6v-2l3-3z M12 14v8',
  focus: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M9 12h6',
  check: 'm5 12 4 4L19 6',
  save: 'M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  toc: 'M9 5h12 M9 12h12 M9 19h12 M3 5h.01 M3 12h.01 M3 19h.01',
  sun: 'M12 2v2 M12 20v2 M2 12h2 M20 12h2 m-3-7 2-2 M5 19l2-2 M5 5l2 2 m10 10 2 2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  layers: 'm12 2 10 6-10 6L2 8z M2 12l10 6 10-6 M2 16l10 6 10-6',
  undo: 'M3 4v6h6 M3 10a9 9 0 1 1 1 8',
  chevron: 'm9 5 7 7-7 7',
  copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
  branches:
    'M9 12h6 M5 5l4 7-4 7 M15 12l4-7 M15 12l4 7 M5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M19 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4'
}
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
    <path :d="paths[name] || paths.book" />
  </svg>
</template>
