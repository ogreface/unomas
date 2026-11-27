import { describe, expect, it } from 'vitest'
import type { PhaseView } from '@flipside/engine'
import { liveGap, nextInOrder, revealScroll, upNext } from './turnOrder.js'

/**
 * The order strip answers two questions at a glance — "who is on turn" and "who are they playing
 * on" — and on a phone it can only answer them if both tiles are actually on screen. These pin down
 * the two pieces of arithmetic behind that: walking the seats, and scrolling just far enough.
 */

const seats = [{ id: 'ann' }, { id: 'bo' }, { id: 'cy' }, { id: 'di' }]

describe('nextInOrder', () => {
  it('is the seat after the turn, going up the order', () => {
    expect(nextInOrder(seats, 'ann', 1)).toBe('bo')
    expect(nextInOrder(seats, 'cy', 1)).toBe('di')
  })

  it('wraps from the last seat back to the first', () => {
    expect(nextInOrder(seats, 'di', 1)).toBe('ann')
  })

  it('walks down the order once play is reversed, wrapping from the first seat to the last', () => {
    expect(nextInOrder(seats, 'cy', -1)).toBe('bo')
    expect(nextInOrder(seats, 'ann', -1)).toBe('di')
  })

  it('is the other player in a two-player game, whichever way play is going', () => {
    const two = [{ id: 'ann' }, { id: 'bo' }]
    expect(nextInOrder(two, 'ann', 1)).toBe('bo')
    expect(nextInOrder(two, 'ann', -1)).toBe('bo')
    expect(nextInOrder(two, 'bo', -1)).toBe('ann')
  })

  it('is nobody when nobody is on turn, or the turn names a seat that is not there', () => {
    expect(nextInOrder(seats, null, 1)).toBeNull()
    expect(nextInOrder(seats, 'ghost', 1)).toBeNull()
    expect(nextInOrder([{ id: 'ann' }], 'ann', 1)).toBeNull()
  })
})

describe('upNext', () => {
  // Bo holds the turn throughout; what changes is who the table is waiting on.
  const table = (phase: PhaseView) => ({ phase, players: seats, turn: 'bo', direction: 1 as const })
  const resume = { actor: 1, extraSkips: 0, forcedTurn: null }

  it('is the seat after the player on turn while they play, draw, or name a colour', () => {
    expect(upNext(table({ t: 'awaitingPlay' }))).toBe('cy')
    expect(upNext(table({ t: 'awaitingDrawnCardChoice', card: 'k1' }))).toBe('cy')
    expect(upNext(table({ t: 'awaitingColorChoice', chooser: 'bo', reason: 'flip', resume }))).toBe('cy')
  })

  it('looks past the challenger while a wild draw waits on its challenge', () => {
    // Bo played the wild draw, so the turn still sits with Bo — but the table is waiting on Cy, the
    // seat it is highlighting. Whatever Cy decides, the seat after Cy is the one to flag: Cy draws
    // and loses the turn unless the challenge catches Bo out.
    const challenge: PhaseView = {
      t: 'awaitingChallenge',
      challenger: 'cy',
      accused: 'bo',
      kind: 'wildDraw2',
      color: 'red',
      priorColor: 'blue',
      resume,
    }
    expect(upNext(table(challenge))).toBe('di')
  })

  it('names nobody between rounds, when there is no turn to follow', () => {
    expect(upNext(table({ t: 'lobby' }))).toBeNull()
    expect(upNext(table({ t: 'roundOver', winner: 'bo', points: 40 }))).toBeNull()
    expect(upNext(table({ t: 'gameOver', winner: 'bo' }))).toBeNull()
  })
})

describe('liveGap', () => {
  // Gap k sits just before seat k; gap 0 is where play wraps from one end of the row to the other.
  it('is the gap just after the turn when play goes up the order', () => {
    expect(liveGap(seats, 'ann', 1)).toBe(1)
    expect(liveGap(seats, 'cy', 1)).toBe(3)
  })

  it('is the gap just before the turn when play is reversed', () => {
    expect(liveGap(seats, 'cy', -1)).toBe(2)
    expect(liveGap(seats, 'bo', -1)).toBe(1)
  })

  it('is the wrap-around when play runs off either end of the row', () => {
    expect(liveGap(seats, 'di', 1)).toBe(0)
    expect(liveGap(seats, 'ann', -1)).toBe(0)
  })

  it('is no gap at all when nobody is on turn', () => {
    expect(liveGap(seats, null, 1)).toBeNull()
    expect(liveGap(seats, 'ghost', -1)).toBeNull()
  })
})

describe('revealScroll', () => {
  // A 300px window onto a strip of 160px tiles with 20px gaps: tile k spans [180k, 180k + 160].
  const tile = (k: number) => ({ left: 180 * k, right: 180 * k + 160 })
  const view = (scrollLeft: number) => ({ scrollLeft, width: 300 })

  it('leaves the strip alone when the turn and the next seat are already in view', () => {
    expect(revealScroll(view(0), tile(0), tile(1))).toBe(0)
  })

  it('scrolls right just far enough to bring the next seat in, plus a margin', () => {
    // Turn on tile 1 [180, 340], next on tile 2 [360, 520]: the pair is 340px, wider than the
    // window, so only the turn is guaranteed — and it is already partly hidden on the right.
    expect(revealScroll(view(0), tile(1), tile(2))).toBe(340 - 300 + 12)
  })

  it('shows the pair together whenever it fits', () => {
    const narrow = (k: number) => ({ left: 130 * k, right: 130 * k + 110 })
    // Turn [130, 240], next [260, 370]: the pair spans 240px and fits a 300px window.
    expect(revealScroll(view(0), narrow(1), narrow(2))).toBe(370 - 300 + 12)
  })

  it('scrolls back left when the turn has moved behind the window', () => {
    expect(revealScroll(view(400), tile(0), tile(1))).toBe(0)
  })

  it('keeps the turn in view, not the next seat, when the pair is too wide to show together', () => {
    // Play wraps from the last tile to the first: the "pair" is the whole strip.
    expect(revealScroll(view(0), tile(3), tile(0))).toBe(tile(3).right - 300 + 12)
  })

  it('never scrolls to a negative offset', () => {
    expect(revealScroll(view(50), { left: 4, right: 100 }, null)).toBe(0)
  })
})
