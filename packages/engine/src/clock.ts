/**
 * Who the game is waiting on — the one thing a turn clock needs from the engine.
 *
 * The clock itself lives in the Durable Object, because the engine is not allowed to know what time
 * it is (see the `no-restricted-globals` block in `eslint.config.js`). What the engine *does* own is
 * the answer to "whose decision is outstanding right now?", because that is a property of the
 * phase, and the phase is the whole state machine. The DO asks this question after every reduction,
 * arms an alarm for whoever it names, and — when that alarm fires — sends back a `timeout` action
 * for exactly that player. Nothing about the timeout policy is duplicated on the clock side.
 */

import type { GameState, PlayerId } from './types.js'

/**
 * The player who owes the game an action, or null if nobody does.
 *
 * Null covers every phase where no single player is holding the game up: the lobby, and the two
 * between-rounds phases where play is waiting on the *host* to deal rather than on a turn. A clock
 * over those would be a clock over a person who cannot act, so there isn't one.
 */
export function playerToAct(state: GameState): PlayerId | null {
  switch (state.phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return state.players[state.turn]?.id ?? null
    case 'awaitingColorChoice':
      return state.phase.chooser
    case 'awaitingChallenge':
      return state.phase.challenger
    case 'lobby':
    case 'roundOver':
    case 'gameOver':
      return null
  }
}
