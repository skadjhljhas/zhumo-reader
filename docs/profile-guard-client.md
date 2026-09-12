# 原生资料守护客户端

`src/main/profile-guard-client.ts` 为主进程/更新协调进程提供启动和监督接口。它配合 `profile-guard.ts` 持有旧版 Electron 使用的原生单实例锁；现有 `update-admission.ts` 仍负责持久的更新准入与未完成事务记录。

**这是可供更新协调者调用的组件，尚未接入最终安装器。** 它不替换更新事务、不自动安装新版本，也不替代快照、逐文件归属校验、迁移验证和恢复协调者。

## 调用顺序

1. 正常保存并退出旧朱墨；调用 `admitUpdate`，保护需要修改的资料目录与程序目录。
2. 用受信任、经过包清单校验的暂存 Electron 可执行文件调用 `startProfileGuard`。该可执行文件必须位于受保护程序目录和资料目录之外。不要把即将移动/删除的程序本身当作守护进程。
3. 启动成功后，立即监听 `client.signal`/`client.failure`。任何失锁、状态不可证实或意外退出，都必须停止新的写入及版本发布。
4. 在快照与进入写入前调用 `await client.assertHeld()`。然后 `admission.markMutating(transactionPath)`，在持久事务记录和守护监督下实施写入。长任务向保存/复制组件传入 `client.signal`；不能只在整个更新结束时检查一次。
5. 完成原文稿、配置及程序验证后，调用 `await admission.complete(verify)`，再 `await client.release()`。取消尚未写入的准备阶段则先 `admission.cancel()`，再释放守护。
6. 验证失败、守护失联或写入中取消：保留 mutating 记录与恢复计划，进入恢复流程。**不得为了结束等待直接 `cancel()`、删除记录或杀死守护。**

```ts
const admission = admitUpdate([profile, oldProgram], coordinator)
const guard = await startProfileGuard({
  executable: verifiedStagedExecutable,
  profile,
  programRoots: [oldProgram],
  coordinator,
  workParent: existingGuardWorkspace,
  appName: previousAppName,
  admission
})

// The coordinator must register and persist its failure/recovery handling here.
// guard.signal is suitable for createPreservationSnapshot(..., { signal }).
await guard.assertHeld()
await createPreservationSnapshot([profile], snapshot, { signal: guard.signal })
await guard.assertHeld()
admission.markMutating(transactionPath)
// Apply journaled changes while observing guard.signal; verify before publication.
await admission.complete(verifyWholeTransaction)
await guard.release()
```

这是顺序示意，省略了完整协调者的异常处理、跨进程恢复接管和版本切换，不能直接作为安装脚本复制。`appName` 必须来自原来的 `app.getName()`；不要根据 exe 文件名猜测。开发测试允许通过 `args: [absoluteBuiltMainEntry]` 指定入口，正式暂存程序不传该参数。

## 具体保证

- 仅支持 Windows。`spawn` 使用 `windowsHide: true`、`shell: false` 和独立管道，不创建终端、不抢焦点。
- 从子进程环境中删除 `ELECTRON_RUN_AS_NODE`（包括大小写变体），不能将它设为空字符串。
- 使用 `physical-fs`，避免 Electron 把 `app.asar` 当成虚拟目录的文件系统行为。客户端不会写入受保护的用户资料或文稿。
- 在明确的工作父目录下创建唯一 `zhumo-profile-guard-*` 目录，保存排他创建并 fsync 的计划。守护自己的 Chromium `scratch` 是这个目录的子目录。
- 校验 ready 的实际启动子进程 PID、更新 token、版本、零窗口、scratch 绑定以及精确的本机命名管道格式。外部主机或任意命名管道地址均拒绝。
- ready 文件限制 4096 字节，拒绝符号链接与文件身份变化；允许守护首次“创建文件→写入内容”的短暂半写状态，仍受启动总期限限制。
- 随机生成 256 bit 控制口令，所有状态/释放命令均认证。只读 ready 文件不代表已持锁，必须完成状态握手才返回客户端。
- 每次命令都有总时间限额与响应大小限制；慢速不断发送字节不能无限延长等待。响应内容、控制口令和子进程输出不进入异常文本。
- 默认启动期限 30 秒、命令期限 5 秒、心跳间隔 1 秒、释放后退出期限 10 秒；所有期限使用定时器和单调时钟，不依赖用户修改系统时间。控制联系宽限取 `max(10 秒, 心跳间隔 + 命令期限 + 2 秒)`，写入计划并要求 ready 原样回显；较慢的自定义查询频率不会被固定短宽限误判，未支持此协议的旧守护不会被静默接受。
- 子进程退出事件与认证管道心跳同时监督。状态必须为 `held: true`、`windows: 0`、`scratchBound: true`，否则触发永久失效状态。`parentChannelClosed` 必须是布尔值，但只是诊断信息：真实 Windows GUI Electron 可能从启动时就没有可读的 stdin；这不等于原生锁丢失或当前认证管道失联。后来的正常心跳不会把已经失效的事务重新当成安全状态。
- `signal` 被中止，`failure` **resolve 一个错误**，不会制造未处理的 rejected promise。`exited` 报告具体退出码/信号；正常释放并不会触发 failure。正常生命周期中 `failure` 可以一直 pending，不应单独无限等待它。
- `assertHeld` 合并并发状态查询；释放等待已经发出的状态请求完成，避免正常解锁被迟到的心跳误判。
- `release` 首先检查本地持久准入，守护服务端再检查一次。原事务仍存在或相关资料有 mutating 写入者时拒绝释放。拒绝本身不代表失锁，完成验证后可重试。
- 只有认证释放应答和子进程正常退出均成立才清理自己的临时目录。清理前核对原始目录 dev/ino、真实绝对路径和指定父目录范围；不会递归删除 profile、程序目录或整个工作父目录。清理失败保留目录，再次 `release()` 可以重试清理。

