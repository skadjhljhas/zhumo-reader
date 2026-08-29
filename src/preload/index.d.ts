import type { ZhuMoApi } from '../shared/ipc-types'

declare global {
  interface Window {
    /** 朱墨桥接 API（由 preload 经 contextBridge 暴露，见 src/shared/ipc-types.ts）。
     *  关窗 flush 扩展（onFlush/ackFlush，见 src/preload/index.ts 的 FlushApi）
     *  为可选成员：浏览器预览桩（api-mock）不实现，调用方以可选链防御。
     *  此处内联形状而不 import preload 模块，避免把 electron 类型拉进 web 侧类型图。 */
    api: ZhuMoApi &
      Partial<{
        onFlush(callback: () => void): () => void
        ackFlush(): Promise<void>
      }>
  }
}

export {}
