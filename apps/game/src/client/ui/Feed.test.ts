/**
 * The feed is how the table finds out *why* something happened, and a player disappearing is the
 * case where that matters most: a hand of cards vanishes and the turn jumps, with nobody there to
 * say what they did. These are the three lines that explain it.
 */

import { describe as suite, expect, it } from 'vitest'
import type { EventView } from '@flipside/engine'
import { describe as narrate } from './Feed.js'

const NAMES: Record<string, string> = { p0: 'Ann', p1: 'Bo' }
const nameOf = (id: string): string => NAMES[id] ?? '—'
const say = (event: EventView): string | null => narrate(event, nameOf)

suite('narrating a player leaving', () => {
  it('says a player who closed their tab left the game', () => {
    expect(say({ t: 'playerDropped', player: 'p1', reason: 'disconnected', cards: 5 })).toBe(
      'Bo left the game',
    )
  })

  it('says a player the clock gave up on was dropped — they did not choose to go', () => {
    expect(say({ t: 'playerDropped', player: 'p1', reason: 'timeouts', cards: 5 })).toBe(
      'Bo was dropped from the game',
    )
  })

  it('counts a timeout towards the limit, so nobody is surprised by the third', () => {
    const timedOut = { t: 'timedOut', player: 'p1', phase: 'awaitingPlay' } as const
    expect(say({ ...timedOut, strikes: 1, limit: 3 })).toBe('Bo ran out of time (1 of 3)')
    expect(say({ ...timedOut, strikes: 3, limit: 3 })).toBe('Bo ran out of time (3 of 3)')
  })

  it('does not count towards a limit the room has switched off', () => {
    expect(say({ t: 'timedOut', player: 'p1', phase: 'awaitingPlay', strikes: 4, limit: 0 })).toBe(
      'Bo ran out of time',
    )
  })

  it('tells the target of a wild draw that it is off when the player who played it leaves', () => {
    expect(say({ t: 'challengeVoided', challenger: 'p0' })).toBe('The draw is off — Ann plays on')
  })
})
