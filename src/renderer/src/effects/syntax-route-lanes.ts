export interface SyntaxRouteInterval {
  id: string
  top: number
  bottom: number
  order: number
}

const clearance = 12
const compare = (a: SyntaxRouteInterval, b: SyntaxRouteInterval): number =>
  a.order - b.order ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
  a.top - b.top ||
  a.bottom - b.bottom

/** Assign independent light paths to whitespace channels without moving existing paths
 * merely because another relation arrived. A caller owns one instance per optical scene. */
export class SyntaxRouteLanes {
  private previous = new Map<string, number>()

  assign(intervals: SyntaxRouteInterval[], capacity: number): Map<string, number> {
    const count = Number.isNaN(capacity) ? 0 : Math.max(0, Math.min(6, Math.floor(capacity)))
    if (!count) {
      this.reset()
      return new Map()
    }
    const byId = new Map<string, SyntaxRouteInterval>()
    for (const item of intervals) {
      if (!item.id || !Number.isFinite(item.top) || !Number.isFinite(item.bottom)) continue
      const previous = byId.get(item.id)
      const normalized = {
        ...item,
        top: Math.min(item.top, item.bottom),
        bottom: Math.max(item.top, item.bottom),
        order: Number.isFinite(item.order) ? item.order : 0
      }
      // Repeated fragments of one route reserve their combined vertical extent.
      byId.set(
        item.id,
        previous
          ? {
              ...normalized,
              top: Math.min(previous.top, normalized.top),
              bottom: Math.max(previous.bottom, normalized.bottom),
              order: Math.min(previous.order, normalized.order)
            }
          : normalized
      )
    }
    const unique = [...byId.values()].sort(compare)
    const occupied: SyntaxRouteInterval[][] = Array.from({ length: count }, () => [])
    const result = new Map<string, number>()
    const fits = (item: SyntaxRouteInterval, slot: number): boolean =>
      occupied[slot].every(
        (other) => item.top >= other.bottom + clearance || other.top >= item.bottom + clearance
      )
    const place = (item: SyntaxRouteInterval, slot: number): void => {
      occupied[slot].push(item)
      result.set(item.id, slot)
    }

    // Reserve surviving assignments before considering new or displaced relations.
    // Reflow conflicts are resolved in source order, independently of patch order.
    for (const item of unique) {
      const slot = this.previous.get(item.id)
      if (slot !== undefined && slot < count && fits(item, slot)) place(item, slot)
    }
    for (const item of unique) {
      if (result.has(item.id)) continue
      const slot = occupied.findIndex((_, index) => fits(item, index))
      if (slot >= 0) place(item, slot)
    }

    // Removed and unplaced relations hold no reservation. A later return is a new arrival.
    this.previous = result
    return new Map(result)
  }

  reset(): void {
    this.previous.clear()
  }
}
