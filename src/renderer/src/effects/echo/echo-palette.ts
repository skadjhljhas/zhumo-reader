/** Ink endpoints for the hovered word. Both themes keep their own light/dark relation:
 * the tide's letters stay bright over the sea, lucent's ink stays dark on lit paper. */
export const ECHO_INK = {
  chaosheng: { moon: [238, 246, 255], sun: [255, 233, 194] },
  lucent: { moon: [42, 61, 120], sun: [107, 74, 42] }
} as const
export type EchoTheme = keyof typeof ECHO_INK
/** Glyph colour after `strength` (0..1 envelope) with `tint` moving moonlight toward sunlight. */
export function echoInk(
  theme: EchoTheme,
  base: number[],
  strength: number,
  tint: number
): number[] {
  const { moon, sun } = ECHO_INK[theme]
  const amount = Math.min(1, Math.max(0, strength) * 1.6),
    t = Math.min(1, Math.max(0, tint))
  return base.map((n, i) => {
    const target = moon[i] + (sun[i] - moon[i]) * t
    return Math.round(n + (target - n) * amount)
  })
}
export const echoRgb = (rgb: ArrayLike<number>, alpha = 1): string =>
  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
