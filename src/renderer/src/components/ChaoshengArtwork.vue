<script setup lang="ts">
import { useId } from 'vue'
const id = useId()
</script>
<template>
  <div class="chaosheng-artwork" aria-hidden="true">
    <svg class="shore-fallback" viewBox="0 0 440 340" fill="none">
      <defs>
        <linearGradient
          :id="id + '-light'"
          x1="0"
          y1="130"
          x2="440"
          y2="190"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="#add0d2" stop-opacity="0" />
          <stop offset=".3" stop-color="#c5dddc" />
          <stop offset=".56" stop-color="#e5dba9" />
          <stop offset=".78" stop-color="#bec9e0" stop-opacity=".55" />
          <stop offset="1" stop-color="#bec9e0" stop-opacity="0" />
        </linearGradient>
        <filter :id="id + '-bloom'" x="-40%" y="-80%" width="180%" height="260%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <path
        d="M-30 206C111 20 269 305 468 102"
        :stroke="'url(#' + id + '-light)'"
        stroke-width="22"
        opacity=".32"
        :filter="'url(#' + id + '-bloom)'"
      />
      <g :stroke="'url(#' + id + '-light)'">
        <path d="M-20 207C123 22 254 309 469 94" stroke-width=".8" />
        <path d="M-38 218C111 25 264 287 483 120" stroke-width=".55" opacity=".75" />
        <path d="M-21 189C130 12 265 279 478 147" stroke-width="1.1" opacity=".5" />
        <path d="M-38 165C156 10 268 269 477 170" stroke-width=".6" opacity=".35" />
      </g>
    </svg>
  </div>
</template>
