import { describe, expect, it } from 'vitest'
import { reduce } from '../src/index.js'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, expectEvent } from './harness.js'

/** A 4-player game rigged onto a known top card, light side, p0 to play. */
function rigged(
  top: CardId,
  hands: Record<PlayerId, CardId[]>,
  opts: { players?: number; declaredColor?: 'red' | 'yellow' | 'green' | 'blue' } = {},
): Game {
  const g = new Game({ players: opts.players ?? 4 })
  g.do({ type: 'startRound' })
  g.rig({
    discard: [top],
    hands,
    turn: 'p0',
    side: 'light',
    direction: 1,
    declaredColor: opts.declaredColor ?? null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

describe('legal play — matching', () => {
  it('matches by colour', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const blue7 = d.face('light', 'blue 7')

    const g = rigged(top, { p0: [blue7, ...d.filler(2)] })
    g.do({ type: 'play', player: 'p0', card: blue7 })
    expect(g.topId).toBe(blue7)
  })

  it('matches by number across colours', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red4 = d.face('light', 'red 4')

    const g = rigged(top, { p0: [red4, ...d.filler(2)] })
    g.do({ type: 'play', player: 'p0', card: red4 })
    expect(g.topId).toBe(red4)
  })

  it('rejects a card that matches neither colour nor number', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')

    const g = rigged(top, { p0: [red7, ...d.filler(2)] })
    expect(g.reject({ type: 'play', player: 'p0', card: red7 }).code).toBe('illegal_play')
  })

  // "may only be played on a matching color or on another [same-type] card" — repeated on every
  // coloured action card in GDR44, and stricter than most people actually play it.
  it('matches symbols type-for-type only: a Skip does NOT go on a Reverse', () => {
    const d = new Deal()
    const top = d.face('light', 'blue reverse')
    const redSkip = d.face('light', 'red skip')
    const redReverse = d.face('light', 'red reverse')

    const g = rigged(top, { p0: [redSkip, redReverse], p1: d.filler(1) })
    expect(g.reject({ type: 'play', player: 'p0', card: redSkip }).code).toBe('illegal_play')

    g.do({ type: 'play', player: 'p0', card: redReverse }) // same symbol, other colour: fine
    expect(g.topId).toBe(redReverse)
  })

  it('a coloured action card still plays on its own colour', () => {
    const d = new Deal()
    const top = d.face('light', 'blue reverse')
    const blueSkip = d.face('light', 'blue skip')

    const g = rigged(top, { p0: [blueSkip, ...d.filler(2)] })
    g.do({ type: 'play', player: 'p0', card: blueSkip })
    expect(g.topId).toBe(blueSkip)
  })

  it('a wild is always playable, and must declare a colour on the right side', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const wild = d.face('light', 'wild')

    const g = rigged(top, { p0: [wild, ...d.filler(2)], p1: d.filler(1) })

    expect(g.reject({ type: 'play', player: 'p0', card: wild }).code).toBe('color_required')
    expect(g.reject({ type: 'play', player: 'p0', card: wild, declaredColor: 'teal' }).code).toBe(
      'bad_color_for_side', // a dark colour, while the game is on the light side
    )

    g.do({ type: 'play', player: 'p0', card: wild, declaredColor: 'green' })
    expect(g.state.declaredColor).toBe('green')
    expect(g.phase).toBe('awaitingPlay')
  })

  it('a non-wild may NOT declare a colour', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const blue7 = d.face('light', 'blue 7')

    const g = rigged(top, { p0: [blue7, ...d.filler(2)] })
    expect(g.reject({ type: 'play', player: 'p0', card: blue7, declaredColor: 'red' }).code).toBe(
      'color_not_allowed',
    )
  })

  it('after a wild, play must match the DECLARED colour', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const wild = d.face('light', 'wild')
    const green3 = d.face('light', 'green 3')
    const red9 = d.face('light', 'red 9')

    const g = rigged(top, { p0: [wild, ...d.filler(1)], p1: [green3, red9] })
    g.do({ type: 'play', player: 'p0', card: wild, declaredColor: 'green' })

    expect(g.turnId).toBe('p1')
    expect(g.reject({ type: 'play', player: 'p1', card: red9 }).code).toBe('illegal_play')
    g.do({ type: 'play', player: 'p1', card: green3 })
    expect(g.state.declaredColor).toBeNull() // the green 3 carries its own colour now
  })

  it('a wild may be played on a wild, re-declaring the colour', () => {
    const d = new Deal()
    const top = d.face('light', 'wild')
    const wild2 = d.face('light', 'wild')

    const g = rigged(top, { p0: [wild2, ...d.filler(2)], p1: d.filler(1) }, { declaredColor: 'red' })

    g.do({ type: 'play', player: 'p0', card: wild2, declaredColor: 'blue' })
    expect(g.state.declaredColor).toBe('blue')
  })

  it('you cannot play out of turn, or a card you do not hold', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const mine = d.face('light', 'blue 7')
    const theirs = d.face('light', 'blue 8')

    const g = rigged(top, { p0: [mine], p1: [theirs] })

    expect(g.reject({ type: 'play', player: 'p1', card: theirs }).code).toBe('not_your_turn')
    expect(g.reject({ type: 'play', player: 'p0', card: theirs }).code).toBe('card_not_in_hand')
    expect(g.reject({ type: 'play', player: 'p0', card: 'nope' }).code).toBe('unknown_card')
  })
})

