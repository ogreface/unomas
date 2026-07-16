/**
 * Scoring.
 *
 * *"REMEMBER TO SCORE POINTS BASED ON WHICH SIDE (LIGHT OR DARK) THE GAME ENDED ON."*
 *
 * That one line is the whole reason scoring needs the side passed in: the same physical card is
 * worth 10 as a light Draw One and 20 as a dark Draw Five. The winner takes the value of every
 * card left in every opponent's hand, valued on the side the round ended on.
 *
 * Integers only. No floats anywhere in scoring — a float that survives a JSON round-trip and a
 * sandbox boundary is a desync waiting to happen.
 */

import type { Card, CardId, GameState, PlayerId, Side } from './types.js'
import type { RulePack } from './rulepack.js'
import { cardOf } from './effects.js'

/** The value of one hand, on one side. */
export function handValue(
  pack: RulePack,
  cards: Record<CardId, Card>,
  hand: readonly CardId[],
  side: Side,
): number {
  let total = 0
  for (const id of hand) total += pack.cardValue(cardOf(cards, id)[side])
  return total
}

/** What the round's winner scores: everything still held by everyone else. */
export function roundPoints(
  pack: RulePack,
  cards: Record<CardId, Card>,
  state: GameState,
  winner: PlayerId,
): number {
  let total = 0
  for (const player of state.players) {
    if (player.id === winner) continue
    total += handValue(pack, cards, player.hand, state.side)
  }
  return total
}
