/**
 * The browser's stable identity. `clientId` is what lets the `GameRoom` hand a returning player
 * their seat back after a reconnect, so it must survive reloads — it lives in localStorage, minted
 * once. The nickname is remembered only as a convenience default.
 */

const CLIENT_ID_KEY = 'flipside.clientId'
const NICKNAME_KEY = 'flipside.nickname'

/**
 * Two tabs in one browser share `localStorage`, so they would share a `clientId` and be treated as
 * the same player. For local testing, an `?as=<label>` query param namespaces the id, letting one
 * browser hold several distinct players. Production URLs carry no such param and use the single,
 * seat-reclaiming id.
 */
export function clientId(): string {
  const as = new URLSearchParams(location.search).get('as')
  const key = as ? `${CLIENT_ID_KEY}.${as}` : CLIENT_ID_KEY
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export function rememberedNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) ?? ''
}

export function rememberNickname(name: string): void {
  localStorage.setItem(NICKNAME_KEY, name)
}
