/**
 * The browser's stable identity. `clientId` is what lets the `GameRoom` hand a returning player
 * their seat back after a reconnect, so it must survive reloads — it lives in localStorage, minted
 * once. The nickname is remembered only as a convenience default.
 */

const CLIENT_ID_KEY = 'flipside.clientId'
const NICKNAME_KEY = 'flipside.nickname'

export function clientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_KEY, id)
  }
  return id
}

export function rememberedNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) ?? ''
}

export function rememberNickname(name: string): void {
  localStorage.setItem(NICKNAME_KEY, name)
}
