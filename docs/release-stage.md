# 完整版本暂存与复核

`release-stage.ts` 将一个**受信发行包**复制到全新版本目录，供更新协调者之后切换 `current`。它不覆盖既有安装，不搬走旧 MD，不迁移用户设置，也不实现指针切换或完整安装器。

## 接口

```ts
stageRelease(
  sourceDir: string,
  destinationFreshDir: string,
  manifestBytes: string | Buffer,
  trustedManifestSha256: string,
  options?: {
    signal?: AbortSignal
    progress?: (files: number, bytes: number) => void | Promise<void>
  }
): Promise<{
  directory: string
  manifest: ProgramManifest
  manifestSha256: string
}>

verifyStagedRelease(
  directory: string,
  manifestBytes: string | Buffer,
  trustedManifestSha256: string
): Promise<{
  directory: string
  manifest: ProgramManifest
  manifestSha256: string
}>
```

`directory` 是核验后的真实绝对路径。新目录可由协调者指定为 `<稳定安装根>/.zhumo/versions/<UUID>`；组件不自行选择版本名。目标父目录必须已经存在，目标本身必须完全不存在，空目录也不会被当作可覆盖位置。

摘要必须来自独立受信的发布记录，不能在这里现算未知来源目录中的清单摘要并把它当作授权。组件使用现有 `readProgramManifest` 验证摘要、清单结构、安全的 Windows 相对路径、重复项与必需入口。调用方传入的 Buffer 在第一次异步操作前复制，后续改动原 Buffer 不会改变本次受信输入。

## 执行次序与不变量

1. 核验清单，再检查绝对源路径与全新目标。源和目的都不能是盘符/文件系统根，不能彼此包含。除了真实路径比较，还用父目录链的设备/文件身份排除源目录后代的路径别名。
2. 路径祖先、根目录、包内目录与文件都进行 `lstat` 检查，不静默跟随符号链接或 junction。源文件和被复核的版本文件也拒绝多链接计数的硬链接。
3. 源树必须精确属于清单：普通文件均已声明；允许唯一的额外根文件 `program-files.v1.json`，但它存在时也必须与外部受信字节大小/摘要相符。源清单可以缺席，此时以传入的受信清单为准。目录只能是清单文件所需的祖先，连额外空目录也不接受；不会深入未声明的用户文稿树后把它收编为程序。
4. 源的每个文件通过 `fileDigest` 检查真实大小、SHA-256 和读取期间身份/时间戳变化。读取前后再次清点全树，确认文件、目录与元数据没有变化。
5. 排他创建目标目录，只按受信清单创建必需子目录、复制所有文件。复用 `fileDigest` 的原生 `COPYFILE_EXCL` 和输出 `fsync`，不会覆盖一个并发出现的文件。MD 与其他发行文件一样复制到新版本，保留其 BOM、换行和所有字节；源 MD 从未打开为写入模式。
6. 每次复制前后检查相应目录身份，记录复制完成后的目标文件身份。保留源文件的基本 mtime/mode。原生复制沿用现有文件保存组件的行为；清单当前校验默认文件流，不声称已签署 NTFS ACL 或所有附加数据流。
7. 再次完整核验源树，并与最初快照比较。即使内容被换回相同字节，只要观察到文件身份、修改/状态时间、权限或目录内容变化，也拒绝把本次操作当成成功。
8. 排他写入**原样受信清单字节**并 `fsync`，然后全量核验目标文件与清单。对已经复制的文件再比较身份，防止相同字节的替换悄悄绕过变动检查。最后复查源/目标树及祖先，检查取消信号，才返回成功。

`physical-fs` 确保 Electron 中的 `resources/app.asar` 被当作实际磁盘文件，而不是虚拟目录。整个模块没有 `rename`、`unlink`、`rm`、递归删除或 `current` 写入操作。

## 取消、故障和恢复

`progress` 是“已经复制了多少文件/默认流字节”，不是提交通知；即便计数到达总量，后面仍有源/目标完整复核。回调可以是异步函数，抛错会中止暂存。取消在文件操作和哈希块之间检查，不能承诺中断已经进入内核的单次复制。

如果源在预检时就不合格，通常不会创建目标。目标一旦创建，任何取消、复制/校验失败、文件变动或 fsync 失败都会抛错并保留这个**未发布目录**，交给协调者的持久事务处理。组件不会为了清理现场删除或合并目录，也不会隐式返回一个“部分成功”。清单文件已经存在同样不代表成功：例如其 fsync 失败时，本次 stage 仍必须拒绝。

重启恢复和启动前使用 `verifyStagedRelease`，重新核验全部清单文件、元数据清单及树结构，拒绝遗漏、额外文件/目录、链接、损坏及检查期间变动。它只提供当前完整性证据，不切换指针，不自动判定某个未完成事务应提交还是回滚。协调者应将事务记录放在版本目录之外，避免把自身恢复日志混入发行包。

协调者负责保持输入包和目标版本目录在暂存/发布期间不被其他写入者使用，并在需要时重新复核。路径/身份的前后检查不是针对同账户恶意进程反复交换目录的原生目录句柄沙箱；本模块也不提供跨文件瞬时快照或保证成功返回后目录永远不变。`current` 的原子替换、旧进程退出、用户资料快照和实际版本启动核对由外层负责。

## 本次验证范围

纯 Node 小型文件夹用例覆盖完整复制与再次验证、MD 字节保留、受信 Buffer 所有权、旧目录拒绝、盘根/嵌套拒绝、额外/损坏源、取消后保留、源和目的在回调中被修改、相同字节但身份替换、文件及清单 fsync 失败、根/成员/父路径 junction、硬链接、目的目录被 junction 替换，以及启动前再次发现未知文件或损坏。

```powershell
npm.cmd exec vitest -- run tests/main/release-stage.test.ts
npm.cmd run typecheck:node
npm.cmd exec eslint -- src/main/release-stage.ts tests/main/release-stage.test.ts
```

测试仅使用系统临时目录和几字节的假 exe/asar；不执行这些文件，不启动 Electron，不调用模型，不读取真实 profile 或用户文稿。完整安装器和崩溃恢复协调流程尚需外层集成验证。
