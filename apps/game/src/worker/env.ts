import type { GameRoom } from './room.js'

export interface Env {
  /** One instance per room, addressed by `idFromName(hmac(code))`. */
  GAME_ROOM: DurableObjectNamespace<GameRoom>
  /** The built SPA. Bound in production; may be absent under `vitest`. */
  ASSETS?: Fetcher
  /** Optional HMAC key so room→object names aren't a bare hash of a guessable code. */
  ROOM_SECRET?: string
  /**
   * How long the room pauses before playing a computer player's move, in ms. A pacing knob, not a
   * correctness one — the tests set it to 0 so a bot game runs at full speed.
   */
  BOT_DELAY_MS?: string
}
