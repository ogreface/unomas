/**
 * The turn order, as the board draws it.
 *
 * "Who is next" is not a rule the client is deciding: before anyone plays, the next seat is simply
 * the neighbour in the direction of play — the person a Skip or a Draw would land on. What happens
 * *after* a play (skips, reverses, a forced turn) is the server's business, and the next view says
 * where the turn actually went. This is just reading the seats in the order they already sit.
 */

import { playerToActInView } from '@flipside/engine'
import type { Direction, PhaseView } from '@flipside/engine'

/** A seat in the row. One whose player has been dropped from the game stays in it, marked. */
interface Seat {
  id: string
  dropped?: string | null
}

/**
 * The player who plays after `turn`, walking `direction` around the seats (array order is seat
 * order). Null when nobody is on turn, or when there is nobody else to play on.
 *
 * The seat of a player who has left is passed over, exactly as the engine's own `seatAfter` passes
 * over it: the tile is still in the row, but nobody plays on an empty chair.
 */
export function nextInOrder(players: readonly Seat[], turn: string | null, direction: Direction): string | null {
  const n = players.length
  const at = turn === null ? -1 : players.findIndex(p => p.id === turn)
  if (at < 0) return null
  for (let step = 1; step < n; step++) {
    const seat = players[(((at + direction * step) % n) + n) % n]
    if (seat && !seat.dropped) return seat.id
  }
  return null
}

/**
 * Who is up next on this table: the seat after the one the table is waiting on. Counted from
 * `playerToActInView`, not `turn`, so it lines up with the highlighted seat and the clock — the two
 * differ while a wild draw waits on its challenge, when the turn still sits with whoever played it
 * and the decision belongs to the seat after them. Null between rounds, when nobody is up.
 */
export function upNext(table: {
  phase: PhaseView
  players: readonly Seat[]
  turn: string | null
  direction: Direction
}): string | null {
  return nextInOrder(table.players, playerToActInView(table), table.direction)
}

/**
 * Which gap in the row the play is crossing right now, from the player on turn to the next. Gap `k`
 * sits just before seat `k`; gap 0 is the wrap-around — play running off one end of the row and
 * coming back in at the other — which the strip draws at both ends. Null when nobody is on turn.
 */
export function liveGap(
  players: readonly { id: string }[],
  turn: string | null,
  direction: Direction,
): number | null {
  const at = turn === null ? -1 : players.findIndex(p => p.id === turn)
  if (at < 0) return null
  return (direction === 1 ? at + 1 : at) % players.length
}

/** A horizontal span inside the strip's scrolling content, in px from its left edge. */
export interface Span {
  left: number
  right: number
}

/** Breathing room left beside a tile scrolled into view, so it doesn't sit flush on the edge. */
const MARGIN = 12

/**
 * Where to scroll the order strip so the player on turn — and, when the two fit together, the seat
 * they are playing on — is on screen. Returns the current offset unchanged when they already are:
 * the strip only moves when it has to, so it never fidgets under someone's thumb.
 */
export function revealScroll(
  view: { scrollLeft: number; width: number },
  turn: Span,
  next: Span | null,
): number {
  let want = turn
  if (next) {
    const pair = { left: Math.min(turn.left, next.left), right: Math.max(turn.right, next.right) }
    if (pair.right - pair.left + 2 * MARGIN <= view.width) want = pair
  }
  if (want.left < view.scrollLeft) return Math.max(0, want.left - MARGIN)
  if (want.right > view.scrollLeft + view.width) return Math.max(0, want.right - view.width + MARGIN)
  return view.scrollLeft
}
