# 第三方组件与字体声明（Third-Party Notices）

朱墨 ZhuMo 是一款自由开源软件。本文件汇总发行包中随附的主要第三方组件及其许可证，
以便使用者知悉各组件的权利归属。以下清单按 `package.json` 中的实际依赖整理；
各组件的传递依赖（transitive dependencies）随 `node_modules` 一并携带各自的原版许可证文件，
不在本文件中逐一罗列。

## 1. 运行时平台

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | MIT | 跨平台桌面应用框架 |
| [Chromium](https://www.chromium.org/) | BSD-3-Clause 等 | 由 Electron 内嵌，含众多第三方组件，许可证见其源码树 |
| [Node.js](https://nodejs.org/) | MIT | 由 Electron 内嵌 |

## 2. 运行时依赖（npm `dependencies`）

| 组件 | 许可证 |
| --- | --- |
| [@electron-toolkit/preload](https://github.com/alex8088/electron-toolkit) | MIT |
| [@electron-toolkit/utils](https://github.com/alex8088/electron-toolkit) | MIT |
| [@fontsource/noto-serif-sc](https://fontsource.org/) | MIT（打包脚本；字体本体为 SIL OFL 1.1，见下） |
| [@mdit/plugin-katex](https://mdit-plugins.github.io/) | MIT |
| [KaTeX](https://katex.org/) | MIT |
| [lxgw-wenkai-webfont](https://github.com/chawyehsu/lxgw-wenkai-webfont) | SIL OFL 1.1（字体本体，见下） |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT |
| [markdown-it-cjk-friendly](https://github.com/tats-u/markdown-it-cjk-friendly) | MIT |

## 3. 开发依赖（npm `devDependencies`）

| 组件 | 许可证 |
| --- | --- |
| @electron-toolkit/eslint-config-prettier | MIT |
| @electron-toolkit/eslint-config-ts | MIT |
| @electron-toolkit/tsconfig | MIT |
| @types/markdown-it | MIT |
| @types/node | MIT |
| @vitejs/plugin-vue | MIT |
| electron | MIT |
| electron-builder | MIT |
| electron-vite | MIT |
| eslint | MIT |
| eslint-plugin-vue | MIT |
| prettier | MIT |
| typescript | Apache-2.0 |
| vite | MIT |
| vue | MIT |
| vue-eslint-parser | MIT |
| vue-tsc | MIT |
| vitest | MIT |

## 4. 字体（SIL Open Font License 1.1）

本项目随包发行两款中文字体的网页字体版本，二者皆以 SIL Open Font License 1.1 授权，
完整许可证文本见本节末尾。依据 OFL 1.1 条款，字体可以随任意软件打包、再分发与出售，
但不得单独出售字体本体，且衍生字体不得沿用保留字体名（Reserved Font Name）。

### 4.1 思源宋体 / Noto Serif SC

- 组件来源：npm 包 `@fontsource/noto-serif-sc`（正文字体）
- 版权：Copyright 2014-2023 Adobe (http://www.adobe.com/) 与 Google
- 许可：SIL Open Font License 1.1
- 保留字体名（Reserved Font Name）：Source

### 4.2 霞鹜文楷 / LXGW WenKai

- 组件来源：npm 包 `lxgw-wenkai-webfont`（注释与界面字体）
- 版权：Copyright 2020-2023 LXGW (https://lxgw.github.io/)，基于 Fontworks 公司的
  Klee One（Copyright 2020 Fontworks Inc.）改作
- 许可：SIL Open Font License 1.1
- 保留字体名（Reserved Font Name）：Klee One

### SIL Open Font License 1.1 完整文本

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

朱墨 ZhuMo 本体以 MIT 许可证授权，见仓库根目录的 `LICENSE` 文件。
