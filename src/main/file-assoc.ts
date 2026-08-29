/**
 * 朱墨 ZhuMo —— Windows 文件关联自注册（T26：便携版「解压即有 .md 打开方式」）。
 *
 * 背景：安装版（NSIS）由 electron-builder 的 fileAssociations 在安装时写注册表
 * （按用户安装写入 HKCU\Software\Classes，ProgId 为 yml 中 fileAssociations[].name，
 * 即「Markdown 文档」）；便携版（zip 解压 / portable 单文件）没有任何安装环节，
 * 因此由应用在启动时把自己注册到「当前用户」注册表——无需管理员权限。
 *
 * ProgId 决策：便携版使用独立 ProgId「ZhuMoPortable.Assoc」，不复用安装版的
 * 「Markdown 文档」。原因：同一 ProgId 键只持有一份 shell\open\command，两者复用
 * 必然互相覆盖（后写者胜），且便携版解除 / 注册表自愈时会同键删除，连带破坏
 * 安装版关联；独立 ProgId 则与 NSIS 注册互不触碰（OpenWithProgids 只增删自己的
 * 值），共存语义清晰。实测证据见 .perf/t26-registry-verify.mjs 的运行报告。
 *
 * 实现约束：
 * - 注册表只能经 reg.exe 子进程读写（node:fs 不适用于注册表），全部以 spawn
 *   参数数组传参、不经 shell 拼接，路径含空格 / 中文均安全（引号转义由 argv
 *   数组语义保证，见 buildAssocArgs 单测）；
 * - reg.exe 控制台输出按系统 OEM 代码页编码（中文系统为 GBK），Node 默认 utf8
 *   解码非 ASCII 会乱码，故对 stdout 同时给出 utf8 与 gbk 两个候选解码参与匹配
 *   （见 decodeRegOutput）；ASCII 路径下两候选等价，中文路径下取 gbk 命中；
 * - 所有注册表写入失败仅 console.warn 不抛错（注册表被策略锁 / 杀软拦截等），
 *   绝不影响应用启动与阅读主流程；
 * - 本模块零 Electron 依赖（app.isPackaged 由调用方传入），纯函数可直接单测。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 便携版 ProgId（独立于 NSIS 安装版的「Markdown 文档」，理由见模块注释） */
export const ASSOC_PROG_ID = 'ZhuMoPortable.Assoc'

/** 参与关联的扩展名（与安装版 fileAssociations 对齐；.txt 交由用户自选默认程序，不抢） */
export const ASSOC_EXTENSIONS = ['.md', '.markdown'] as const

/** NSIS 安装版的 ProgId：electron-builder.yml fileAssociations[].name（yml 改名需同步此处） */
export const NSIS_PROG_ID = 'Markdown 文档'

/** ProgId 显示名（资源管理器右键「打开方式」列表中呈现的文字） */
export const ASSOC_DISPLAY_NAME = '朱墨 ZhuMo（便携版）'

/** shell\open 动作的菜单文字 */
const VERB_LABEL = '用朱墨打开'

/** 只写当前用户注册表根（与 NSIS 按用户安装同一根，无需管理员权限） */
const REG_ROOT = 'HKCU\\Software\\Classes'

/** buildAssocArgs 的动作形态 */
export type AssocAction = 'add' | 'delete' | 'query'

/**
 * 注册表 shell\open\command 应写入的值："<exePath>" "%1"（exePath 代入后带引号）。
 * exePath 恒加引号（含空格路径必需，无空格亦合法）；"%1" 加引号保留长文件名。
 */
export function assocCommandFor(exePath: string): string {
  return `"${exePath}" "%1"`
}

/**
 * 构造 reg.exe 参数向量（纯函数，单测覆盖引号 / 空格 / 中文 / 三种动作）。
 * 返回「一批」reg.exe 调用：每个元素是一次 spawn('reg.exe', args) 的完整参数数组。
 * - add：ProgId 五段树 + 各扩展名 OpenWithProgids 增加自己的值（只增己项不动他项）
 * - delete：删整个 ProgId 键 + 各扩展名 OpenWithProgids 仅删自己的值
 * - query：只查 shell\open\command 默认值（exePath / iconPath 不参与）
 * iconPath 缺省取 exe 旁 resources\icon.png（与安装版图标单源一致），
 * 是否存在由调用方经 assocIconFor 解析后传入。
 */
