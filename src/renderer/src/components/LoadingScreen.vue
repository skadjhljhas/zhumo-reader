<script setup lang="ts">
/**
 * 朱墨 ZhuMo —— 解析等待画面：书名 + 克制的进度感动效。
 */
import { computed } from 'vue'
import { bookState } from '../composables/useBook'

const title = computed(() => bookState.payload?.title || '未命名')
</script>

<template>
  <div class="loading-screen">
    <div class="ls-inner">
      <span class="ls-seal" aria-hidden="true">朱</span>
      <p class="ls-book">《{{ title }}》</p>
      <div class="ls-bar" role="progressbar" aria-label="正在解析">
        <div class="ls-bar-runner"></div>
      </div>
      <p class="ls-text">正在校勘排版…</p>
    </div>
  </div>
</template>

<style scoped>
.loading-screen {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ls-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

.ls-seal {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 24px;
  font-weight: 700;
  border-radius: 7px;
  animation: ls-breathe 2.2s var(--ease-out) infinite;
}

@keyframes ls-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(0.94);
    opacity: 0.82;
  }
}

.ls-book {
  margin: 6px 0 0;
  font-size: 17px;
  letter-spacing: 0.06em;
}

.ls-bar {
  width: 168px;
  height: 2px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}

.ls-bar-runner {
  width: 40%;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  animation: ls-run 1.4s var(--ease-out) infinite;
}

@keyframes ls-run {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(360%);
  }
}

.ls-text {
  margin: 0;
  font-size: 12.5px;
  letter-spacing: 0.22em;
  color: var(--text-3);
}
</style>
