/**
 * 朱墨 ZhuMo —— 文件关联自注册纯函数单测（T26，纯 Node 环境零注册表副作用）。
 *
 * 覆盖：buildAssocArgs 三种动作的参数向量形态（ProgId 键路径 / command 值
 * 引号包裹 / 空格与中文路径 / OpenWithProgids 只写己值），
 * assocCommandFor / exeFromCommand / commandPointsTo 的命令解析与归一化比较，
 * decodeRegOutput 的 utf8 + gbk 双候选解码，parseRegQueryData 的输出解析，
 * currentAssocExePath 的 PORTABLE_EXECUTABLE_FILE 优先级。
 * 真实注册表行为（注册 → 自愈 → 解除）由 .perf/t26-registry-verify.mjs 实测。
 */
import { describe, expect, it } from 'vitest'
import {
  ASSOC_DISPLAY_NAME,
  ASSOC_EXTENSIONS,
  ASSOC_PROG_ID,
  NSIS_PROG_ID,
  assocCommandFor,
  buildAssocArgs,
  commandPointsTo,
  currentAssocExePath,
  decodeRegOutput,
  exeFromCommand,
  parseRegQueryData
} from '../../src/main/file-assoc'

const PROG_KEY = 'HKCU\\Software\\Classes\\ZhuMoPortable.Assoc'

describe('buildAssocArgs：add', () => {
  const exe = 'C:\\Program Files\\ZhuMo\\ZhuMo.exe'
  const icon = 'C:\\Program Files\\ZhuMo\\resources\\icon.png'
  const batches = buildAssocArgs('add', exe, ASSOC_PROG_ID, icon)

  it('共 7 条 reg 命令：ProgId 五段树 + 两个扩展名的 OpenWithProgids', () => {
    expect(batches).toHaveLength(5 + ASSOC_EXTENSIONS.length)
  })

  it('ProgId 默认值为显示名；DefaultIcon 为引号包裹的图标路径', () => {
    expect(batches[0]).toEqual(['add', PROG_KEY, '/ve', '/d', ASSOC_DISPLAY_NAME, '/f'])
    expect(batches[1]).toEqual(['add', `${PROG_KEY}\\DefaultIcon`, '/ve', '/d', `"${icon}"`, '/f'])
  })

  it('shell 树：open 动作与 command 值 "<exe>" "%1"（含空格路径整体单参数）', () => {
    expect(batches[2]).toEqual(['add', `${PROG_KEY}\\shell`, '/ve', '/d', 'open', '/f'])
    expect(batches[3]).toEqual(['add', `${PROG_KEY}\\shell\\open`, '/ve', '/d', '用朱墨打开', '/f'])
    expect(batches[4]).toEqual([
      'add',
      `${PROG_KEY}\\shell\\open\\command`,
      '/ve',
      '/d',
      '"C:\\Program Files\\ZhuMo\\ZhuMo.exe" "%1"',
      '/f'
    ])
  })

  it('OpenWithProgids 只写自己的 ProgId（REG_SZ 空值存在性），不动其它值', () => {
    for (const [index, ext] of ASSOC_EXTENSIONS.entries()) {
      expect(batches[5 + index]).toEqual([
        'add',
        `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`,
        '/v',
        ASSOC_PROG_ID,
        '/t',
        'REG_SZ',
        '/d',
        '',
        '/f'
      ])
    }
  })

  it('中文路径原样进入参数向量（转义交由 spawn argv 数组，不经 shell 拼接）', () => {
    const zhExe = 'C:\\临时目录\\朱墨便携\\ZhuMo.exe'
    const zhBatches = buildAssocArgs('add', zhExe, ASSOC_PROG_ID, zhExe)
    const cmdBatch = zhBatches[4]
    expect(cmdBatch).toContain('"C:\\临时目录\\朱墨便携\\ZhuMo.exe" "%1"')
    expect(zhBatches[1]).toContain(`"${zhExe}"`)
  })
})

describe('buildAssocArgs：delete', () => {
  it('删 ProgId 整键 + 两扩展名仅删自己的值（不传 exePath 也可构造）', () => {
    const batches = buildAssocArgs('delete', '', ASSOC_PROG_ID)
    expect(batches).toHaveLength(1 + ASSOC_EXTENSIONS.length)
    expect(batches[0]).toEqual(['delete', PROG_KEY, '/f'])
    expect(batches[1]).toEqual([
      'delete',
      'HKCU\\Software\\Classes\\.md\\OpenWithProgids',
      '/v',
      ASSOC_PROG_ID,
      '/f'
    ])
    expect(batches[2]).toEqual([
      'delete',
      'HKCU\\Software\\Classes\\.markdown\\OpenWithProgids',
      '/v',
      ASSOC_PROG_ID,
      '/f'
    ])
  })

  it('delete 不触碰安装版 NSIS ProgId（「Markdown 文档」不出现在任何参数里）', () => {
    const flat = buildAssocArgs('delete', '', ASSOC_PROG_ID).flat().join(' ')
    expect(flat).not.toContain(NSIS_PROG_ID)
    expect(flat).not.toContain('Qoder')
  })
})