describe('turn order', () => {
  it('advances one seat per play, and wraps', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    // Two cards each: emptying a hand would end the round before we got to test the wrap.
    const g = rigged(top, {
      p0: [d.face('light', 'blue 5'), ...d.filler(1)],
      p1: [d.face('light', 'blue 6'), ...d.filler(1)],
      p2: [d.face('light', 'blue 7'), ...d.filler(1)],
      p3: [d.face('light', 'blue 8'), ...d.filler(1)],
    })

    expect(g.turnId).toBe('p0')
    for (const id of ['p0', 'p1', 'p2', 'p3']) {
      g.do({ type: 'play', player: id, card: g.hand(id)[0]! })
    }
    expect(g.turnId).toBe('p0') // wrapped
  })
})

describe('drawing and passing', () => {
  it('drawing an unplayable card passes the turn automatically', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')
    const red9 = d.face('light', 'red 9') // also unplayable on a blue 4

    const g = rigged(top, { p0: [red7], p1: d.filler(1) })
    g.stackDraw(red9)

    const events = g.do({ type: 'draw', player: 'p0' })

    expect(g.hand('p0')).toEqual([red7, red9])
    expectEvent(events, 'cardsDrawn')
    expectEvent(events, 'passed')
    expect(g.turnId).toBe('p1')
    expect(g.phase).toBe('awaitingPlay')
  })

  it('drawing a PLAYABLE card holds the turn and offers the choice', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')
    const blue9 = d.face('light', 'blue 9')

    const g = rigged(top, { p0: [red7], p1: d.filler(1) })
    g.stackDraw(blue9)

    g.do({ type: 'draw', player: 'p0' })
    expect(g.phase).toBe('awaitingDrawnCardChoice')
    expect(g.turnId).toBe('p0')

    // "you may only play *that* drawn card — no other card from your hand."
    expect(g.reject({ type: 'play', player: 'p0', card: red7 }).code).toBe('not_drawn_card')
    expect(g.reject({ type: 'draw', player: 'p0' }).code).toBe('wrong_phase')

    g.do({ type: 'play', player: 'p0', card: blue9 })
    expect(g.topId).toBe(blue9)
    expect(g.turnId).toBe('p1')
  })

  it('you may decline the drawn card and pass, keeping it', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')
    const blue9 = d.face('light', 'blue 9')

    const g = rigged(top, { p0: [red7], p1: d.filler(1) })
    g.stackDraw(blue9)

    g.do({ type: 'draw', player: 'p0' })
    g.do({ type: 'pass', player: 'p0' })

    expect(g.hand('p0')).toEqual([red7, blue9])
    expect(g.turnId).toBe('p1')
  })

  // The optional-draw rule: nothing forces you to play a playable card.
  it('you may decline to play a playable card, but then you must draw', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const blue7 = d.face('light', 'blue 7')

    const g = rigged(top, { p0: [blue7], p1: d.filler(1) })
    g.do({ type: 'draw', player: 'p0' })
    expect(g.hand('p0')).toHaveLength(2)
  })

  it('passing is only legal after a draw', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: [d.face('light', 'blue 7')] })
    expect(g.reject({ type: 'pass', player: 'p0' }).code).toBe('wrong_phase')
  })

  it('you cannot draw out of turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: [d.face('light', 'blue 7')], p1: d.filler(1) })
    expect(g.reject({ type: 'draw', player: 'p1' }).code).toBe('not_your_turn')
  })
})

