/**
 * The browser's stable identity. `clientId` is what lets the `GameRoom` hand a returning player
 * their seat back after a reconnect, so it must survive reloads — it lives in localStorage, minted
 * once. The nickname is remembered only as a convenience default.
 *
 * Nothing in here may throw. It runs on the first paint and inside the socket's `open` handler, and
 * a throw in either place is invisible: the app renders a blank screen, or the lobby sits there
 * looking like a room nobody joined. Both of the browser APIs it needs can be missing on a real
 * phone — see `randomId` and `readStore` — so both are guarded.
 */

const CLIENT_ID_KEY = 'flipside.clientId'
const NICKNAME_KEY = 'flipside.nickname'

/**
 * `crypto.randomUUID` is gated on a **secure context**. Over plain http it is not merely
 * discouraged, it is `undefined` — and plain http is exactly how a phone reaches a dev server on
 * the LAN (`http://192.168.x.x:5173`, which is what the README tells you to do to test with real
 * devices). Calling it there threw inside the WebSocket `open` handler, so `join` was never sent,
 * so no `welcome` and no `roster` ever came back: an empty lobby with no Start button, on the
 * host's own phone, while the same code worked on a laptop at `localhost` (a secure context).
 *
 * `crypto.getRandomValues` carries no such gate, so it is the fallback that actually works there.
 */
function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()

  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // No Web Crypto at all. Not reachable in any browser that can run this app, but an id that is
  // merely unlikely to collide beats a hard crash that leaves the player staring at a dead lobby.
  return `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * iOS Safari throws on *any* `localStorage` access under "Block All Cookies", and historically
 * throws on `setItem` in Private Browsing. Neither is exotic enough to crash the app over, so the
 * store degrades to memory: identity then lasts as long as the tab, which is long enough to play.
 */
const memory = new Map<string, string>()

function readStore(key: string): string | null {
  const cached = memory.get(key)
  if (cached !== undefined) return cached
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key: string, value: string): void {
  memory.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage is blocked; the in-memory copy above keeps this tab consistent until it closes.
  }
}

/**
 * Two tabs in one browser share `localStorage`, so they would share a `clientId` and be treated as
 * the same player. For local testing, an `?as=<label>` query param namespaces the id, letting one
 * browser hold several distinct players. Production URLs carry no such param and use the single,
 * seat-reclaiming id.
 */
export function clientId(): string {
  const as = new URLSearchParams(location.search).get('as')
  const key = as ? `${CLIENT_ID_KEY}.${as}` : CLIENT_ID_KEY
  let id = readStore(key)
  if (!id) {
    id = randomId()
    writeStore(key, id)
  }
  return id
}

export function rememberedNickname(): string {
  return readStore(NICKNAME_KEY) ?? ''
}

export function rememberNickname(name: string): void {
  writeStore(NICKNAME_KEY, name)
}
