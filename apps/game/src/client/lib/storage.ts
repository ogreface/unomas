/**
 * `localStorage`, made safe to touch. Nothing that reads a preference may throw: it runs on first
 * paint and inside socket handlers, where a throw is a blank screen or a lobby nobody can start.
 *
 * iOS Safari throws on *any* `localStorage` access under "Block All Cookies", and historically
 * throws on `setItem` in Private Browsing. Neither is exotic enough to crash the app over, so the
 * store degrades to memory: a value then lasts as long as the tab, which is long enough to play.
 */
const memory = new Map<string, string>()

export function readStore(key: string): string | null {
  const cached = memory.get(key)
  if (cached !== undefined) return cached
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStore(key: string, value: string): void {
  memory.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage is blocked; the in-memory copy above keeps this tab consistent until it closes.
  }
}
