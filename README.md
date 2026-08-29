# 朱墨 ZhuMo

<p align="center"><img src="resources/icon.png" width="128" alt="朱墨图标" /></p>

为满是批注的中文学术长文而做的 Markdown 阅读器。

朱墨把「正文 + 多层脚注」的学术文本当作一等公民：正文与注释侧栏左右对照，
脚注可以嵌套脚注，层级随阅读位置联动高亮——如纸书批注般安静，如数据库般精确。
取名「朱墨」：朱者批注，墨者原文。

## 目录

- [项目定位](#项目定位)
- [功能特性](#功能特性)
- [受支持的注释写法](#受支持的注释写法)
- [已知限制](#已知限制)
- [下载与安装](#下载与安装)
- [开发指南](#开发指南)
- [构建与打包](#构建与打包)
- [项目结构](#项目结构)
- [致谢](#致谢)
- [许可证](#许可证)
- [English Brief](#english-brief)

## 项目定位

中文学术文本（哲学、历史、文学研究的译著与古籍整理本）有一个共同的排版现实：
**脚注不是附加物，而是第二正文**。译者注里引考据注，考据注里再引编者注，
读者在一页纸上来回跳跃，批注的层级与归属是理解的一部分。

通用 Markdown 阅读器把脚注渲染成文末一个扁平列表，层级信息就此丢失。
朱墨针对这类文本重新设计阅读形态：

- **正文与注释分栏对照**：左侧正文，右侧注释卡片流，滚动位置智能联动；
- **注释图而非脚注列表**：解析器把全书注释建为一张有向图，
  每条注释的层级、多父归属、引用次数、成环与失联都有精确语义；
- **面向中文的写法兼容**：除 GFM 脚注外，兼容 `[注3]`、`注3：`、
  `[^译者:序1]` 这类中文出版界实际在用的标记习惯。

技术栈：Electron + Vue 3 + TypeScript，解析内核运行在 Web Worker 中，
百万字级文档亦可流畅打开。

## 功能特性

- **多层注释侧栏**：注释卡按文档序排列，层级以缩进与竖线呈现，
  点击卡片跳回正文锚点，点击注内引用在侧栏内定位；
- **注释类型识别**：词表识别译者注、编者注、考据注、原注、案疏评注等类型，
  徽标色相随类型区分（词表可扩展）；徽标文字显示作者实际使用的类型词
  （如「译按」就显示「译按」），自定义类型词亦原样显示；
- **正文锚点与侧栏联动**：阅读到某段时，该段引用的注释卡自动高亮并跟随滚动；
- **完整目录**：多级标题构成的树形目录抽屉，随滚动标示当前位置，点击跳转；
- **阅读进度记忆**：每本书按路径独立记录进度，重开自动恢复到上次位置；
- **阅读设置**：字号（14–24 px）、行高（1.6–2.2 倍）、版心宽度（每行 34–46 字）、
  首行缩进/段间距两种段落风格、注释层级展开上限（1–6 层，默认 4）；
  明暗主题随系统或手动切换；
- **数学公式**：行内 `$...$` 与块级 `$$...$$`，由 KaTeX 渲染，注释体内同样可用；
- **健壮解析**：Worker 解析不阻塞界面；解析警告（未定义引用、重复定义、
  循环引用、超层嵌套）集中呈现在警告面板；
- **大文档性能**：虚拟化渲染 + 增量挂载，50 万字压力文档滚动如常；
- **F11 全屏**：任意窗口内按 F11 切换全屏（每窗独立，长按只切一次）；
- **多窗口**：可同时打开多本书各自阅读；应用已在运行时再次启动
  （如双击另一本 .md）会新开窗口而非聚焦旧窗，各窗独立关闭互不影响；
- **文件关联**：安装器（NSIS）注册 `.md` / `.markdown` 的「打开方式」，
  便携版（zip / portable）首次启动也自动注册并随目录移动自愈，
  命令行 / 双击文件参数直接开书（详见「下载与安装」一节）；

## 受支持的注释写法

本章是朱墨的「文法说明书」，写作与整理稿件时可作规范参考。
以下规则提炼自解析器源码（`src/renderer/src/parser/scan.ts` 及相关模块），
并有完整的单元测试保障。

### 1. 引用（正文中的标记）

| 写法                | 名称         | 说明                                                                         |
| ------------------- | ------------ | ---------------------------------------------------------------------------- |
| `[^label]`          | GFM 脚注引用 | `label` 为非空、不含空白与方括号的字符序列；冒号允许出现（保留给类型前缀）   |
| `[注3]` / `【注3】` | 中文注引用   | 数字为阿拉伯数字；阅读器自动归一为 `[^注3]`                                  |
| `^[内容……]`         | 行内注       | `^` 紧跟方括号，内容写在正文处；阅读器把它抽出为一条独立注释，原位置留下锚点 |

行内注可以**跨行**：括号按深度配对（嵌套的 `[` `]` 均计入），
反引号代码段不参与配对；直到文档末尾仍未闭合则强制闭合。

### 2. 定义（注释本体）

| 写法                      | 说明                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `[^label]: 内容`          | GFM 定义行。行首允许 ≤3 空格缩进；冒号半角 `:` 与全角 `：` 均可 |
| `注3: 内容` / `注3：内容` | 中文注定义行。行首允许 ≤3 空格缩进                              |

定义体的续写规则：

- 定义行之后**缩进 ≥4 空格**的行是注释体续行；
- 续行中的**空行**不终结定义，而是分隔注释体内的多个段落；
- 一旦出现非缩进的新内容行，定义结束；
- 注释体内可以继续使用全部引用写法（见嵌套），也可以包含代码块与公式。

### 3. 注释类型

类型有两个识别来源，优先级：label 前缀 > 定义首词。

**来源一：label 冒号前缀**。`[^译者:序1]` 中 `译者:` 的前缀部分与词表匹配，
该注被标为译者注。

**来源二：定义首词**。定义内容以类型词开头、词后紧跟冒号或空白时生效，
例如 `[^x]: 译者注：……` 或 `注3：按，此处……`。

类型词表（匹配时**最长词优先**）：

| 类型     | 词表                                       | 徽标配色   |
| -------- | ------------------------------------------ | ---------- |
| 译者注   | `译者注`、`译注`、`译者`、`译者按`、`译按` | 译者色     |
| 编者注   | `编者注`、`编注`、`校注`、`编者`、`编者按` | 编者色     |
| 考据注   | `考据注`、`考证注`、`考据`、`考证`         | 考据色     |
| 原注     | `原注`、`原文注`                           | 原注色     |
| 案疏评注 | `按`、`案`、`疏`                           | 评注色     |
| 普通注   | （不匹配以上任何词）                       | 普通注色   |

词表可通过解析器暴露的 `registerNoteTypeWord(type, word)` 在运行期扩展。

**徽标显示作者实际用词**：命中词表时徽标原样显示命中的词（写「译者按」就显示
「译者按」，不强制归一为「译者注」）；label 前缀是词表外的自定义词时同样显示该词
（如 `[^疏证:某词]` 显示「疏证」，该注按普通注配色），语义不丢弃；
无任何类型语义的注释不显示徽标。容错：自定义词超过 12 字符或含异常字符
（标记符、控制字符）时不显示徽标，避免侧栏被超长词撑爆。

### 4. 嵌套层级

注释体内可以再引用其他注释（注内注），层层相嵌：

- 正文直接引用的注释为 **1 级**；注内引用的注释为**父注层级 + 1**；
- 一条注释被多个不同层级的注释引用时，取**最浅**层级（广度优先遍历决定）；
- 层级超过设置中的「注释层级上限」（默认 4，可调 1–6）时封顶显示并告警；
- 正文锚点上的序号即该注层级；侧栏卡片按层级逐级缩进。

### 5. 容错行为

朱墨对不完美稿件的态度是**尽力解析 + 显式告警**，而非报错拒绝：

- **代码保护**：围栏代码块（\`\`\` / \~\~\~）、缩进代码块（4 空格）、
  行内代码 span（反引号）中的任何「类注释」写法原样保留，**绝不解析**；
- **引用无定义**（missing）：锚点保留在正文中，侧栏显示虚线空卡，并记一条警告；
- **定义无引用**（orphan）：收入侧栏尾部「未引用注释」折叠分组，不打断主列表；
- **重复定义**：同一 label 取**首个**定义，其余记入警告；
- **循环引用**：注释互相引用且从正文不可达的子图，整体封顶至层级上限并标记循环警告；
- **行内注未闭合**：至文档末尾强制闭合，内容照常成为注释。

## 已知限制

- **`[1]`（不带 `^` 的纯数字方括号）暂不支持**。传统人文书籍最常见的
  「正文 `[1]` + 文末 `1. ……`」写法，v1 不会解析——`[1]` 会被当作普通文本。
  请改写为 `[注1]` + `注1：……`，或 `[^1]` + `[^1]: ……`；
- 中文注编号仅支持**阿拉伯数字**（`注一` 汉字编号不识别）；
- label 内不允许空格与方括号；
- v1 面向**单个 Markdown 文件**，暂不支持多文件书籍（分卷、章节拆分）与图片资源打包；
- 阅读器为只读，不支持在应用内新增或编辑批注。

## 下载与安装

Releases 页面提供三种 Windows 发行物（x64）：

| 文件                       | 形态        | 说明                                                                                        |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `zhumo-x.y.z-setup.exe`    | NSIS 安装器 | 辅助式安装向导，可选安装目录；按用户安装，不需要管理员权限；含开始菜单/桌面快捷方式与卸载项 |
| `zhumo-x.y.z-portable.exe` | 便携单文件  | 双击即用，数据保存在临时目录，关退出后清理                                                  |
| `zhumo-x.y.z-win-x64.zip`  | 便携压缩包  | 解压到任意目录运行 `ZhuMo.exe`，数据保存在 `%APPDATA%` 下同目录名文件夹                     |

### 文件关联与默认打开方式

自 1.0.8 起，NSIS 安装器会为 `.md` / `.markdown` 注册 ProgId
（按用户安装写入 `HKCU\Software\Classes`，无需管理员权限），
并在资源管理器「打开方式」菜单中出现朱墨：

- 若系统中 `.md` **尚无其它默认打开程序**，安装后双击 `.md` 默认用朱墨打开；
- 若已有其它程序占用默认项，Windows 的 **UserChoice 保护机制**禁止程序
  （包括安装器）强行替换默认打开方式——这是 Windows 10/11 的系统级安全策略，
  并非缺陷。请在「设置 → 应用 → 默认应用」中手动把 `.md` 指向朱墨一次即可；
- 双击关联文件或命令行传参时，若朱墨已在运行，将新开一个窗口打开该书；
  文件已被移动 / 删除时会优雅回到欢迎页并提示。

自 1.1.3 起，**便携版也拥有同款文件关联**（解压即用，无需安装器）：

- 便携版（zip 解压 / portable 单文件）**首次启动自动注册**：写入
  `HKCU\Software\Classes\ZhuMoPortable.Assoc`（仅当前用户，无需管理员权限），
  并把自己加入 `.md` / `.markdown` 的「打开方式」列表——右键即见
  「朱墨 ZhuMo（便携版）」；
- **路径自愈**：整个便携文件夹挪到别处后，下次启动会把注册表指向
  刷新到新路径，无需手动处理；
- 与安装版互不干扰：便携版使用独立 ProgId，注册 / 解除都不会触碰
  安装版（NSIS）的关联；安装版机器上自注册会自动让位给安装器注册，
  不会在「打开方式」里出现重复条目；
- 可解除：应用内开关由设置面板提供（`fileAssocSet` 接口已就绪，
  界面开关随后续版本接入）；当前版本如需立即解除，删除注册表键
  `HKCU\Software\Classes\ZhuMoPortable.Assoc` 并删除 `.md` / `.markdown`
  下 `OpenWithProgids` 中名为 `ZhuMoPortable.Assoc` 的值即可，
  不影响其它程序的关联；
- portable 单文件版注册的是启动器 exe 自身（应用从临时目录自解压运行，
  临时路径不参与注册）；
- 「设为默认」仍受上文 UserChoice 保护，程序同样不能强设。

### 关于 SmartScreen「未知发布者」提示

本项目**未购买代码签名证书**，因此 Windows SmartScreen 在首次运行安装器时
可能弹出「Windows 已保护你的电脑」蓝色警告。这是对所有无签名应用的统一提示，
并非检测到恶意代码。若你信任来源，请点击「更多信息」→「仍要运行」。
若希望消除该提示，可自行从源码构建（见下文）并用自己的证书签名。

## 开发指南

### 环境要求

- Windows 10/11（开发）；macOS 与 Linux 理论可用但未验证；
- [Node.js](https://nodejs.org/) ≥ 22 LTS；
- npm（随 Node.js 附带）。

### Windows 贡献者请注意：用 `npm.cmd`

项目在 Windows PowerShell 5.1 下开发。PowerShell 直接敲 `npm` 时会解析到
`npm.ps1` 脚本，在默认执行策略（`Restricted`）下会报错：

```
npm : 无法加载文件 npm.ps1，因为在此系统上禁止运行脚本。
```

两种解决办法，任选其一：

1. **推荐**：统一使用 `npm.cmd` 调用（本仓库文档与脚本均如此约定）：
   ```powershell
   npm.cmd install
   npm.cmd run dev
   ```
2. 或放开当前用户的脚本执行策略（一次性设置）：
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

注意 PowerShell 5.1 不支持 `&&` 语句连接符，请使用 `;`。

### 常用命令

```powershell
npm.cmd install        # 安装依赖（含 Electron 二进制）
npm.cmd run dev        # 开发模式（热重载）
npm.cmd run lint       # ESLint 检查
npm.cmd run typecheck  # TS 类型检查（主进程 + 渲染层）
npm.cmd test           # Vitest 单元测试
npm.cmd run bench      # 性能基准（见下节；前置 npm.cmd run build）
npm.cmd run format     # Prettier 格式化
```

纯浏览器预览（vite dev 端口或 4175 静态预览）不带 Electron 桥接，
需在 URL 显式加 `?mock=1` 开启浏览器预览桩；生产应用不存在静默降级。

### 性能基准

50 万字 / 3000 注压测书的可复现基准（脚本入库于 `scripts/bench/`，
口径详见 [scripts/bench/README.md](scripts/bench/README.md)）：

```powershell
npm.cmd run bench   # 自起 4175 静态预览 + 无头 Edge，跑完自动清理
```

基线（2026-08-26 实测，stress-50w 书，三轮独立干净 Edge 会话取中位）：Worker 解析中位 575 ms、
首屏可见中位 878 ms；滚动帧间隔 avg 18.1 ms / p95 28.9 ms、
掉帧率（>33ms）3.2%；JS 堆 81.5 MB、DOM 节点约 32k。

国内网络环境下若 Electron 二进制下载缓慢，可先设置镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm.cmd install
```

## 构建与打包

```powershell
# 可选：国内镜像加速 electron-builder 的 NSIS / winCodeSign 二进制下载
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'

# 跳过代码签名探测（无证书环境下避免构建失败）
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'

# 一条命令完成：类型检查 → electron-vite 构建 → electron-builder 打包
npm.cmd run build:win
```

产物位于 `dist/`：

- `zhumo-1.0.0-setup.exe` — NSIS 安装器；
- `zhumo-1.0.0-portable.exe` — 便携单文件；
- `zhumo-1.0.0-win-x64.zip` — 便携压缩包。

图标单源位于 `resources/icon.png`（1024×1024）：主进程经 electron-vite 的
`?asset` 引用作窗口图标，`electron-builder.yml` 的 `win.icon` 也指向它并
自动生成 Windows 多尺寸 ico。
如需正式发布，建议配置自己的代码签名证书并在 `electron-builder.yml` 中补充
签名配置，以消除 SmartScreen 警告。

本项目已开源，仓库地址：[`https://github.com/skadjhljhas/zhumo-reader`](https://github.com/skadjhljhas/zhumo-reader)。
`package.json` 中的 `repository` / `bugs` / `homepage` 均指向该仓库。

## 项目结构

git 仓库根即本 `zhumo/` 目录（仓库内不含上层目录）。

```
zhumo/
├── build/                    # electron-builder 资源（mac 资产；Windows 图标单源在 resources/）
├── fixtures/                 # 测试样例文档
├── resources/                # 应用图标（icon.png 单源）与运行期资源
├── scripts/
│   └── bench/                # 性能基准（npm run bench；含 baseline 与指标口径）
├── src/
│   ├── main/                 # Electron 主进程（窗口、IPC、持久化存储）
│   │   ├── index.ts          # 应用生命周期与窗口管理
│   │   ├── ipc.ts            # IPC 通道（读文件、最近列表、进度）
│   │   └── store.ts          # JSON 持久化（原子写/节流写/损坏回退）
│   ├── preload/              # 预加载脚本（contextBridge 安全桥接）
│   ├── renderer/
│   │   └── src/
│   │       ├── components/   # Vue 组件（阅读视图、注释侧栏、目录抽屉等）
│   │       ├── composables/  # 状态组合（开书流程、阅读器状态、设置）
│   │       ├── parser/       # 注释解析内核（三遍扫描 + 注释图 + 渲染）
│   │       │   ├── scan.ts   #   Pass A 词法：标记识别、类型词表、代码保护
│   │       │   ├── preprocess.ts # Pass A：归一扫描与定义收集
│   │       │   ├── graph.ts  #   Pass B：注释图（层级/环/孤儿）
│   │       │   ├── render.ts #   Pass C：分章渲染（markdown-it + KaTeX）
│   │       │   └── worker/   #   Web Worker 入口
│   │       └── styles/       # 主题、排版、注释卡片样式
│   └── shared/               # 主进程与渲染层共享类型
└── tests/                    # Vitest 单元测试
```

## 致谢

- [思源宋体 / Noto Serif SC](https://github.com/adobe-fonts/source-han-serif)（正文正文字体）
  —— Copyright 2014-2023 Adobe & Google，SIL OFL 1.1；
- [霞鹜文楷 / LXGW WenKai](https://github.com/lxgw/LxgwWenKai)（注释与界面字体）
  —— Copyright 2020-2023 LXGW，基于 Fontworks Klee One 改作，SIL OFL 1.1；
- [KaTeX](https://katex.org/) —— 数学公式排版；
- [heti](https://github.com/sivan/heti) —— 「赫蹏」中文排版规范的灵感；
- [Electron](https://www.electronjs.org/)、[Vue](https://vuejs.org/)、
  [markdown-it](https://github.com/markdown-it/markdown-it)、
  [electron-vite](https://electron-vite.org/) —— 承载这一切的地基。

## 许可证

- 本项目代码以 [MIT License](LICENSE) 授权；
- 随包发行的思源宋体与霞鹜文楷字体以 SIL Open Font License 1.1 授权，
  详见 [THIRD-PARTY_NOTICES.md](THIRD-PARTY_NOTICES.md)（含全部第三方组件清单）。

---

## English Brief

**ZhuMo** is a Markdown reader built for annotated Chinese academic texts.
Instead of flattening footnotes into an end-of-file list, it parses the whole
document into a note graph: footnotes may nest inside footnotes, each note
carries a precise level, type (translator / editor / textual / original /
commentary), and reference count, and the body column is mirrored by a
sidebar of note cards that follow your reading position.

Supported note syntax includes GFM footnotes (`[^label]` … `[^label]: …`),
Chinese-style markers (`[注3]` … `注3：……`), inline notes (`^[...]`),
and typed labels (`[^译者:序1]`); code blocks and code spans are fully
protected from parsing. See the Chinese sections above for the complete
grammar, known limitations (bare `[1]` references are not supported in v1),
and Windows development notes.

Built with Electron, Vue 3 and TypeScript. MIT licensed; bundled fonts are
under SIL OFL 1.1.