## 启动失败和取消

`signal` 只控制启动过程；成功返回后它的后续取消不解锁守护。调用者应使用 `client.signal` 监督持锁状态。

已经创建守护工作目录后的启动失败会尝试 `admission.cancel()`。这个原有 API 在 mutating/finishing 阶段会拒绝，客户端保留这一拒绝，不绕过它。随后关闭自己与守护的父通道，**从不调用 `kill`、不终止用户阅读器**。守护依据持久准入状态决定何时安全退出。子进程退出且没有原事务/相关 mutating 写入者后才清理临时文件。

进入函数前已经取消、参数/路径不合法等前置失败没有改变准入，调用者仍需处理自己的 admission。启动已经失败但守护未退出时，错误的 `directory` 字段指向保留的恢复计划；不能假设一次错误就等于锁已经释放。进程崩溃后、状态不可验证时、父进程退出后还未执行异步清理时，都可能留下工作目录，这比猜测安全后删除它更合适。

## 信任与尚未闭合的边界

- 这是同一用户下的进程协调机制。随机口令和管道格式校验防止意外连错进程，不是对同账户恶意代码的沙箱。计划内含控制口令，不能提交、分享或输出到日志；工作父目录应使用用户私有目录。POSIX mode 参数在 Windows 上不等于重新设置 NTFS ACL。
- 此接口仅启动并监督**自己创建的**子进程，不支持给任意 PID 发 kill，也不支持接管已有守护。完整恢复协调者还需验证原计划/准入身份，再设计带身份校验的重连与恢复路径。
- 守护消失到客户端得知消失之间存在进程事件/心跳传递延迟。`assertHeld` 是一次确认，不是未来永不失锁的承诺；协调者必须在整个写入与发布过程监听失败、持久化每步事务，异常时禁止把混合状态当作成功版本。
- 客户端不取消已经在系统调用中执行的不可中断写入，也不提供跨文件原子性。持久化恢复记录、不可覆盖原稿策略和验证完成后的发布仍是更新协调者的责任。
- 启动超时不会强制终止一个卡住但可能仍在保护写入的 helper；恢复记录可能保留。正常服务端收到父通道 EOF 后会在安全状态下自行退出。
- 服务端用成功认证的 `status`/`release` 控制消息更新单调时间 `lastControlContact`。stdin 关闭只允许开始检查孤儿状态；有近期认证消息时不会自动退出。只有父通道不可用、控制联系超过协商宽限、原事务已不存在且无相关 mutating 写入者，才经过额外 2 秒确认后自行退出。任何未授权消息都不能续期。客户端持续心跳时，完成 admission 后可以继续查询和稍后释放，无须赶在 2 秒内发送 release；真正失去父进程和心跳的安全孤儿仍会退出。
- `profile-guard-client.spec.ts` 是真实 Electron 原生锁集成用例，使用临时复制的旧 24，验证持锁、阻止重启和释放前后的资料字节。此组件及该用例均不等于最终安装器已闭合。

## 验证

```powershell
npm.cmd exec vitest -- run tests/main/profile-guard-client.test.ts
npm.cmd run typecheck:node
npm.cmd exec eslint -- src/main/profile-guard-client.ts tests/main/profile-guard-client.test.ts
```

单元测试使用系统临时目录内的隔离 profile 和 Node 服务端，不调用 Electron，不打开窗口，不读真实配置、不访问候选目录、也不调用模型 API。覆盖身份错误、首次 ready 半写、准备与 mutating 阶段取消、错误/超长/慢速/中断响应、持续心跳失锁、进程意外退出、提前释放拒绝、心跳与释放并发，以及正常退出后的限定范围清理。

两个真实 Electron 用例必须串行、隐藏运行：`profile-guard-client.spec.ts` 验证完成 admission 后继续心跳 **13.5 秒**（超过默认联系宽限与孤儿确认期之和），守护仍可查询和释放；`profile-guard.spec.ts` 验证 mutating 事务在超过认证联系宽限且父通道关闭后继续持锁，以及没有事务的孤儿在持续未授权流量下仍自行退出。它们只启动临时复制的旧候选和独立 profile。
