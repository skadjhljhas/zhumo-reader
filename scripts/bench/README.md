# 性能基准（bench）

可复现的性能基准脚本：测「解析与首屏、滚动帧间隔、内存与 DOM、边界书解析」四组指标，
并与 [baseline.json](./baseline.json) 对比打印。整理自 T4 阶段的 `.perf/perf.mjs`（口径不变）。

## 怎么跑

```powershell
npm.cmd run build   # 前置：产出 out/renderer（bench 伺服该目录）
npm.cmd run bench
```

脚本自带静态预览服务器（复用根目录 `.serve.mjs`，伺服 `out/renderer` 于 4175 端口）：
端口上已有服务时直接复用，没有则自动拉起、跑完自动关闭。Edge 会话使用临时 profile，
用后即删，不污染机器。

### 参数化（环境变量）

| 变量                   | 默认值                                                         | 说明                                               |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `ZHUMO_BENCH_BOOK`     | `stress-50w`                                                   | 压测书：`phg-sample` / `edge-cases` / `stress-50w` |
| `ZHUMO_BENCH_BASE`     | `http://localhost:4175`                                        | 静态预览基址                                       |
| `ZHUMO_BENCH_EDGE`     | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Edge 可执行文件路径                                |
| `ZHUMO_BENCH_CDP_PORT` | `9225`                                                         | CDP 调试端口                                       |

## 指标口径

- **D7 解析与首屏**：`?book=<压测书>` 导航 → Worker 解析完成（首个 message）/
  首个 `.section-body` 可见（视口内 rect），3 轮取中位；每轮先清 localStorage 防进度恢复污染。
- **D8 滚动性能**：`scrollTop` 分步推进覆盖 ≥50% 全高，rAF 帧间隔统计
  avg / p95 / max 与掉帧率（>33ms 帧占比）；无头环境 rAF 被节流时退化为定时器驱动并在输出中标注。
- **D9 内存与 DOM**：滚动停在中部稳定 2s 后，`performance.memory.usedJSHeapSize`、
  DOM 节点数、挂载章数、注释卡数 + CDP `Performance.getMetrics`。
- **D11 edge-cases 边界书**：console 零 error / 零页面异常，解析警告计数与
  孤儿分组 / 缺失卡 / 循环环标记是否出现。

## 输出

- 控制台：逐项指标 + 与 baseline 的 Δ% 对比（±5% 内视为噪声）。
- `scripts/bench/report.json`：本次完整报告（含每轮明细与 console 摘录）。

## 基线（baseline.json）

采集于 2026-08-26（T8 收官基线刷新，stress-50w 书，三轮独立干净 Edge 会话取中位）：
worker 解析中位 575ms、首屏可见中位 878ms、滚动 avg 18.1ms / p95 28.9ms / 掉帧率 3.2%、
JS 堆 81.5MB、DOM 节点 32k（旧 2026-08-25 基线因 Edge 账号同步扩展污染已废弃）。
性能回归修复后请以新实测刷新本文件。
