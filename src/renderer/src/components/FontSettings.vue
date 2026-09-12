<script setup lang="ts">
import { onMounted } from 'vue'
import { settings } from '../composables/useSettings'
import { fontState, importFont, refreshFonts } from '../composables/importedFonts'
const roles = [
  { key: 'uiFont', label: '界面' },
  { key: 'bodyFont', label: '正文' },
  { key: 'noteFont', label: '注释' }
] as const
async function pick(role: (typeof roles)[number]['key']): Promise<void> {
  const id = await importFont()
  if (id) settings[role] = id
}
onMounted(refreshFonts)
</script>
<template>
  <fieldset class="selection-preferences font-settings">
    <legend>字体</legend>
    <div v-for="role in roles" :key="role.key" class="font-setting-row">
      <label :for="'font-' + role.key">{{ role.label }}</label>
      <select :id="'font-' + role.key" v-model="settings[role.key]">
        <option value="">主题默认</option>
        <option v-for="font in fontState.fonts" :key="font.id" :value="font.id">
          {{ font.name }}
        </option>
      </select>
      <button
        :disabled="fontState.busy"
        :aria-label="'导入' + role.label + '字体'"
        @click="pick(role.key)"
      >
        导入
      </button>
    </div>
    <p class="sp-hint">
      字体保存在朱墨的用户资料中，重启和更新后仍可使用。支持
      TTF、OTF、WOFF、WOFF2；字体缺字时自动使用备用字形。
    </p>
    <p v-if="fontState.error" class="sp-hint" role="status">{{ fontState.error }}</p>
  </fieldset>
</template>
<style>
.font-setting-row {
  display: grid;
  grid-template-columns: 2em minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  margin: 9px 0;
}
.font-setting-row select {
  min-width: 0;
  width: 100%;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px;
  font: inherit;
}
.font-setting-row button {
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 5px 10px;
}
</style>
