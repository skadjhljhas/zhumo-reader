/**
 * 朱墨 ZhuMo —— preload 桥接层。
 *
 * 渲染层唯一入口 window.api：业务通道全部经由 ipcRenderer.invoke 走主进程
 * （请求-响应，无回调式事件推送）。
 * getPathForFile 必须在 preload 中执行——File 对象无法跨 IPC 序列化，
 * 只有此处的 webUtils 能取到其磁盘路径。
 *
 * 关窗 flush 协议（onFlush/ackFlush）：主进程 close 拦截后经 'app:flush'
 * 通知渲染层保存节流中的进度，渲染层完成后 invoke 'app:flush-ack'。
 * 无订阅者（未进入阅读态）时由本层直接 ack，主进程 800ms 超时兜底。
 * 通道名与 src/main/index.ts 成对声明（契约常量表归第二波治理）。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc-types'
import type { ZhuMoApi } from '../shared/ipc-types'

const FLUSH_CHANNEL = 'app:flush'
const FLUSH_ACK_CHANNEL = 'app:flush-ack'

/** 渲染层关窗 flush 扩展（Window.api 上的可选成员，见 index.d.ts） */
export interface FlushApi {
  /** 订阅关窗 flush 通知；返回退订函数 */
  onFlush(callback: () => void): () => void
  /** 进度保存完成后应答主进程（触发 destroy） */
  ackFlush(): Promise<void>
}

const flushCallbacks = new Set<() => void>()
ipcRenderer.on(FLUSH_CHANNEL, () => {
  for (const callback of flushCallbacks) callback()
  // 无订阅者（欢迎页 / 加载页，无待存进度）：直接应答，关窗不必等满超时
  if (flushCallbacks.size === 0) void ipcRenderer.invoke(FLUSH_ACK_CHANNEL)
})

const api: ZhuMoApi & FlushApi = {
  openBookDialog: () => ipcRenderer.invoke(IPC.OpenBookDialog),
  readBook: (path) => ipcRenderer.invoke(IPC.ReadBook, path),
  saveProgress: (path, progress) => ipcRenderer.invoke(IPC.SaveProgress, path, progress),
  getProgress: (path) => ipcRenderer.invoke(IPC.GetProgress, path),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.SaveSettings, settings),
  getSettings: () => ipcRenderer.invoke(IPC.GetSettings),
  getRecentBooks: () => ipcRenderer.invoke(IPC.GetRecentBooks),
  removeRecent: (path) => ipcRenderer.invoke(IPC.RemoveRecent, path),
  // T26 便携版文件关联：真实环境查 / 写 HKCU；dev 下主进程侧兜底为 'off' / 空操作
  fileAssocStatus: () => ipcRenderer.invoke(IPC.FileAssocStatus),
  fileAssocSet: (enabled) => ipcRenderer.invoke(IPC.FileAssocSet, enabled),
  // async 包装：File 非法时 webUtils 同步抛错将转为 rejected promise
  getPathForFile: async (file) => webUtils.getPathForFile(file),
  onFlush: (callback) => {
    flushCallbacks.add(callback)
    return () => {
      flushCallbacks.delete(callback)
    }
  },
  ackFlush: () => ipcRenderer.invoke(FLUSH_ACK_CHANNEL)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // 主进程已强制 contextIsolation，此分支仅为兜底。
  // 注：node 侧 tsconfig 会排除同名 index.d.ts，Window.api 类型只在 web 侧生效，
  // 故与官方模板一致地以 @ts-ignore 压制（见 tsconfig.web.json 的 include）。
  // @ts-ignore (define in dts)
  window.api = api
}
