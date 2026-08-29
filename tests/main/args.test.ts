/**
 * 朱墨 ZhuMo —— 启动参数解析单测（纯 Node 环境，不依赖 Electron）。
 *
 * 覆盖 parseBookArg 的两条入口形态：
 * - 首启 process.argv（生产：[ZhuMo.exe, 书路径]；dev：electron-vite 参数混入）
 * - 第二实例 commandLine（electron / win shell 展开后的参数数组）
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOK_EXTENSIONS, parseBookArg } from '../../src/main/args'

const EXE = 'C:\\Program Files\\ZhuMo\\ZhuMo.exe'
const DEV_EXE = 'C:\\proj\\zhumo\\node_modules\\electron\\dist\\electron.exe'

describe('parseBookArg：生产形态', () => {
  it('argv[1] 为书路径（含空格与中文），返回绝对路径原样保留', () => {
    expect(parseBookArg([EXE, 'C:\\a b\\书.md'])).toBe('C:\\a b\\书.md')
  })

  it('无文件参数返回 null（双击图标普通启动）', () => {
    expect(parseBookArg([EXE])).toBeNull()
    expect(parseBookArg([])).toBeNull()
  })

  it('扩展名大小写不敏感（.MD / .Markdown / .TXT）', () => {
    expect(parseBookArg([EXE, 'C:\\b\\X.MD'])).toBe('C:\\b\\X.MD')
    expect(parseBookArg([EXE, 'C:\\b\\note.Markdown'])).toBe('C:\\b\\note.Markdown')
    expect(parseBookArg([EXE, 'C:\\b\\memo.TXT'])).toBe('C:\\b\\memo.TXT')
  })

  it('.markdown 与 .txt 均在白名单（与读文件校验同源）', () => {
    for (const ext of BOOK_EXTENSIONS) {
      expect(parseBookArg([EXE, `C:\\b\\x${ext}`])).toBe(`C:\\b\\x${ext}`)
    }
  })

  it('相对路径解析为绝对路径', () => {
    expect(parseBookArg([EXE, 'fixtures\\phg-sample.md'])).toBe(
      resolve('fixtures\\phg-sample.md')
    )
  })

  it('取第一个命中的书路径', () => {
    expect(parseBookArg([EXE, 'C:\\1\\first.md', 'C:\\2\\second.md'])).toBe('C:\\1\\first.md')
  })
})

describe('parseBookArg：过滤规则', () => {
  it('过滤 electron 开关（--inspect / --remote-debugging-port 等）', () => {
    expect(
      parseBookArg([
        DEV_EXE,
        '--inspect',
        '--remote-debugging-port=9222',
        'C:\\b\\real.md'
      ])
    ).toBe('C:\\b\\real.md')
  })

  it('只含开关与无扩展名参数时返回 null', () => {
    expect(parseBookArg([DEV_EXE, '--inspect', '.', '--e2e'])).toBeNull()
    expect(parseBookArg([DEV_EXE, '.'])).toBeNull()
  })

  it('过滤非白名单扩展名（.exe / .pdf / 无扩展名）', () => {
    expect(parseBookArg([EXE, 'C:\\b\\readme.pdf'])).toBeNull()
    expect(parseBookArg([EXE, 'C:\\b\\README'])).toBeNull()
    // exe 自身路径永不被当作书
    expect(parseBookArg([EXE, 'C:\\b\\virus.exe'])).toBeNull()
  })

  it('URL 形态参数被过滤，盘符路径不被 scheme 规则误杀', () => {
    expect(parseBookArg([EXE, 'http://evil.example/x.md'])).toBeNull()
    expect(parseBookArg([EXE, 'file:///C:/books/a.md'])).toBeNull()
    // C:\ 与 C:/ 两种盘符分隔都放行（resolve 将 / 归一化为 \）
    expect(parseBookArg([EXE, 'C:/books/正.md'])).toBe('C:\\books\\正.md')
  })

  it('dev 形态：electron-vite 参数混入时仍能取到书', () => {
    // npm run dev -- C:\b\x.md 经 electron 透传后的典型 argv
    expect(parseBookArg([DEV_EXE, '.', 'C:\\b\\x.md'])).toBe('C:\\b\\x.md')
    expect(
      parseBookArg([DEV_EXE, '--trace-warnings', '.', 'C:\\b\\x.markdown'])
    ).toBe('C:\\b\\x.markdown')
  })
})
