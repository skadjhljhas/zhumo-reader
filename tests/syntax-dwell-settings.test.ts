import { expect, it } from 'vitest'
import { SyntaxDwell } from '../src/shared/syntax-dwell'
import { clampSettings } from '../src/shared/ipc-types'

it('supports the inclusive one-to-fifteen second range and preserves the five-second default', () => {
  expect(clampSettings({}).automaticSyntaxWaitSeconds).toBe(5)
  for (const [value, expected] of [
    [-3, 1],
    [1, 1],
    [15, 15],
    [30, 15],
    [NaN, 5]
  ])
    expect(clampSettings({ automaticSyntaxWaitSeconds: value }).automaticSyntaxWaitSeconds).toBe(
      expected
    )
  for (const seconds of [1, 5, 15]) {
    const dwell = new SyntaxDwell()
    for (let t = 0; t < seconds * 1000; t += 250)
      expect(dwell.tick(t, ['sentence'], true, seconds * 1000)).toEqual([])
    expect(dwell.tick(seconds * 1000, ['sentence'], true, seconds * 1000)).toEqual(['sentence'])
  }
})
it('applies a changed threshold to existing waiting time without counting hidden or departed sentences', () => {
  const dwell = new SyntaxDwell()
  for (let t = 0; t <= 1500; t += 250) dwell.tick(t, ['sentence'], true, 15000)
  expect(dwell.tick(1750, ['sentence'], true, 1000)).toEqual(['sentence'])
  expect(dwell.tick(2000, ['sentence'], true, 15000)).toEqual([])
  dwell.tick(2250, [], true, 1000)
  expect(dwell.tick(2500, ['sentence'], true, 1000)).toEqual([])
  dwell.tick(2750, ['sentence'], false, 1000)
  expect(dwell.tick(10000, ['sentence'], true, 1000)).toEqual([])
})
