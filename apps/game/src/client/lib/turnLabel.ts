/**
 * The words in the top bar: who the table is waiting on.
 *
 * Not "whose turn is it" — that is a different question with, occasionally, a different answer. When
 * a wild draw is played the turn stays with whoever played it until the next player has decided
 * whether to challenge, so for that stretch the player at the turn has nothing to do and the player
 * everyone is waiting on is somebody else. Reading the label off `view.turn` told the first of them
 * "Your turn" while the second one's clock ran down. The engine already names who owes the decision
 * (it is what the clock is armed from), so the label asks it rather than working it out again.
 *
 * Pure and free of React for the same reason `turnClock.ts` is: this is the part worth testing.
 */

import { playerToActInView } from '@flipside/engine'
import type { PlayerView } from '@flipside/engine'

export function turnLabel(
  view: Pick<PlayerView, 'phase' | 'turn' | 'you'> & { players: ReadonlyArray<{ id: string; name: string }> },
  /** Seats played by the computer, which are thinking rather than taking their time. */
  bots: ReadonlySet<string>,
): string {
  const toAct = playerToActInView(view)
  if (toAct === null) return '—'
  if (toAct === view.you) return 'Your turn'
  const name = view.players.find(p => p.id === toAct)?.name ?? '—'
  return bots.has(toAct) ? `${name} is thinking…` : `${name}’s turn`
}