describe('the draw pile', () => {
  it('reshuffles the discard pile when it runs out, leaving the top card in place', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')
    const buried = d.filler(9)

    const g = new Game()
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [red7], p1: d.filler(1) },
      discard: [...buried, top], // 10 cards, `top` on top
      turn: 'p0',
      side: 'light',
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })
    g.parkDrawPileIn('p3') // the draw pile is now genuinely empty

    const events = g.do({ type: 'draw', player: 'p0' })
    const reshuffled = expectEvent(events, 'reshuffled')

    // The Spanish text is the precise one: *leave the top card*, reshuffle the rest.
    expect(reshuffled.count).toBe(9)
    expect(g.state.discardPile).toEqual([top])
    expect(g.state.drawPile).toHaveLength(8) // 9 in, 1 drawn back out
    expect(g.hand('p0')).toHaveLength(2)
  })

  // D10 — reachable after a big Wild Draw Color. Mattel never addresses it. The turn simply
  // passes: there is nothing to draw and nothing to play, and the game must not hang.
  it('with both piles exhausted, the turn passes instead of hanging (D10)', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const red7 = d.face('light', 'red 7')

    const g = new Game()
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [red7], p1: d.filler(1) },
      discard: [top],
      turn: 'p0',
      side: 'light',
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })
    // Both piles empty: the discard is a single card (nothing to reshuffle) and the draw pile is
    // gone. This is the exact position a big Wild Draw Color can leave the table in.
    g.parkDrawPileIn('p3')

    const events = g.do({ type: 'draw', player: 'p0' })

    expectEvent(events, 'pilesExhausted')
    expectEvent(events, 'passed')
    expect(g.hand('p0')).toEqual([red7]) // drew nothing, and did not throw
    expect(g.turnId).toBe('p1')
  })
})

describe('purity', () => {
  // The reducer being pure is what makes the append-only log replayable, hibernation safe, and the
  // client's prediction trustworthy. If it ever mutates its input, all three break silently.
  it('reduce does not touch the state it was given', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(top, { p0: [blue7, ...d.filler(3)], p1: d.filler(2) })

    // State is JSON-plain by design, so a JSON round-trip is a faithful deep clone.
    const before = JSON.parse(JSON.stringify(g.state))
    const result = reduce(g.state, { type: 'play', player: 'p0', card: blue7 })

    expect(result.ok).toBe(true)
    expect(g.state).toEqual(before) // the input is exactly what it was
    if (result.ok) expect(result.state).not.toEqual(before) // and the output really did change
  })

  it('state survives a JSON round trip — it must, to reach SQLite and (later) a sandbox', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })

    const revived = JSON.parse(JSON.stringify(g.state))
    expect(revived).toEqual(g.state)

    const action = { type: 'draw', player: 'p0' } as const
    expect(reduce(revived, action)).toEqual(reduce(g.state, action))
  })
})
