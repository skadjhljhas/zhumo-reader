# Windows 发行操作

2.0 的受管安装包由 `scripts/build-release.mjs` 构建。它使用 `electron-builder.release.yml` 的稳定产品身份，先生成完整程序目录，再调用 `scripts/build-managed-installer.mjs` 编译独立安装器。通用 `build:win` 不替代这一入口。

## 构建

在 Windows 上安装 Node.js 22 或更新版本、运行 `npm.cmd ci`，然后：

```powershell
npm.cmd run build:release -- --output ../zhumo-release-candidate
```

输出目录必须尚不存在。命令不会重用已有目录，以免覆盖文稿或旧候选。构建失败后保留现场，下次选择新目录。NSIS 从 electron-builder 的本机缓存定位；也可用 `ZHUMO_MAKENSIS` 指定已安装的编译器。

输出含完整 `win-unpacked` 程序目录、程序清单及独立回执、安装 exe 和其 `.receipt.json` / `.build.log`。回执记录产品身份、版本、程序清单 SHA-256 和安装包 SHA-256。构建日志中的签名阶段名称不等于有效证书签名，必须检查最终文件的 Authenticode 状态。

## 检查

类型、lint 与单元检查可以在干净工作目录运行：

```powershell
npm.cmd run lint
npm.cmd test -- --maxWorkers=2
npm.cmd run build
```

仓库的 `Windows reader checks` 工作流执行这些检查，以及隐藏的新建/恢复、PDF / EPUB、默认文稿目录、选区与公式流程。它仅有读取仓库权限，没有模型密钥；模型接口使用本机固定响应。工作流没有发布步骤。远端运行结果须以 GitHub 实际记录为准，本机验证不能替代远端通过状态。

安装验证需要旧版可运行目录夹具。当前实际基线是 AI 预览候选 35，包含程序清单及其位于父目录的独立构建回执。夹具只复制清单中的程序文件，不复制读者新增的文稿。准备好以后，指定新旧负载与独立证据位置：

```powershell
$env:ZHUMO_OLD_PAYLOAD = (Resolve-Path ../old-preview/win-unpacked).Path
$env:ZHUMO_MANAGED_PAYLOAD = (Resolve-Path ../zhumo-release-candidate/win-unpacked).Path
$env:ZHUMO_MANAGED_EVIDENCE = Join-Path (Get-Location) work/release-install
npm.cmd run test:e2e -- tests/e2e/managed-setup.spec.ts tests/e2e/profile-identity.spec.ts
```

该流程在私有临时目录重新编译安装器，系统登记也使用独立测试键；不运行发行安装包的真实默认安装路径。测试涵盖资料选择、旧资料字节与可用性、并发拒绝、重装、卸载的中断恢复和重装后的资料保留。耗时包含 NSIS 压缩与多次清理。安装过程不能并行启动其它 Electron 窗口测试。

## 发布候选的记录

确认源码提交、完整测试结果、最终程序与安装包 SHA-256、实际签名状态、发行说明以及已知边界。HDR 的隐藏 GPU 结果与前台屏幕测量分开报告；不得把前者写成物理显示器帧率或亮度。

旧正式版与 2.0 采用独立安装目录和登记，新安装器不执行旧卸载器。卸载保留文稿、设置、用户修改文件和完整恢复点，仅清理有归属且未改动的程序文件。异常退出后保留恢复记录，再运行同一安装或卸载入口；详细保护范围见 [目录核对](cleanup-directory-boundaries.md) 和 [产品资料身份](product-profile-identity.md)。

GitHub 上传是独立步骤。构建或通过检查不会自动建立 tag、推送代码或创建 Release。
