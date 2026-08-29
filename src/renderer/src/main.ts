import '@fontsource/noto-serif-sc/400.css'
import '@fontsource/noto-serif-sc/700.css'
import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css'
import 'katex/dist/katex.min.css'
import './assets/main.css'
import './styles/themes.css'
import './styles/typography.css'
import './styles/notes.css'

// 浏览器预览桩（api-mock）：门控在模块内——仅 DEV 或 ?mock=1 时注入。
// 副作用导入保证在任何 window.api 调用前完成判定；生产应用桥接故障时
// window.api 缺失会自然报错，不会无声降级进演示书。
import './dev/api-mock'

import { createApp } from 'vue'
import App from './App.vue'
import { applyCachedSettings } from './composables/useSettings'

// 首帧前应用缓存设置（主题/字号变量），避免异步 IPC 返回前的主题闪烁
applyCachedSettings()

createApp(App).mount('#app')
