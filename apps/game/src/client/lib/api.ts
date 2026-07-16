/** Mint a fresh room on the server. Returns the human-readable code to share. */
export async function createRoom(): Promise<string> {
  const res = await fetch('/api/room', { method: 'POST' })
  if (!res.ok) throw new Error(`could not create a room (${res.status})`)
  const body = (await res.json()) as { code?: string; error?: string }
  if (!body.code) throw new Error(body.error ?? 'server did not return a room code')
  return body.code
}

/** The WebSocket URL for a room, matching the page's scheme (ws in dev, wss in prod). */
export function socketUrl(code: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws/${code}`
}