export function buildAssocArgs(
  action: AssocAction,
  exePath: string,
  progId: string,
  iconPath: string = join(dirname(exePath), 'resources', 'icon.png')
): string[][] {
  const progKey = `${REG_ROOT}\\${progId}`
  if (action === 'query') {
    return [['query', `${progKey}\\shell\\open\\command`, '/ve']]
  }
  if (action === 'delete') {
    const batches: string[][] = [['delete', progKey, '/f']]
    for (const ext of ASSOC_EXTENSIONS) {
      batches.push(['delete', `${REG_ROOT}\\${ext}\\OpenWithProgids`, '/v', progId, '/f'])
    }
    return batches
  }
  // add：命令值恒为 "<exePath>" "%1"（引号内含空格 / 中文均安全）
  const batches: string[][] = [
    ['add', progKey, '/ve', '/d', ASSOC_DISPLAY_NAME, '/f'],
    ['add', `${progKey}\\DefaultIcon`, '/ve', '/d', `"${iconPath}"`, '/f'],
    ['add', `${progKey}\\shell`, '/ve', '/d', 'open', '/f'],
    ['add', `${progKey}\\shell\\open`, '/ve', '/d', VERB_LABEL, '/f'],
    ['add', `${progKey}\\shell\\open\\command`, '/ve', '/d', assocCommandFor(exePath), '/f']
  ]
  for (const ext of ASSOC_EXTENSIONS) {
    batches.push([
      'add',
      `${REG_ROOT}\\${ext}\\OpenWithProgids`,
      '/v',
      progId,
      '/t',
      'REG_SZ',
      '/d',
      '',
      '/f'
    ])
  }
  return batches
}

/** 归一化路径用于比较：去引号、小写、正斜杠统一为反斜杠 */
function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/^"+|"+$/g, '')
    .toLowerCase()
    .replace(/\//g, '\\')
}

/**
 * 从关联 command 值中提取 exe 路径：带引号取首对引号内，
 * 无引号取首个空白前段；无法解析返回 null（纯函数）。
 */
export function exeFromCommand(command: string): string | null {
  const s = command.trim()
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    return end > 0 ? s.slice(1, end) : null
  }
  const m = /^\S+/.exec(s)
  return m ? m[0] : null
}

/** 关联 command 值是否指向给定 exe（大小写与斜杠方向不敏感，纯函数） */
export function commandPointsTo(command: string, exePath: string): boolean {
  const exe = exeFromCommand(command)
  if (exe === null) return false
  const target = normalizePath(exePath)
  return target.length > 0 && normalizePath(exe) === target
}

interface RegRunResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

/** 运行一次 reg.exe（spawn 参数化，不经 shell；错误 / 退出码都收敛为结果不抛错） */
function runReg(args: readonly string[]): Promise<RegRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('reg.exe', [...args], { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject) // ENOENT 等进程级故障
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    )
  })
}

/**
 * reg.exe 控制台输出的候选解码：utf8 恒在；字节含非 ASCII 时补 gbk
 * （中文系统 OEM 代码页；Node 带 full-icu 时可用，否则静默省略）。
 * 匹配方对全部候选取「任一命中」，乱码候选不会误匹配真实路径。
 */
export function decodeRegOutput(raw: Buffer): string[] {
  const candidates = [raw.toString('utf8')]
  if (raw.some((b) => b > 0x7f)) {
    try {
      candidates.push(new TextDecoder('gbk').decode(raw))
    } catch {
      /* 运行时无 gbk 解码器时忽略 */
    }
  }
  return candidates
}

/** 从 reg query 输出提取 REG_SZ 数据：取首个含 REG_SZ 的行（区域无关），无则 null */
export function parseRegQueryData(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /REG_SZ[ \t]+(.+)$/.exec(line)
    if (m) return m[1].trim()
  }
  return null
}

/**
 * 查询某 ProgId 的 shell\open\command 值。
 * 返回各候选解码下的数据串（ASCII 路径时单元素；含中文时含 gbk 候选）；
 * 键不存在（退出码 1）或查询失败返回 []，绝不抛错。
 */
export async function queryProgIdCommand(progId: string): Promise<string[]> {
  const [args] = buildAssocArgs('query', '', progId)
  let result: RegRunResult
  try {
    result = await runReg(args)
  } catch (error) {
    console.warn('[zhumo] 文件关联查询失败（无法调用 reg.exe）：', error)
    return []
  }
  if (result.code !== 0) return [] // 1 = 键不存在（尚未注册）
  return decodeRegOutput(result.stdout)
    .map(parseRegQueryData)
    .filter((v): v is string => v !== null)
}

