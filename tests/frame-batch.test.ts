import { expect, it } from 'vitest'
import { createFrameBatch } from '../src/renderer/src/effects/frame-batch'
it('presents every display frame after warmup when producers rearm before producing, coalesces surfaces and becomes idle', () => {
  let sequence = 0,
    tick = 0
  const callbacks = new Map<number, FrameRequestCallback>(),
    batches: number[][] = []
  const raf = (callback: FrameRequestCallback): number => {
    callbacks.set(++sequence, callback)
    return sequence
  }
  const queue = createFrameBatch<string, number>((jobs) => batches.push(jobs), raf)
  function producer(): void {
    if (tick < 241) raf(producer)
    queue.put('field', tick)
    queue.put('field', tick)
    queue.put('text', tick)
  }
  raf(producer)
  for (tick = 1; tick <= 245; tick++) {
    const frame = [...callbacks.values()]
    callbacks.clear()
    frame.forEach((run) => run((tick * 1000) / 240))
  }
  expect(batches.length).toBeGreaterThanOrEqual(240)
  expect(batches.every((batch) => batch.length === 2 && batch[0] === batch[1])).toBe(true)
  expect(callbacks.size).toBe(0)
})
it('does not encode disposed surfaces', () => {
  let callback: FrameRequestCallback | undefined
  const batches: number[][] = []
  const queue = createFrameBatch<string, number>(
    (jobs) => batches.push(jobs),
    (run) => {
      callback = run
      return 1
    }
  )
  queue.put('gone', 1)
  queue.cancel('gone')
  callback!(16)
  expect(batches).toEqual([])
})
