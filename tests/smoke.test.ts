import { describe, expect, it } from 'vitest'

describe('环境冒烟测试', () => {
  it('vitest 正常运行：1 + 1 = 2', () => {
    expect(1 + 1).toBe(2)
  })

  it('Node 环境可用', () => {
    expect(typeof process).toBe('object')
    expect(process.version.startsWith('v')).toBe(true)
  })
})
