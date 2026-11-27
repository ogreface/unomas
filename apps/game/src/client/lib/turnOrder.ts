/**
 * The turn order, as the board draws it.
 *
 * "Who is next" is not a rule the client is deciding: before anyone plays, the next seat is simply
 * the neighbour in the direction of play — the person a Skip or a Draw would land on. What happens
 * *after* a play (skips, reverses, a forced turn) is the server's business, and the next view says
 * where the turn actually went. This is just reading the seats in the order they already sit.
 */

import type { Direction } from '@flipside/engine'

/**
 * The player who plays after `turn`, walking `direction` around the seats (array order is seat
 * order). Null when nobody is on turn, or when there is nobody else to play on.
 */
export function nextInOrder(
  players: readonly { id: string }[],
  turn: string | null,
  direction: Direction,
): string | null {
  const n = players.length
  const at = turn === null ? -1 : players.findIndex(p => p.id === turn)
  if (at < 0 || n < 2) return null
  return players[(((at + direction) % n) + n) % n]?.id ?? null
}

/** Phases with no turn in progress: before the deal, and between rounds while the host deals. */
const BETWEEN_TURNS = new Set(['lobby', 'roundOver', 'gameOver'])

/**
 * Who is up next on this table — the seat the player on turn is playing on. Null between rounds:
 * the turn pointer still names somebody then, but nobody is about to be played on.
 *
 * Mid-challenge this is the challenger, and mid-colour-choice it is whoever plays once the colour is
 * named — both still "the next seat", because the turn has not moved yet.
 */
export function upNext(table: {
  phase: { t: string }
  players: readonly { id: string }[]
  turn: string | null
  direction: Direction
}): string | null {
  if (BETWEEN_TURNS.has(table.phase.t)) return null
  return nextInOrder(table.players, table.turn, table.direction)
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
