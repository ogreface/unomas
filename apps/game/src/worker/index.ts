/**
 * The Worker entry. It does almost nothing on purpose: mint a room code, and route a WebSocket
 * upgrade to the one Durable Object that owns that room. All game logic lives in the DO; all
 * rendering is static assets. Only `/api/*` and `/ws/*` reach this handler (see `wrangler.jsonc`
 * `run_worker_first`); everything else is served straight from the built SPA.
 */

import { GameRoom } from './room.js'
import { generateCode, roomDoName } from './codes.js'
import { normalizeCode } from '@flipside/protocol'
import type { Env } from './env.js'

export { GameRoom }

const WS_PATH = /^\/ws\/([^/]+)$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/room' && request.method === 'POST') {
      return createRoom(env)
    }

    const wsMatch = url.pathname.match(WS_PATH)
    if (wsMatch) {
      return routeWebSocket(request, env, wsMatch[1] ?? '')
    }

    // Not a dynamic route. In production `run_worker_first` means we only get here for /api and /ws,
    // but fall back to the SPA so a stray request still serves something sensible.
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>

async function createRoom(env: Env): Promise<Response> {
  // Retry on the astronomically unlikely event that a fresh code already hosts a room.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const name = await roomDoName(code, env.ROOM_SECRET)
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(name))
    const { created } = await stub.createRoom(code)
    if (created) return json({ code })
  }
  return json({ error: 'could not allocate a room' }, 503)
}

async function routeWebSocket(request: Request, env: Env, rawCode: string): Promise<Response> {
  const code = normalizeCode(rawCode)
  if (!code) return new Response('bad room code', { status: 400 })
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected a websocket upgrade', { status: 426 })
  }
  const name = await roomDoName(code, env.ROOM_SECRET)
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(name))
  return stub.fetch(request)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
