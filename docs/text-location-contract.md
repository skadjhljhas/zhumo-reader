# 文稿版本与文字地址

当前接口为 schema 1，公共实现由主线维护；主题与对读使用同一入口。版本、文字投影与失效规则如下。

## 版本

`textDocumentVersion(path, source)` 返回 `TextDocumentVersion`：路径、源文 UTF-16 长度、SHA-256、散列规则 `sha256-utf16le-1`、文字投影规则 `zhumo-search-text-1`。

路径沿用当前文稿会话中的完整路径或内置文稿标识。散列对象是原始 JavaScript 字符串的 UTF-16 码元，每个码元按小端序编码。BOM、CRLF/LF 与孤立代理码元均保留，不进行换行归一化或 Unicode 归一化。旧的 UTF-8 散列记录属于其他版本规则，不能更换名称后直接复用。当前不进行跨版本模糊迁移。

## 地址

`textAddress(version, book, entry, match)` 从已建立的检索块与精确字句生成 `TextAddress`。`parseTextAddress(unknown)` 检查持久化结构，返回独立副本或 `undefined`。地址含有：

- `schema: 1` 和完整文稿版本；
- 正文的 `sectionId`，或旁注的原始 `label`；旁注跳转时解析当前 `note.id`；
- `blockIndex`，即所属容器中 `searchBlocks(root, true)` 的序号；
- `match.start/end/text`，即该块投影文字的 UTF-16 半开区间及完整原句；
- 区间前、后各最多 48 个 UTF-16 码元作为上下文。

`searchTextParts(block, true)` 提供同一投影。注释标号不占文字位置；数学公式与 Mermaid 图解按源文作为原子呈现，定位其内部源文会突出整个对象。父列表项的投影不重复包含子列表块。不能把 DOM 的普通 `textContent` 直接当作这套坐标。

编辑位置同步的 `SourceBlock`、`documentPosition` 使用保留 BOM 的 LF 源文坐标；它们与检索投影的文字地址不同，也不能与滚动比例互换。

`validateTextAddress(address, currentVersion, currentBlockText)` 检查版本、边界、原句和上下文；返回 `valid`、`version-changed`、`invalid-address` 或 `text-changed`。不拆开 Unicode 代理对，也不把另一个同名词当作原来的位置。

## 导航

`await navigateTextAddress(address, { signal?, timeoutMs? })` 只执行阅读导航。调用者先处理自己的弹层和明确的编辑、保存切换；该入口不修改或保存文稿。旁注导航会打开旁注栏并退出专注布局。

成功结果为 `{ status: 'landed', kind, id, blockIndex }`。成功需要目标章节或旁注已挂载、正确的文字 Range 或原子对象已高亮、目标与其阅读视口相交，并连续观察到稳定几何。现有 `requestSearchLanding`、`requestSidebarLocate` 的返回本身不表示这些步骤完成。

未完成结果可能为 `cancelled`、`version-changed`、`invalid-address`、`text-changed`、`missing`、`not-reading`、`timeout`。切换文稿、修改源文、进入编辑、AbortSignal 或后续同类导航会取消等待。默认等待上限 7 秒，可在 100 毫秒至 12 秒间设置；该等待从验证并发出导航请求后开始。

正文首个隐藏一级标题映射到实际呈现的书名。普通文字检查真实的 Range 容器与偏移，公式、图解检查实际原子区域。沿用 `zhumo-search-match` 和 `search-source-landed`，高亮通常在 8 秒后淡出；返回 `landed` 不会延长其寿命。

## 消费者边界

主线维护身份、坐标、有效性与导航完成规则。对读保存两处明确选定的原文；主题回潮维护停留记录的采集与视觉呈现。记录容量、暂停、清除与撤销属于消费者策略；当前接口不提供多窗口持久化合并、跨版本迁移或阅读理解推断。