describe('buildAssocArgs：query', () => {
  it('仅查询 shell\\open\\command 默认值', () => {
    expect(buildAssocArgs('query', '', ASSOC_PROG_ID)).toEqual([
      ['query', `${PROG_KEY}\\shell\\open\\command`, '/ve']
    ])
  })
})

describe('assocCommandFor / exeFromCommand / commandPointsTo', () => {
  it('command 形如 "<exe>" "%1"，可从中无损提取 exe 路径', () => {
    const exe = 'D:\\绿色软件\\朱墨 1.1.3\\ZhuMo.exe'
    const command = assocCommandFor(exe)
    expect(command).toBe(`"${exe}" "%1"`)
    expect(exeFromCommand(command)).toBe(exe)
  })

  it('无引号 command（历史安装版形态）也能提取 exe', () => {
    expect(exeFromCommand('C:\\Apps\\ZhuMo\\ZhuMo.exe "%1"')).toBe('C:\\Apps\\ZhuMo\\ZhuMo.exe')
  })

  it('command 指向判断：大小写与斜杠方向不敏感', () => {
    const exe = 'C:\\Temp\\朱墨T26\\ZhuMo.exe'
    expect(commandPointsTo(assocCommandFor(exe), exe)).toBe(true)
    expect(commandPointsTo(assocCommandFor(exe), 'c:/temp/朱墨t26/zhumo.exe')).toBe(true)
    expect(commandPointsTo(assocCommandFor(exe), 'C:\\Temp\\朱墨T26\\旧目录\\ZhuMo.exe')).toBe(
      false
    )
  })

  it('空串 / 乱串 / 不同中文路径一律不匹配（乱码候选不会误报 active）', () => {
    const exe = 'C:\\目录甲\\ZhuMo.exe'
    expect(commandPointsTo('', exe)).toBe(false)
    expect(commandPointsTo('   ', exe)).toBe(false)
    expect(commandPointsTo('garbage', exe)).toBe(false)
    expect(commandPointsTo('"C:\\目录乙\\ZhuMo.exe" "%1"', exe)).toBe(false)
  })
})

describe('decodeRegOutput / parseRegQueryData', () => {
  const hasGbkDecoder = (() => {
    try {
      new TextDecoder('gbk')
      return true
    } catch {
      return false
    }
  })()

  it('ASCII 输出经 utf8 候选即可解析出 REG_SZ 数据', () => {
    const raw = Buffer.from(
      '\nHKEY_CURRENT_USER\\Software\\Classes\\ZhuMoPortable.Assoc\\shell\\open\\command\r\n' +
        '    (Default)    REG_SZ    "C:\\Apps\\ZhuMo\\ZhuMo.exe" "%1"\r\n\r\n',
      'utf8'
    )
    const [utf8] = decodeRegOutput(raw)
    expect(parseRegQueryData(utf8)).toBe('"C:\\Apps\\ZhuMo\\ZhuMo.exe" "%1"')
  })

  it.skipIf(!hasGbkDecoder)(
    'GBK 字节流（中文系统控制台）：utf8 乱码但 gbk 候选命中中文路径',
    () => {
      // "中文" 的 GBK 字节：中 = D6 D0，文 = CE C4；整行："(默认)    REG_SZ    "中文\ZhuMo.exe" "%1""
      const raw = Buffer.from([
        0x20, 0x28, 0xd6, 0xd0, 0xce, 0xc4, 0x29, 0x20, 0x20, 0x20, 0x20, 0x52, 0x45, 0x47, 0x5f,
        0x53, 0x5a, 0x20, 0x20, 0x20, 0x20, 0x22, 0xd6, 0xd0, 0xce, 0xc4, 0x5c, 0x5a, 0x68, 0x75,
        0x4d, 0x6f, 0x2e, 0x65, 0x78, 0x65, 0x22, 0x20, 0x22, 0x25, 0x31, 0x22
      ])
      const candidates = decodeRegOutput(raw)
      // utf8 候选必然是乱码（不含「中文」字样），gbk 候选正确还原
      expect(candidates[0].includes('中文')).toBe(false)
      expect(candidates.some((c) => parseRegQueryData(c) === '"中文\\ZhuMo.exe" "%1"')).toBe(true)
    }
  )

  it('无 REG_SZ 的输出返回 null', () => {
    expect(parseRegQueryData('系统找不到指定的注册表项。')).toBeNull()
    expect(parseRegQueryData('')).toBeNull()
  })
})

describe('currentAssocExePath', () => {
  const ENV_KEY = 'PORTABLE_EXECUTABLE_FILE'
  const saved = process.env[ENV_KEY]

  it('portable 单文件：优先用启动器 exe（PORTABLE_EXECUTABLE_FILE）', () => {
    process.env[ENV_KEY] = 'D:\\随身盘\\朱墨\\ZhuMo-1.1.3便携版.exe'
    expect(currentAssocExePath()).toBe('D:\\随身盘\\朱墨\\ZhuMo-1.1.3便携版.exe')
  })

  it('常规形态：回落 process.execPath（空串环境变量同样回落）', () => {
    process.env[ENV_KEY] = ''
    expect(currentAssocExePath()).toBe(process.execPath)
  })

  it('测试后还原环境变量，不污染其它用例', () => {
    if (saved === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = saved
    }
    expect(true).toBe(true)
  })
})
