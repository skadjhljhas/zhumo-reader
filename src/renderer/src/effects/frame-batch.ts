/** Keep one following callback armed while producers are active. A one-shot callback
 * scheduled by rAF producers would otherwise present only every second display frame. */
export function createFrameBatch<Key, Job>(
  consume: (jobs: Job[], now: number) => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame
): { put(key: Key, job: Job): void; cancel(key: Key): void } {
  const pending = new Map<Key, Job>()
  let frame = 0
  function flush(now: number): void {
    frame = 0
    if (!pending.size) return
    const jobs = [...pending.values()]
    pending.clear()
    consume(jobs, now)
    if (!frame) frame = request(flush)
  }
  return {
    put(key, job) {
      pending.set(key, job)
      if (!frame) frame = request(flush)
    },
    cancel(key) {
      pending.delete(key)
    }
  }
}
