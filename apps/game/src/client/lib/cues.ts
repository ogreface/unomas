/**
 * When the game makes a sound — the decisions, kept apart from the noise itself (`sound.ts`).
 *
 * A sound here is a nudge for the person holding *this* phone, who is on a call and probably looking
 * at somebody's face rather than at the cards. So every cue marks a moment something **changed**:
 * the move just became yours, somebody just called UNO, your clock just crossed into its last
 * seconds, the game just ended. A state that merely persists never re-fires, which is what lets the
 * board re-render as often as it likes.
 *
 * Pure and free of React and of the Web Audio API, because "exactly once, at exactly that moment"
 * is the part that goes wrong and the part worth testing.
 */

import type { EventView, PlayerView } from '@flipside/engine'
import type { TimerView } from '@flipside/protocol'
import { URGENT_MS } from './turnClock.js'

export type Cue = 'yourTurn' | 'uno' | 'hurry' | 'tick' | 'gameOver'

/**
 * Whether the game is waiting on you. The client-side mirror of the engine's `playerToAct`, over the
 * view a player actually holds: the decision is not always the turn's — a colour choice or a
 * challenge can be owed by somebody else while the turn sits still.
 */
function owesMove(view: PlayerView | null): boolean {
  if (!view) return false
  const phase = view.phase
  switch (phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return view.turn === view.you
    case 'awaitingColorChoice':
      return phase.chooser === view.you
    case 'awaitingChallenge':
      return phase.challenger === view.you
    default:
      return false
  }
}

/**
 * The cues for one step of the game: the view before it (null on first sight), the view after, and
 * the events that moved one to the other.
 *
 * - **gameOver** when the game ends, and nothing else — nobody is on move any more.
 * - **uno** when anybody calls it, the caller included: for them it is the confirmation it landed.
 * - **yourTurn** when the game goes from not waiting on you to waiting on you. Not on every frame of
 *   your turn, and not when one decision of yours leads straight into another (draw, then decide on
 *   the drawn card) — you are already looking.
 */
export function gameCues(prev: PlayerView | null, next: PlayerView, events: readonly EventView[]): Cue[] {
  if (events.some(e => e.t === 'gameEnded')) return ['gameOver']
  const cues: Cue[] = []
  if (events.some(e => e.t === 'unoCalled')) cues.push('uno')
  if (!owesMove(prev) && owesMove(next)) cues.push('yourTurn')
  return cues
}

/** One reading of the turn clock, as the screen shows it. */
export interface ClockSample {
  player: string
  phase: TimerView['phase']
  seconds: number
}

/** What the clock cues remember between readings: which clock this is, and how low it has been. */
export interface ClockMemory {
  player: string
  phase: TimerView['phase']
  low: number
}

/** The warning lands the instant the ring turns red, so ear and eye agree. */
export const HURRY_AT_SECONDS = URGENT_MS / 1000
/** A tick for each of the last few seconds. */
export const TICK_FROM_SECONDS = 5

/**
 * A fresh frame re-anchors the countdown, and the latency inside it can read a second or so *more*
 * than this screen had already counted down to. Anything bigger than that is a new clock — the same
 * player back on move after a Skip, say — rather than the old one wobbling.
 */
const SAME_CLOCK_SLACK_SECONDS = 2

/**
 * The cues for one reading of the clock, and what to remember for the next.
 *
 * Only your own clock makes a sound — somebody else running low is their problem, and the whole table
 * can already see it. A cue fires when the clock goes **below its lowest reading so far**, which is
 * what keeps a re-anchoring wobble from playing the same second twice. First sight of a clock is
 * silent: a reconnect into a turn with four seconds left is not a countdown anybody heard begin.
 */
export function clockCues(
  memory: ClockMemory | null,
  sample: ClockSample | null,
  you: string,
): { cues: Cue[]; memory: ClockMemory | null } {
  if (!sample) return { cues: [], memory: null }

  const sameClock =
    memory !== null &&
    memory.player === sample.player &&
    memory.phase === sample.phase &&
    sample.seconds <= memory.low + SAME_CLOCK_SLACK_SECONDS
  if (!sameClock) {
    return { cues: [], memory: { player: sample.player, phase: sample.phase, low: sample.seconds } }
  }

  const low = memory.low
  const next = { ...memory, low: Math.min(low, sample.seconds) }
  if (sample.player !== you || sample.seconds >= low) return { cues: [], memory: next }

  // Every whole second crossed since the last reading: usually one, several if the tab was asleep.
  // A sleeping tab gets one cue, not a burst — the most telling of whatever it slept through.
  const crossed = (s: number) => sample.seconds <= s && s < low
  if (crossed(HURRY_AT_SECONDS)) return { cues: ['hurry'], memory: next }
  for (let s = TICK_FROM_SECONDS; s >= 1; s--) {
    if (crossed(s)) return { cues: ['tick'], memory: next }
  }
  return { cues: [], memory: next }
}
