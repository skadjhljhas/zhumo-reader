import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseBookArg } from './args'
import { ensureFileAssocStartup } from './file-assoc'
import { registerIpc } from './ipc'
import { ZhuMoStore } from './store'

let store: ZhuMoStore | null = null
let isQuitting = false

/** 关窗 flush 协议通道（preload 侧成对出现，见 src/preload/index.ts）。
 *  契约常量表在 shared/ipc-types.ts（第二波治理范围），此处局部声明。 */
const FLUSH_CHANNEL = 'app:flush'
const FLUSH_ACK_CHANNEL = 'app:flush-ack'

/**
 * 每窗独立的关窗 flush 状态（T20 多窗口化）。
 * close → flush → ack → flushAll → destroy 链条的进行中标记必须按窗口
 * 隔离：全局单例在多窗并发关闭时会互相吞掉事件（甲的 ack 关掉乙的流程）。
 */
interface WindowFlushState {
  /** 已进入 flush 流程（close 拦截防重入） */
  pending: boolean
  /** 渲染层 ack 回调（close 监听中赋值，ack 或超时后清空） */
  onAck: (() => void) | null
}
const flushStates = new Map<number, WindowFlushState>()

/** 生产加载本地 html；dev 加载 dev server。
 *  bookPath 存在时以 ?book=<encodeURIComponent(path)> 传给渲染层，
 *  由 useBook.openBookFromLaunchQuery 消费（自动开书，跳过欢迎页）。
 *  loadFile 的 query 与 URLSearchParams 各做一次 URL 编码，渲染层
 *  取值后 decodeURIComponent 一次即还原原路径。 */
function loadRenderer(win: BrowserWindow, bookPath?: string): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (bookPath) url.searchParams.set('book', encodeURIComponent(bookPath))
    void win.loadURL(url.href)
  } else if (bookPath) {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { book: encodeURIComponent(bookPath) }
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 窗口工厂（T20 多窗口）：单进程多窗并存，每窗独立持有
 *  flush 状态 / F11 全屏响应 / close 拦截。
 *  bookPath 传入时该窗启动即打开对应图书（首启 argv / 第二实例 commandLine）。 */
function createWindow(bookPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '朱墨',
    show: false,
    autoHideMenuBar: true,
    // 暖纸色背景，避免窗口显示瞬间的白闪
    backgroundColor: '#f7f4ee',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：渲染层运行在沙箱中，禁用 Node 集成，启用上下文隔离
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  flushStates.set(win.id, { pending: false, onAck: null })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    flushStates.delete(win.id)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // H1 安全拦截：正文里的 <a href> 点击会让 webContents 就地导航，
  // 一旦外部页面进入渲染进程，contextBridge 暴露的 window.api 即对其实可见
  // （可读任意 md/txt、窃取阅读历史）。一律 preventDefault，http(s) 转系统浏览器。
  // 开发模式放行 dev server 自身导航（HMR 整页刷新依赖 location.reload）。
  const devRendererUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : ''
  win.webContents.on('will-navigate', (event, url) => {
    if (devRendererUrl && url.startsWith(devRendererUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  // T20 F11 全屏：每窗独立响应；keyDown 且非自动重复时切换（长按只切一次）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown' && !input.isAutoRepeat) {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    }
  })

  // M2 关窗丢进度：窗口销毁不走 Vue unmount，渲染层 2s 节流中的进度从未发出 IPC。
  // 拦截 close → 通知渲染层 flush → 收到 ack（或 800ms 兜底超时）→ store 落盘 → destroy。
  // destroy 不再触发 close，链条收敛为：close → flush → destroy → window-all-closed →
  // quit → before-quit(flushAll) → 退出（before-quit 的 flushAll 幂等，双重保险）。
  // T20：pending / onAck 均为本窗口私有状态（见 WindowFlushState 注释）。
  win.on('close', (event) => {
    const state = flushStates.get(win.id)
    if (!state || win.isDestroyed()) return
    event.preventDefault()
    if (state.pending) return // 已在 flush 流程中
    state.pending = true
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(giveUpTimer)
      state.onAck = null
      // 渲染层的 saveProgress 已入主进程节流缓冲（invoke 顺序先于 ack），
      // destroy 前统一 flushAll 落盘，不依赖 2s 节流定时器（其 unref 不阻塞退出）
      Promise.resolve(store ? store.flushAll() : undefined)
        .catch((error) => console.error('[zhumo] 关窗落盘失败：', error))
        .finally(() => {
          if (!win.isDestroyed()) win.destroy()
        })
    }
    const giveUpTimer = setTimeout(finish, 800) // 渲染层无响应（卡死/未就绪）时的兜底
    state.onAck = finish
    try {
      win.webContents.send(FLUSH_CHANNEL)
    } catch {
      finish() // webContents 已失效：直接落盘销毁
    }
  })

  loadRenderer(win, bookPath)
  return win
}

// 关窗 flush：渲染层 ack（ipcRenderer.invoke）——消息 FIFO 保证 ack 之前
// 已排队的 saveProgress 先被主进程处理完毕。
// T20：ack 按发送方窗口路由到对应的 flush 状态，多窗并发关闭互不串扰。
ipcMain.handle(FLUSH_ACK_CHANNEL, (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender)
  const state = sender ? flushStates.get(sender.id) : undefined
  state?.onAck?.()
})

/** 应用菜单：生产环境完全移除；开发环境保留最小菜单（含 DevTools 切换） */
function setupApplicationMenu(): void {
  if (is.dev) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '朱墨',
          submenu: [{ role: 'quit' }]
        },
        {
          label: '视图',
          submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
          ]
        }
      ])
    )
  } else {
    Menu.setApplicationMenu(null)
  }
}

async function bootstrap(): Promise<void> {
  // Windows 任务栏应用标识
  app.setAppUserModelId('com.zhumo.reader')

  store = new ZhuMoStore(app.getPath('userData'))
  registerIpc(store)
  setupApplicationMenu()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // T20 首启 argv 开书（文件关联 / 命令行）：生产形态 argv[1] 为文件路径；
  // dev 形态的 electron-vite 参数（'.' / --flag 等）由 parseBookArg 过滤。
  createWindow(parseBookArg(process.argv) ?? undefined)

  // T26 便携版文件关联自注册（解压即用 + 路径自愈）：仅打包形态异步执行，
  // dev 不碰开发机注册表；内部吞错告警，不阻塞 / 不影响窗口创建。
  const assocStore = store
  if (assocStore) {
    void ensureFileAssocStartup({
      packaged: app.isPackaged,
      isEnabled: () => assocStore.getFileAssocEnabled()
    })
  }

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  console.log(`[zhumo] 主进程就绪（userData: ${app.getPath('userData')}）`)
}

// 单实例锁（保留，T20）：避免多进程并发写 userData JSON 的竞态；
// 锁的含义从「聚焦既有窗口」变为「第二实例转开新窗口」——
// 文件关联双击 .md 时，无论朱墨是否已在运行，都会得到一个打开该书的窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    createWindow(parseBookArg(commandLine) ?? undefined)
  })

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      console.error('[zhumo] 启动失败：', error)
    })

  // 退出前把节流中的待写数据全部落盘
  app.on('before-quit', (event) => {
    if (isQuitting || store === null) return
    event.preventDefault()
    isQuitting = true
    store
      .flushAll()
      .catch((error) => console.error('[zhumo] 退出前落盘失败：', error))
      .finally(() => {
        app.quit()
      })
  })

  // 阅读器而非常驻工具：关闭所有窗口即退出
  app.on('window-all-closed', () => {
    app.quit()
  })
}
