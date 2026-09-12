# 朱墨的后台测试

常规 Electron 回归默认在后台运行，避免反复弹窗打断使用电脑的人。先构建，再运行：

```powershell
npm.cmd run build
npm.cmd run test:e2e
```

单独运行一个测试文件也会使用后台模式：

```powershell
node node_modules/@playwright/test/cli.js test tests/e2e/background.spec.ts
```

## 后台模式验证什么

测试启动真实 Electron 主进程、预加载、渲染进程和解析 Worker，使用生产构建及独立临时数据目录。文件读取、保存字节、恢复、注释、编辑、排版、图解和大文稿操作仍执行原来的路径。鼠标和键盘事件由 Playwright 发给测试页面，不使用系统鼠标键盘来操纵桌面。

仅在同时提供 `ZHUMO_TEST_BACKGROUND=1` 和独立 `ZHUMO_USER_DATA` 时，主进程保持窗口隐藏，不显示任务栏入口，并禁止窗口获得系统焦点。自动化实例关闭 Electron 的后台节流，使用 GPU 离屏渲染并将帧率上限设为 60，使页面保持可见状态并持续绘制。没有禁用 GPU，也没有改变阅读器处理隐藏事件的逻辑。普通用户启动仍使用原有窗口及后台节流行为。

不能只设置 `show: false`：本机实际验证发现，即使关闭后台节流，隐藏的普通窗口仍可能约每秒才收到一个合成帧。离屏模式避免依赖隐藏的桌面合成表面。专用检查也会拒绝六帧超过 1.5 秒的明显降频情况。

专门的后台测试检查窗口的可见性、焦点与节流状态，观察真实 WebGL 画面在连续帧间变化，再执行复制、打开文稿、键盘编辑和窗口尺寸变化，确认过程中没有显示或聚焦窗口。

后台测试将 `navigator.clipboard` 替换为每页隔离的测试对象，并拦截选中文本的复制事件。复制断言检查交给剪贴板的内容，**不读写使用者的系统剪贴板**。这不代表通过了 Windows 原生剪贴板集成测试。

## 结果口径

- 后台回归报告：`work/e2e-background-results.json`。
- 后台操作耗时及滚动帧间隔：`work/background/*-performance.json`。
- 显示窗口的回归报告：`work/e2e-visible-results.json`。
- 显示窗口的历史性能记录继续保存在 `work/*-performance.json`，后台运行不会覆盖这些记录。

后台截图可以检查布局与渲染内容。后台滚动也能检查长文末尾是否可达、虚拟列表是否有界、渲染循环是否仍工作。但后台帧间隔不能作为屏幕实际呈现时的帧率；离屏位图有额外的 GPU 到 CPU 复制成本，窗口没有原生边框，也没有覆盖正常的桌面焦点、遮挡、最小化、显示器刷新与屏幕合成条件。发布性能指标时必须说明执行模式。

## 确实需要显示窗口时

只有在使用电脑的人已经安排好可显示窗口的测试时段后，才临时启用可见模式。尽量选择需要验证的少量场景，避免整套反复弹窗：

```powershell
$env:ZHUMO_E2E_VISIBLE = '1'
try {
  node node_modules/@playwright/test/cli.js test tests/e2e/performance.spec.ts
} finally {
  Remove-Item Env:ZHUMO_E2E_VISIBLE -ErrorAction SilentlyContinue
}
```

可见模式使用原生系统剪贴板。Windows 的额外虚拟桌面可以整理窗口，但每次新建测试窗口都需要考虑所属桌面，不能把移动过一次窗口视为之后都不会干扰的保证，也不能据此假定性能等同于当前桌面实际显示。

脚本若直接调用 `_electron.launch`，也必须显式传入后台环境参数，或采用 `tests/e2e/runtime.ts` 的默认启动器。不要对旧版不支持后台参数的程序执行后台启动；先构建或重新打包。录屏、打包冒烟同样需要遵循这项约定。

机制依据：[Electron 窗口与页面可见性](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)、[Electron 离屏渲染](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)、[Electron 后台节流设置](https://www.electronjs.org/docs/latest/api/structures/web-preferences)、[Windows 多桌面](https://support.microsoft.com/en-us/windows/experience/configure-multiple-desktops-in-windows)。
