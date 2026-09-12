export interface SelectionContext {
  before: string
  after: string
  selectedText: string
  start: number
  end: number
}
/** Source offsets include BOM and original line endings; the selection is sent separately. */
export function selectionContext(
  source: string,
  start: number,
  end: number,
  selectedText: string
): SelectionContext {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > source.length
  )
    throw Error('选区上下文的位置无效。')
  let left = Math.max(0, start - 100000),
    right = Math.min(source.length, end + 100000)
  // A stable 4k boundary preserves the long input prefix while nearby selections change.
  // Context can be slightly shorter than the maximum, never longer.
  if (left > 0) left = Math.ceil(left / 4096) * 4096
  if (right < source.length) right = Math.floor(right / 4096) * 4096
  const low = (n: number): boolean =>
    n >= 0 && n < source.length && /[\uDC00-\uDFFF]/.test(source[n])
  if (low(left)) left++
  if (low(right)) right--
  return {
    before: source.slice(left, start),
    after: source.slice(end, right),
    selectedText,
    start,
    end
  }
}
