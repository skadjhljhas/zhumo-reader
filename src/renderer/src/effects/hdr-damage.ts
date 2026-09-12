export interface HdrDamage {
  x: number
  y: number
  width: number
  height: number
}
export function unionHdrDamage(a: HdrDamage | undefined, b: HdrDamage): HdrDamage {
  if (!a) return { ...b }
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  }
}
export function clipHdrDamage(
  area: HdrDamage | null | undefined,
  width: number,
  height: number
): HdrDamage {
  if (!area) return { x: 0, y: 0, width, height }
  const x = Math.max(0, Math.min(width, Math.floor(area.x))),
    y = Math.max(0, Math.min(height, Math.floor(area.y)))
  const right = Math.max(x, Math.min(width, Math.ceil(area.x + area.width))),
    bottom = Math.max(y, Math.min(height, Math.ceil(area.y + area.height)))
  return { x, y, width: right - x, height: bottom - y }
}
