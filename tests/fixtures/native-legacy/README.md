# 旧版原生帮助程序夹具

`ConditionalDelete-30aaa6f.cs` 原样取自本仓库提交 `30aaa6f` 的 `build/native/ConditionalDelete.cs`。它尚不支持 `zhumo-path-attributes-v1`，且在识别未知操作前要求 `path` 字段。

`native-path-inspection.test.ts` 在独立临时目录编译此文件，验证新调用方收到明确的 `Unknown operation` 后才使用既有路径验证。真实拒绝、无效计划、超时或缺少完整确认都不能借此跳过验证。测试不会替换实际程序中的帮助程序。
