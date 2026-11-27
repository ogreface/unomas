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

import type { GameState, Phase, PlayerId } from './types.js'
import type { PhaseView } from './view.js'

/**
 * The player who owes the game an action, or null if nobody does.
 *
 * Null covers every phase where no single player is holding the game up: the lobby, and the two
 * between-rounds phases where play is waiting on the *host* to deal rather than on a turn. A clock
 * over those would be a clock over a person who cannot act, so there isn't one.
 */
export function playerToAct(state: GameState): PlayerId | null {
  return owedBy(state.phase, state.players[state.turn]?.id ?? null)
}

/**
 * The same question, asked of what a screen was sent — a `PlayerView` or a `TableView`.
 *
 * It exists because **`turn` is not the answer**. The turn only advances when a play has fully
 * settled, so while a wild draw waits on its challenge the turn still sits with the player who
 * played it, and the one decision outstanding belongs to the seat after them. A screen that reads
 * `turn` to say who is up therefore names the wrong person for exactly as long as that lasts. This
 * is the one place that knows which phases do that, so a screen never has to.
 */
export function playerToActInView(view: { phase: PhaseView; turn: PlayerId | null }): PlayerId | null {
  return owedBy(view.phase, view.turn)
}

function owedBy(phase: Phase | PhaseView, turn: PlayerId | null): PlayerId | null {
  switch (phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return turn
    case 'awaitingColorChoice':
      return phase.chooser
    case 'awaitingChallenge':
      return phase.challenger
    case 'lobby':
    case 'roundOver':
    case 'gameOver':
      return null
  }
}
