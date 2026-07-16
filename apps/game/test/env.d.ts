/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { GameRoom } from '../src/worker/room.js'

// The `cloudflare:test` module types `env` as `Cloudflare.Env`. Declare the bindings the tests use
// so `env.GAME_ROOM` is the real, typed namespace rather than `unknown`.
declare global {
  namespace Cloudflare {
    interface Env {
      GAME_ROOM: DurableObjectNamespace<GameRoom>
      ASSETS?: Fetcher
      ROOM_SECRET?: string
    }
  }
}
