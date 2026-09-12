# 琉璃：扩展光与字形

全局阅读设置提供「琉璃光效」和「字体」。SDR 为默认阅读输出，HDR 为展示输出；选择保存在用户资料中的 settings.json。HDR 选择独立于流动、静谧和关闭。只有琉璃、光效开启、浏览器报告 dynamic-range: high、WebGPU 扩展输出可用时，HDR 才实际启用；设置显示实际状态。改变显示器、关闭系统 HDR 或丢失 GPU 时回到 SDR，保留用户选择。

## 输出方式

光场共用 WebGPU 设备并按显示帧集中提交。琉璃背景与文字荧光直接由 GPU 输出 rgba16float，toneMapping 为 extended，颜色空间 sRGB，预乘透明度。引线、标题与回声按实际更新呈现，回声只复制更新区域。背景只扩展高亮光峰，正文和界面的普通字色不作曝光放大。具体实现与实测范围见 [HDR 性能](hdr-performance.md)。

这是对程序光场的扩展亮度输出，不声称实现 HDR10 母版元数据。参考 [Chromium WebGPU HDR 说明](https://developer.chrome.com/blog/new-in-webgpu-129) 与 [扩展亮度提案](https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md)。普通截图会被转成 SDR，不能证明显示器实际亮度。

## 文字与光的位置

ReadingColorLight 通过原生 CSS Highlights 给原文着色；主荧光位于对应段落或单元格自己的坐标系里，随浏览器合成器滚动。正文不添加逐字包装，不复制字形。跨行分别保留矩形，改变字体、窗口和虚拟章节挂载后重新测量。主荧光没有惯性位移；外围光最多偏移 7 CSS px，停止滚动后按 420 ms 时间常数衰减。

AI 给出的字色和荧光主色保持独立。readingPalette 由荧光色的 OKLab 坐标派生低饱和邻近色相，主色占渐变中间的大部分。派生色不增加语义标记；语义仍来自 AI 给出的两种颜色。

## 字体与保存

UI、正文、注释分别选择字体，支持常见 TTF、OTF、WOFF、WOFF2。导入后复制到用户资料 fonts/，按 SHA-256 去重；设置仅保存字体编号。原字体被移动后仍可使用。读取时校验字节，浏览器解析失败或缺字时使用备用字形；更新程序不依赖安装目录里的外部字体文件。公式保留各自的数学字体，代码块保留等宽排版。

## Markdown 检查范围

保留现有 KaTeX 快速路径、MathJax SVG 扩展与原文保底。补充完整裸 AMS 环境，支持 equation、align、alignat、flalign、gather、multline、displaymath、eqnarray 及其星号形式。没有闭合或互相不匹配的环境留为可读原文。普通 tex/latex 代码围栏仍显示源代码，math 围栏渲染公式。

新增 GFM 任务列表与自动链接，回归表格、转义管道、中文强调、删除线、嵌套引用、注释内公式、方程前向引用、连分式、分段函数、多列对齐、化学式和 physics 扩展。HTML 不执行。兼容性结果对应这些具体样例，不代表所有 TeX 宏包或所有阅读器的横向排名。
