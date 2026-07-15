/**
 * Scoring, round end, and game end.
 *
 * *"REMEMBER TO SCORE POINTS BASED ON WHICH SIDE (LIGHT OR DARK) THE GAME ENDED ON."*
 *
 * The same physical card is worth 10 as a light Draw One and 20 as a dark Draw Five. Which side
 * the round ended on is therefore not a detail — it can double a hand's value.
 */

import { describe, expect, it } from 'vitest'
import { cardIndex, getPack, handValue, unoflipPack } from '../src/index.js'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, expectEvent, face } from './harness.js'

const CARDS = cardIndex(getPack('unoflip'))

function rigged(
  top: CardId,
  hands: Record<PlayerId, CardId[]>,
  opts: { players?: number; side?: 'light' | 'dark'; options?: Record<string, unknown> } = {},
): Game {
  const g = new Game({ players: opts.players ?? 4, options: opts.options ?? {} })
  g.do({ type: 'startRound' })
  g.rig({
    discard: [top],
    hands,
    turn: 'p0',
    side: opts.side ?? 'light',
    direction: 1,
    declaredColor: null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

describe('card values', () => {
  it('match Mattel’s table exactly', () => {
    const v = (id: CardId, side: 'light' | 'dark') => unoflipPack.cardValue(face(id, side))
    const d = new Deal()

    expect(v(d.face('light', 'blue 7'), 'light')).toBe(7) // numbers score face value
    expect(v(d.face('light', 'blue 1'), 'light')).toBe(1)
    expect(v(d.face('light', 'blue 9'), 'light')).toBe(9)

    expect(v(d.face('light', 'blue draw1'), 'light')).toBe(10)
    expect(v(d.face('dark', 'teal draw5'), 'dark')).toBe(20)
    expect(v(d.face('light', 'blue reverse'), 'light')).toBe(20)
    expect(v(d.face('dark', 'teal reverse'), 'dark')).toBe(20)
    expect(v(d.face('light', 'blue skip'), 'light')).toBe(20)
    expect(v(d.face('dark', 'purple skipEveryone'), 'dark')).toBe(30)
    expect(v(d.face('light', 'blue flip'), 'light')).toBe(20)
    expect(v(d.face('dark', 'teal flip'), 'dark')).toBe(20)
    expect(v(d.face('light', 'wild'), 'light')).toBe(40)
    expect(v(d.face('dark', 'wild'), 'dark')).toBe(40)
    expect(v(d.face('light', 'wildDraw2'), 'light')).toBe(50)
    expect(v(d.face('dark', 'wildDrawColor'), 'dark')).toBe(60)
  })

  // The single most important consequence of a non-type-preserving pairing: a card's *worth*
  // changes when the table flips, and not by a predictable amount.
  it('the same card is worth different points on each side', () => {
    const d = new Deal()
    const card = d.both('red skip', 'orange draw5')

    expect(unoflipPack.cardValue(face(card, 'light'))).toBe(20) // a Skip
    expect(unoflipPack.cardValue(face(card, 'dark'))).toBe(20) // a Draw Five

    const wild = d.both('blue reverse', 'wild')
    expect(unoflipPack.cardValue(face(wild, 'light'))).toBe(20) // a humble Reverse…
    expect(unoflipPack.cardValue(face(wild, 'dark'))).toBe(40) // …is a Wild on its back
  })

  it('handValue sums a hand on the side the game ended on', () => {
    const d = new Deal()
    const hand = [d.both('blue reverse', 'wild'), d.both('red skip', 'orange draw5')]

    expect(handValue(unoflipPack, CARDS, hand, 'light')).toBe(20 + 20)
    expect(handValue(unoflipPack, CARDS, hand, 'dark')).toBe(40 + 20)
  })
})

describe('round end', () => {
  it('the winner scores every card left in every other hand', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const last = d.face('light', 'blue 5')

    const g = rigged(top, {
      p0: [last],
      p1: [d.face('light', 'red 7'), d.face('light', 'green 3')], // 10
      p2: [d.face('light', 'yellow skip')], // 20
      p3: [d.face('light', 'wild')], // 40
    })

    const events = g.do({ type: 'play', player: 'p0', card: last })
    const ended = expectEvent(events, 'roundEnded')

    expect(ended.winner).toBe('p0')
    expect(ended.points).toBe(7 + 3 + 20 + 40)
    expect(g.score('p0')).toBe(70)
    expect(g.score('p1')).toBe(0)
    expect(g.phase).toBe('roundOver')
  })

  it('scores on the side the round ENDED on, not the side it started on', () => {
    const d = new Deal()
    // p0's last card is a Flip. Playing it ends the round *and* switches the side — so everyone
    // else's hand is scored on their dark faces.
    const bottom = d.both('blue 2', 'orange 8')
    const flip = d.both('blue flip', 'purple 6')

    // `blue reverse / wild`: worth 20 on the light side, 40 on the dark.
    const twoFaced = d.both('blue reverse', 'wild')

    const g = rigged(bottom, { p0: [flip], p1: [twoFaced], p2: [], p3: [] })

    const events = g.do({ type: 'play', player: 'p0', card: flip })

    expect(g.side).toBe('dark') // the Flip took effect before scoring
    expect(expectEvent(events, 'roundEnded').points).toBe(40) // the dark value
    expect(g.score('p0')).toBe(40)
  })

  // "If the last card played was a Draw One / Draw Five / Wild Draw Two / Wild Draw Color, the
  // next player must still draw — and those cards count toward the winner's score."
  it('a Draw One played as the last card still makes the next player draw, and it counts', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const draw1 = d.face('light', 'blue draw1')

    const g = rigged(top, { p0: [draw1], p1: [], p2: [], p3: [] })

    const events = g.do({ type: 'play', player: 'p0', card: draw1 })

    expect(g.hand('p1')).toHaveLength(1) // they drew, even though the round was already decided
    const ended = expectEvent(events, 'roundEnded')
    expect(ended.winner).toBe('p0')

    // And the card they were forced to draw is in the winner's score.
    const drawn = g.hand('p1')[0]!
    expect(ended.points).toBe(unoflipPack.cardValue(face(drawn, 'light')))
  })

  // This is *why* `settle` resolves the challenge before checking for a winner: the challenger's
  // forced draw has to happen before the hand it lands in gets counted.
  it('a Wild Draw Two played as the last card: the challenge resolves, then the round ends', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')

    const g = rigged(top, { p0: [wd2], p1: [], p2: [], p3: [] })

    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    // The round is NOT over yet — the challenge is still open, and its draw is still owed.
    expect(g.phase).toBe('awaitingChallenge')
    expect(g.hand('p0')).toHaveLength(0)

    const events = g.do({ type: 'challenge', player: 'p1' })

    // p0's hand was empty, so they held no card of the active colour: the play was innocent, and
    // it is p1 who pays — two, plus two more. A challenge can never un-win a round.
    expect(expectEvent(events, 'challenged').guilty).toBe(false)
    expect(g.hand('p1')).toHaveLength(4)

    const ended = expectEvent(events, 'roundEnded')
    expect(ended.winner).toBe('p0')
    // And every one of those four cards counts toward p0's score.
    expect(ended.points).toBe(handValue(unoflipPack, CARDS, g.hand('p1'), 'light'))
    expect(ended.points).toBeGreaterThan(0)
  })

  it('a game ends when someone reaches the score limit', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const last = d.face('light', 'blue 5')

    const g = rigged(top, {
      p0: [last],
      p1: [d.face('light', 'wild'), d.face('light', 'wildDraw2')], // 90
      p2: [],
      p3: [],
    })
    g.rig({ scores: { p0: 450 } })

    const events = g.do({ type: 'play', player: 'p0', card: last })

    expect(g.score('p0')).toBe(540)
    expect(expectEvent(events, 'gameEnded').winner).toBe('p0')
    expect(g.phase).toBe('gameOver')

    // And nothing works after that.
    expect(g.reject({ type: 'startRound' }).code).toBe('wrong_phase')
  })

  it('under the limit, the round just ends and another can start', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const last = d.face('light', 'blue 5')

    const g = rigged(top, { p0: [last], p1: [d.face('light', 'blue 7')], p2: [], p3: [] })

    g.do({ type: 'play', player: 'p0', card: last })
    expect(g.phase).toBe('roundOver')
    expect(g.score('p0')).toBe(7)
    expect(g.state.dealer).toBe(1) // rotated

    g.do({ type: 'startRound' })
    expect(g.phase).not.toBe('roundOver')
    expect(g.state.roundNumber).toBe(2)
    expect(g.side).toBe('light') // every round starts light
    for (const p of g.state.players) expect(p.hand).toHaveLength(7)
    expect(g.score('p0')).toBe(7) // scores carry across rounds
  })
})