/** 某 ProgId 的关联命令是否指向给定 exe（供便携自检与 NSIS 覆盖判断） */
export async function progIdPointsTo(progId: string, exePath: string): Promise<boolean> {
  const commands = await queryProgIdCommand(progId)
  return commands.some((command) => commandPointsTo(command, exePath))
}

/** 便携版关联是否已生效（ProgId 存在且 command 指向当前 exe）——路径自愈的判断依据 */
export async function isFileAssocActive(exePath: string): Promise<boolean> {
  return progIdPointsTo(ASSOC_PROG_ID, exePath)
}

/** exe 旁的图标来源：resources\icon.png 存在则与安装版同源，否则用 exe 内嵌图标 */
export function assocIconFor(exePath: string): string {
  const png = join(dirname(exePath), 'resources', 'icon.png')
  return existsSync(png) ? png : exePath
}

/**
 * 注册便携版文件关联（幂等，可重复调用刷新）。
 * 任一步失败仅 console.warn 并返回 false，绝不抛错（如注册表被策略锁定）。
 */
export async function registerFileAssoc(exePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const batches = buildAssocArgs('add', exePath, ASSOC_PROG_ID, assocIconFor(exePath))
  for (const args of batches) {
    try {
      const result = await runReg(args)
      if (result.code !== 0) {
        console.warn(
          '[zhumo] 文件关联注册失败：',
          args.join(' '),
          decodeRegOutput(result.stderr)[0]?.trim() ?? ''
        )
        return false
      }
    } catch (error) {
      console.warn('[zhumo] 文件关联注册失败（无法调用 reg.exe）：', error)
      return false
    }
  }
  return true
}

/**
 * 解除便携版文件关联：删除本 ProgId 整键 + 两扩展名 OpenWithProgids 里自己的值，
 * 不触碰其它程序（含 NSIS 安装版「Markdown 文档」）的任何注册。
 * 键 / 值本就不存在视为成功（幂等）；失败仅告警不抛错。
 */
export async function unregisterFileAssoc(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const batches = buildAssocArgs('delete', '', ASSOC_PROG_ID)
  for (const args of batches) {
    try {
      const result = await runReg(args)
      // 0 = 成功；1 = 键 / 值不存在（本就未注册，同为成功）；其余视为失败
      if (result.code !== 0 && result.code !== 1) {
        console.warn(
          '[zhumo] 文件关联解除失败：',
          args.join(' '),
          decodeRegOutput(result.stderr)[0]?.trim() ?? ''
        )
        return false
      }
    } catch (error) {
      console.warn('[zhumo] 文件关联解除失败（无法调用 reg.exe）：', error)
      return false
    }
  }
  return true
}

/**
 * 参与关联的 exe 路径：
 * - 常规形态（NSIS 安装 / zip 解压）＝ process.execPath 本体（稳定路径）；
 * - portable 单文件：进程从临时自解压目录运行，execPath 是易失路径，
 *   应注册用户手里那个常驻的启动器 exe（electron-builder 注入的
 *   PORTABLE_EXECUTABLE_FILE 环境变量），文件夹挪动后随自愈机制刷新。
 */
export function currentAssocExePath(): string {
  const portableFile = process.env['PORTABLE_EXECUTABLE_FILE']
  return typeof portableFile === 'string' && portableFile.trim() !== ''
    ? portableFile
    : process.execPath
}

/**
 * 启动期自注册 / 路径自愈（bootstrap 调用，fire-and-forget，内部绝不抛错）：
 * - 用户已关闭自注册 → 本次启动不注册，并顺手清理既有注册（幂等）；
 * - ProgId 已指向当前 exe → 无事可做（重复启动零写放大）；
 * - 安装版 NSIS 已为此 exe 注册关联 → 不重复注册（避免「打开方式」出现同 exe 双条目）；
 * - 其余（未注册 / 指向旧路径）→ 注册或刷新 command（便携目录挪动后下次启动自愈）。
 */
export async function ensureFileAssocStartup(options: {
  packaged: boolean
  isEnabled: () => Promise<boolean>
}): Promise<void> {
  try {
    if (process.platform !== 'win32' || !options.packaged) return
    if (!(await options.isEnabled())) {
      await unregisterFileAssoc()
      return
    }
    const exePath = currentAssocExePath()
    if (await isFileAssocActive(exePath)) return
    if (await progIdPointsTo(NSIS_PROG_ID, exePath)) return
    await registerFileAssoc(exePath)
  } catch (error) {
    console.warn('[zhumo] 文件关联自检未完成：', error)
  }
}
