# 字形定位测试夹具

`palt-test.ttf` 为本项目生成的微型 TrueType 字体，仅包含简单矩形轮廓与 `palt` 的 GPOS 位移/进宽调整。按本仓库 MIT 许可证使用，不含第三方字体轮廓。`build-palt-font.py` 使用 FontTools 重新生成它；日常运行测试直接读取已经提交的 TTF，不依赖 Python。

它刻意把全角括号默认位置与 `palt` 位置拉开，使蒙版忽略字体定位特性时明显失败。相关检查在 `tests/e2e/glyph-mask-layout.spec.ts`，比较实际 DOM 截图与透明度蒙版，并保留抗锯齿容差。
