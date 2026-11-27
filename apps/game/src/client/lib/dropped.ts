/**
 * What a player is told, on their own screen, once they are out of the game (D18).
 *
 * This is the one place the reason has to be spelled out. Everybody else gets a line in the feed
 * as it happens; the player it happened to may not have been looking — that is rather the point —
 * and can come back minutes later to a board with no hand on it. The reason is kept on their seat
 * in the game state precisely so that this can still say which it was after a reload.
 */

import type { DropReason } from '@flipside/engine'

export function droppedNotice(
  reason: DropReason,
  limit: number,
  opts: {
    /**
     * Nobody but computer players is left in the game. The room stops them when the last person
     * goes, so there is nothing further to watch, and the notice must not promise that there is.
     */
    tableEmpty?: boolean
  } = {},
): string {
  const why =
    reason === 'timeouts'
      ? `You ran out of time ${limit} turns in a row.`
      : 'You were away too long, so your seat was given up.'
  const now = opts.tableEmpty
    ? 'You’re out of this game, and with nobody else at the table it has stopped.'
    : 'You’re out of this game, but you can keep watching.'
  return `${why} ${now}`
}
