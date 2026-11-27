import { describe, expect, it } from 'vitest'
import { droppedNotice } from './dropped.js'

describe('droppedNotice — what a player is told on their own screen once they are out', () => {
  it('tells a player who was away that their seat was given up', () => {
    expect(droppedNotice('disconnected', 3)).toBe(
      'You were away too long, so your seat was given up. You’re out of this game, but you can keep watching.',
    )
  })

  it('tells a player the clock gave up on how many turns it took', () => {
    expect(droppedNotice('timeouts', 3)).toBe(
      'You ran out of time 3 turns in a row. You’re out of this game, but you can keep watching.',
    )
  })

  it('uses the room’s own limit, not a hard-coded three', () => {
    expect(droppedNotice('timeouts', 5)).toContain('5 turns in a row')
  })

  it('does not promise a game to watch when nobody is left playing it', () => {
    // The last person at a table of computer players: the room stops the bots, so there is
    // nothing more to see, and saying "keep watching" would leave them staring at a frozen board.
    expect(droppedNotice('timeouts', 3, { tableEmpty: true })).toBe(
      'You ran out of time 3 turns in a row. You’re out of this game, and with nobody else at the table it has stopped.',
    )
    expect(droppedNotice('disconnected', 3, { tableEmpty: true })).toContain('it has stopped')
  })
})