describe('a full four-player round, scored on both sides', () => {
  it('completes and scores correctly', () => {
    const d = new Deal()

    // Light side to start; p0 flips the table to dark, then wins there. Everyone is scored dark.
    const bottom = d.both('blue 2', 'orange 8')
    const flip = d.both('blue flip', 'purple 6')
    const orange5 = d.face('dark', 'orange 5')

    const g = rigged(bottom, {
      p0: [flip, orange5],
      p1: [d.both('red skip', 'orange draw5')], // light: Skip 20 · dark: Draw Five 20
      p2: [d.both('blue reverse', 'wild')], // light: Reverse 20 · dark: Wild 40
      p3: [d.both('yellow 3', 'purple 1')], // light: 3 · dark: 1
    })

    g.do({ type: 'play', player: 'p0', card: flip })
    expect(g.side).toBe('dark')
    expect(g.turnId).toBe('p1')

    // Nobody else can play on the orange 8, so they draw round the table back to p0.
    g.rig({ turn: 'p0', phase: { t: 'awaitingPlay' } })
    const events = g.do({ type: 'play', player: 'p0', card: orange5 })

    const ended = expectEvent(events, 'roundEnded')
    expect(ended.winner).toBe('p0')
    expect(ended.points).toBe(20 + 40 + 1) // dark values, not 20 + 20 + 3
    expect(g.score('p0')).toBe(61)
  })
})
