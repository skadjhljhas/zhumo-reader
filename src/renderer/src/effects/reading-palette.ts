/** Perceptual hue neighbours remain subordinate to the model's original glow colour. */
export function readingPalette(hex: string): { main: string; cool: string; warm: string } {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = Math.atan2(bb, a),
    C = Math.hypot(a, bb)
  function neighbour(angle: number): string {
    const light = Math.min(0.94, Math.max(0.65, L + 0.07)),
      chroma = Math.min(0.105, Math.max(0.025, C * 0.68))
    const A = Math.cos(h + angle) * chroma,
      B = Math.sin(h + angle) * chroma
    const ll = (light + 0.3963377774 * A + 0.2158037573 * B) ** 3,
      mm = (light - 0.1055613458 * A - 0.0638541728 * B) ** 3,
      ss = (light - 0.0894841775 * A - 1.291485548 * B) ** 3
    return (
      '#' +
      [
        4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
        -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
        -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss
      ]
        .map((c) =>
          Math.round(
            255 *
              Math.max(
                0,
                Math.min(
                  1,
                  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055
                )
              )
          )
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    )
  }
  return { main: hex, cool: neighbour(-0.58), warm: neighbour(0.65) }
}
const hosts = new Map<HTMLElement, number>()
export const activeColorSurfaces = new WeakSet<HTMLElement>()
export function removeDetachedColorCopies(host: HTMLElement): void {
  for (const surface of host.querySelectorAll<HTMLElement>(':scope > .reading-color-light,:scope > .golden-ink-surface'))
    if (!activeColorSurfaces.has(surface)) surface.remove()
}
export function retainColorHost(host: HTMLElement): void {
  hosts.set(host, (hosts.get(host) ?? 0) + 1)
  host.classList.add('reading-color-anchor')
}
export function releaseColorHost(host: HTMLElement): void {
  const n = (hosts.get(host) ?? 1) - 1
  if (n) hosts.set(host, n)
  else {
    hosts.delete(host)
    host.classList.remove('reading-color-anchor')
  }
}
