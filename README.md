# 朱墨 ZhuMo 2.0

<p align="center"><img src="resources/icon.png" width="112" alt="朱墨的朱字印章" /></p>

朱墨是一款本地 Markdown 阅读器与编辑器，面向需要反复细读、批注和返回原文的书籍。正文是书页的中心，旁注可以继续生长出旁注；光、色彩与留白帮助呈现阅读中的关系。

本分支正在准备 2.0。Windows rc.4 候选已通过阅读流程、安装与中断恢复回归，2.0 正式发布尚未执行。公开版本以 [GitHub Releases](https://github.com/skadjhljhas/zhumo-reader/releases) 为准。

## 阅读与写作

- **Markdown 阅读与编辑**：支持新建文稿、源文编辑、撤销与保存，阅读和编辑位置相互对应。新建后直接输入，首次保存再命名；未保存的新文稿可在重启后从欢迎页恢复。
- **多层旁注**：正文与页边注释对照，注释中可以继续引用注释。共享引用、父子关系、回到原句与阅读路径都有独立位置；注释脉络可展开为关系图。
- **按自己的习惯选字**：全局设置分别控制选区释放后的写注、AI 解释和自动复制，可以全部关闭。写注与解释共用一个浮页；开启写注时可以直接输入，Enter 保存，Shift+Enter 换行。
- **轻盈的就地注释**：可调整整体透明度，与正文分色，也可关闭就地注页，改用页边注释和悬停引线。
- **文稿位置明确**：打开与另存共用绑定的默认文稿目录。更换程序目录不会以空库替代已有文稿；设置里可查看和更改位置。
- **完整阅读工具**：目录、全文检索、文句回响、全书长卷、公式细读、Mermaid 图表、阅读进度、多窗口与全屏。

基础排版支持 Markdown 表格、任务列表、代码、嵌套注释与中文注号写法。公式由 KaTeX 和 MathJax 配合处理，并支持常见 AMS 环境；无法识别的表达式保留源文供检查。具体格式见 [渲染约定](docs/renderer-contract.md) 与 [三层注释范例](docs/annotation-example.md)。

## 阅读空间

琉璃、潮光、星辰等主题提供不同的阅读光场。琉璃围绕透光与折射，潮光围绕沧海的明暗与水光；背景和标题光纹会缓慢变化，响应时间、阅读停留、文稿结构和交互。阅读设置可以减弱或关闭光影。

**白纸**提供纯白背景与黑色文字，保留 Markdown 原有标题，省去装饰书首和“全书完”。所有主题的文稿名与文稿操作集中在左侧，阅读区从窗口顶部开始；较矮窗口中的左侧工具可以独立滚动。

琉璃的画外光源称为**天光**。它从远处进入，实际停留偏向右上与上方，通过缓慢的随机曲线游移。少量柔光束包含冷暖层次与多层晕散；文字附近呈现类似水面反射的流动亮纹，原有墨色保持清晰。模型与边界见 [天光与字缘反光](docs/skylight-and-ink.md)。

**回声**记录读者在文字附近的停留。悬停超过三秒后，原文逐渐显影，左下方的光场保存这些阅读痕迹；不在原文旁弹出计时器。详见 [静默回声](docs/silent-echo.md) 和 [回声光场设计](docs/echo-light-design.md)。

**琉璃支持 SDR / HDR 选择**。HDR 作用于背景、文字荧光和引线等光效，需要系统、显示器和 GPU 输出链路支持；不可用时保留 SDR 显示。正文、注释、UI 可以分别导入字体。详见 [HDR 与字体](docs/hdr-and-typography.md)。

## 可配置的 AI 细读

解释与文本标注使用独立模型配置。标注提供**跟随阅读**与**全文标注**两种互斥模式，在左侧「字」按钮中切换；两种标注模式共用模型，各有独立系统提示词。既可以用简易模式填写接口，也可以在代码模式中返回请求体；上下文、思考程度和输出长度预设采用模型默认，仍可自定义。

模型通过**字色、荧光、光华**三个独立通道标注原文。字色与荧光各自选色；光华让少数重要词句成为向周围散射的光源，优先使用 HDR 扩展亮度。完整记录逐条显影，不必等待整次回答结束。跟随模式的可见停留时间可调为 1–15 秒、默认 5 秒，最多 10 句段并行。全文模式读取完整 Markdown 与正文、标题、注释的定位索引，保留屏幕之外的结果。接口见 [细读着色](docs/reading-color-interface.md)、[全文标注](docs/whole-document-annotation.md)，配置方法见 [请求体代码](docs/ai-request-code.md)。

启用相应 AI 功能后，文稿或选句及其上下文会发送到用户配置的模型服务。默认保留完整上下文，模型容量由服务商处理；跟随模式仍可选择前后各最多 100k 字符的窗口或仅发送句段。全文模式不以当前视口或这个窗口替代整篇文稿。发行包不包含 API 密钥；密钥与本机资料保存在用户的配置目录中。

若希望 AI 直接写出适合朱墨阅读的文稿，应用内提供可复制的 [AI 注释写作协议](docs/ai-annotation-protocol.md)。它涵盖注释的选择、论述、引用和嵌套写法。

## PDF 与 EPUB

**导出 PDF 默认尽量保留当前阅读主题**，包括字体、配色、已有文字标注和定格的背景光。支持 A4 纵向/横向、包含全文注释，也可选择适合打印的纸面风格。短注与正文并置，长注获得更宽版面。PDF 为静态页面，不保留屏幕动态或实际 HDR 亮度。

**EPUB 支持常见未加密的 EPUB 2/3 流式书籍**，包括章节目录、插图、书内链接和脚注，可在朱墨主题中阅读、使用 AI 细读并导出 PDF。当前不编辑 EPUB 容器，也不支持 DRM、固定版式或音视频。详见 [文稿、PDF 与 EPUB](docs/document-workflows.md)。

## 本地使用与数据

目前已验证的可运行目录需要完整保留，不能只移动其中的 exe。打开 Markdown、TXT 或 EPUB，可使用工具栏、拖放或启动参数。文稿、导入字体、模型配置、阅读记录和恢复草稿属于用户资料，不进入发行包。

正式 2.0 使用独立的产品身份与默认安装位置。第一次打开时，有一套旧阅读资料便整套沿用，有多套则让使用者选择；密钥及对应加密状态、字体、回声、草稿与文稿位置一起保留，各套资料不自动合并。旧正式版的程序和卸载入口保持独立。详见 [资料选择](docs/product-profile-identity.md)；安装与更新的具体证据及待完成事项见 [发布状态](docs/release-readiness.md)。

## 开发

使用 Node.js 22 或更新版本与 npm。当前主要验证平台为 Windows 10/11；macOS 与 Linux 尚未完成同等的桌面验证。Windows PowerShell 中使用 npm.cmd，无需为本项目更改全局脚本执行策略。

```powershell
npm.cmd ci
npm.cmd run dev
```

类型、源码和运行流程分别检查：

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Electron 回归默认隐藏、离屏运行，并使用独立资料目录和测试剪贴板。部分安装回归依赖指定的旧候选夹具，需要按对应验证文档准备；不能把缺少夹具的跳过视为升级通过。执行方式与测量边界见 [后台测试说明](docs/e2e-testing.md)。

生成当前 AI 阅读候选的完整可运行目录：

```powershell
npm.cmd run build:ai
```

候选版本、文件名与输出位置由 electron-builder.ai.yml 指定。构建前会核对输出目录，含用户新增文件或正在运行的旧输出不会被直接覆盖。用于安装验证的 electron-builder.setup.yml 和 scripts/build-managed-installer.mjs 仍是实验入口；通用 build:win 不是已经验收的 2.0 安装发布流程。

正式产品候选使用受管安装流程，要求明确指定一个尚不存在的输出目录：

```powershell
npm.cmd run build:release -- --output ../zhumo-release-candidate
```

该命令执行类型检查、程序打包、程序清单校验和受管安装器编译，并保存安装包摘要回执；不上传 GitHub，也不安装到当前电脑。当前发布门槛和如何复现隔离安装检查见 [发行操作](docs/release-workflow.md)。

应用图标来自原版朱字画作 resources/icon-original.png，运行 npm.cmd run build:icons 生成同源的 PNG、ICO 和 ICNS。发行前应另外核对构建产物摘要和实际签名状态。

## 项目结构

| 位置                         | 内容                                                 |
| ---------------------------- | ---------------------------------------------------- |
| src/main                     | 文件、EPUB/PDF、模型请求、配置、窗口、版本与安装流程 |
| src/preload                  | 桌面接口桥接                                         |
| src/renderer/src/components  | 阅读、编辑、旁注与设置界面                           |
| src/renderer/src/parser      | Markdown/EPUB 投影、注释图与公式处理                 |
| src/renderer/src/effects     | 文字定位、光场、HDR 与色彩                           |
| src/renderer/src/composables | 阅读状态、选区、自动分析、缓存与回声记录             |
| src/shared                   | 协议和共享类型                                       |
| tests                        | 单元与隐藏桌面流程检查                               |
| docs                         | 使用说明、格式协议、设计与验证记录                   |

## 许可证与致谢

项目代码以 [朱墨源码可用许可 v1.0（ZM-SAL-1.0）](LICENSE) 授权：**个人 / 非营利 / 企业内部自用免费**；**基于它做免费且开源的衍生项目免费**（须沿用同一协议并显著署名“使用了朱墨 ZhuMo”）；**任何商业使用（销售含本代码的产品或服务）须事先取得书面商业授权并付费**。随附字体与第三方组件保留各自许可证，详见 [第三方声明](THIRD-PARTY_NOTICES.md) 和 docs/licenses。

感谢 Electron、Vue、CodeMirror、markdown-it、KaTeX、MathJax、Mermaid，以及思源宋体、霞鹜文楷等项目。中文排版也受 [赫蹏](https://github.com/sivan/heti) 的启发。

## English

ZhuMo is a local Markdown reader and editor for close reading with nested annotations. Version 2.0 adds configurable AI explanations, streaming text and glow colors, evolving reading light, imported fonts, theme-preserving PDF export, and reflowable EPUB 2/3 reading. AI services are configured by the user; no API key is bundled.

This branch is preparing 2.0. The Windows 2.0.0 candidate has passed local reader, installation, and interrupted-recovery checks. See the linked documentation for supported formats and current limits. The code is licensed under the ZhuMo Source-Available License v1.0 (ZM-SAL-1.0): free for personal, non-commercial and internal organizational use, and free for free open-source derivative works (share-alike, with attribution); any commercial use (selling products or services that incorporate the code) requires a prior paid commercial license. Bundled components and fonts retain their own licenses.
