/**
 * 朱墨 ZhuMo —— 设置钳制（clampSettings / SETTINGS_LIMITS / DEFAULT_SETTINGS）单测。
 *
 * 契约单一事实源位于 src/shared/ipc-types.ts；本文件验证：
 * - 越界数值钳回区间、非法类型回默认值（任何输入不抛错）
 * - DEFAULT_SETTINGS 与 SETTINGS_LIMITS 自洽（默认值落在区间内、步长合法）
 * - store.ts 的 sanitizeSettings 确为同一契约的别名（不再有第二份实现）
 */
import { describe, expect, it } from 'vitest'
import {
  clampSettings,
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  type NumericSettingsKey,
  type Settings
} from '../src/shared/ipc-types'
import { DEFAULT_SETTINGS as STORE_DEFAULTS, sanitizeSettings } from '../src/main/store'

const NUMERIC_KEYS = Object.keys(SETTINGS_LIMITS) as NumericSettingsKey[]

describe('clampSettings：非法输入回默认', () => {
  it.each([null, undefined, 42, '不是对象', true, []])('输入 %s 返回完整默认值', (input) => {
    expect(clampSettings(input)).toEqual(DEFAULT_SETTINGS)
  })

  it('空对象返回完整默认值', () => {
    expect(clampSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('部分字段缺失时，缺失字段回默认值', () => {
    expect(clampSettings({ fontSize: 20 })).toEqual({ ...DEFAULT_SETTINGS, fontSize: 20 })
  })

  it('非法类型逐字段回默认值', () => {
    const fixed = clampSettings({
      theme: 'solarized',
      fontSize: '大',
      lineHeight: null,
      contentWidth: ['40'],
      paragraphStyle: 'fancy',
      sidebarVisible: 'yes',
      noteLevelCap: '四'
    })
    expect(fixed).toEqual(DEFAULT_SETTINGS)
  })

  it('NaN 与 Infinity 回默认值', () => {
    expect(clampSettings({ fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_SETTINGS
    )
  })
})

describe('clampSettings：越界数值钳回区间', () => {
  it('超出上限钳到 max', () => {
    const fixed = clampSettings({
      fontSize: 99,
      lineHeight: 9,
      contentWidth: 100,
      noteLevelCap: 99
    })
    expect(fixed.fontSize).toBe(SETTINGS_LIMITS.fontSize.max)
    expect(fixed.lineHeight).toBe(SETTINGS_LIMITS.lineHeight.max)
    expect(fixed.contentWidth).toBe(SETTINGS_LIMITS.contentWidth.max)
    expect(fixed.noteLevelCap).toBe(SETTINGS_LIMITS.noteLevelCap.max)
  })

  it('低于下限钳到 min', () => {
    const fixed = clampSettings({
      fontSize: 0,
      lineHeight: 0.1,
      contentWidth: 10,
      noteLevelCap: -3
    })
    expect(fixed.fontSize).toBe(SETTINGS_LIMITS.fontSize.min)
    expect(fixed.lineHeight).toBe(SETTINGS_LIMITS.lineHeight.min)
    expect(fixed.contentWidth).toBe(SETTINGS_LIMITS.contentWidth.min)
    expect(fixed.noteLevelCap).toBe(SETTINGS_LIMITS.noteLevelCap.min)
  })

  it('整数字段四舍五入到整数（区间内）', () => {
    expect(clampSettings({ noteLevelCap: 4.7 }).noteLevelCap).toBe(5)
    expect(clampSettings({ fontSize: 17.4 }).fontSize).toBe(17)
    expect(clampSettings({ contentWidth: 40.5 }).contentWidth).toBe(41)
    // 四舍五入越界时仍被钳住
    expect(clampSettings({ noteLevelCap: 5.8 }).noteLevelCap).toBe(6)
  })

  it('合法值原样保留（含枚举与布尔）', () => {
    const valid: Settings = {
      theme: 'dark',
      fontSize: 16,
      lineHeight: 2.05,
      contentWidth: 42,
      paragraphStyle: 'spacing',
      sidebarVisible: false,
      noteLevelCap: 2
    }
    expect(clampSettings(valid)).toEqual(valid)
  })

  it('返回新对象，不修改输入', () => {
    const input = { fontSize: 99, extra: 'x' }
    const fixed = clampSettings(input)
    expect(input).toEqual({ fontSize: 99, extra: 'x' })
    expect(fixed).not.toBe(input)
    expect(fixed).not.toHaveProperty('extra')
  })

  it('幂等：钳制后再钳制结果不变', () => {
    const once = clampSettings({ fontSize: 99, lineHeight: 0.1 })
    expect(clampSettings(once)).toEqual(once)
  })
})

describe('契约自洽：DEFAULT_SETTINGS 与 SETTINGS_LIMITS', () => {
  it('默认值全部落在对应区间内', () => {
    for (const key of NUMERIC_KEYS) {
      const { min, max } = SETTINGS_LIMITS[key]
      expect(DEFAULT_SETTINGS[key]).toBeGreaterThanOrEqual(min)
      expect(DEFAULT_SETTINGS[key]).toBeLessThanOrEqual(max)
    }
  })

  it('区间合法：min < max 且 step > 0', () => {
    for (const key of NUMERIC_KEYS) {
      const { min, max, step } = SETTINGS_LIMITS[key]
      expect(min).toBeLessThan(max)
      expect(step).toBeGreaterThan(0)
    }
  })

  it('整数字段（step=1）的默认值为整数', () => {
    for (const key of NUMERIC_KEYS) {
      if (SETTINGS_LIMITS[key].step === 1) {
        expect(Number.isInteger(DEFAULT_SETTINGS[key])).toBe(true)
      }
    }
  })
})

describe('单一事实源：store.ts 不再有第二份实现', () => {
  it('sanitizeSettings 是 clampSettings 的别名导出', () => {
    expect(sanitizeSettings).toBe(clampSettings)
  })

  it('store.ts 的 DEFAULT_SETTINGS 与 shared 导出为同一对象', () => {
    expect(STORE_DEFAULTS).toBe(DEFAULT_SETTINGS)
  })
})
