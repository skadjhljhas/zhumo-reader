const TAU = Math.PI * 2
const radians = Math.PI / 180
const wrap = (x: number, period: number): number => ((x % period) + period) % period

/** Approximate solar longitude, USNO sun_approx. For visual modulation, not an almanac. */
export function solarLongitude(timestamp: number): number {
  const days = (timestamp - Date.UTC(2000, 0, 1, 12)) / 86400000
  const anomaly = wrap(357.529 + 0.98560028 * days, 360) * radians
  return (
    wrap(
      280.459 + 0.98564736 * days + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly),
      360
    ) * radians
  )
}

export function seasonLight(date: Date): [number, number, number, number] {
  const longitude = solarLongitude(date.getTime())
  const localDay =
    ((date.getHours() +
      date.getMinutes() / 60 +
      (date.getSeconds() + date.getMilliseconds() / 1000) / 3600) /
      24) *
    TAU
  // Circular coordinates cross midnight and the 24 solar-term boundaries smoothly.
  // The 24th harmonic is deliberately tiny: no seasonal badges or clock-like motion.
  return [
    Math.sin(longitude) + 0.035 * Math.sin(24 * longitude),
    Math.cos(longitude),
    Math.sin(localDay),
    Math.cos(localDay)
  ]
}
