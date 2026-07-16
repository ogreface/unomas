/**
 * The Flip card.
 *
 * *"flip over the Discard Pile (the card just played will now be on the bottom), then the Draw
 * Pile, then everyone's hands must flip to the other side."*
 *
 * The counterintuitive consequence — and the single most-misimplemented rule in Uno Flip — is that
 * the new active card is the **dark face of the card that was at the BOTTOM of the discard pile**,
 * not the dark face of the Flip card you just played. Most digital versions quietly simplify this.
 * These tests exist to make sure we never do.
 */

import { describe, expect, it } from 'vitest'
import { activeColor, faceOn, cardIndex, getPack } from '../src/index.js'
import type { CardId, GameState } from '../src/index.js'
import { Deal, Game, expectEvent, face, faceStr } from './harness.js'

const CARDS = cardIndex(getPack('unoflip'))
const dark = (id: CardId) => faceStr(faceOn(CARDS, id, 'dark'))
const light = (id: CardId) => faceStr(faceOn(CARDS, id, 'light'))
const colorNow = (s: GameState) => activeColor(s, CARDS)

/** Rig a 4-player game with a specific discard pile, p0 to play, on the light side. */
function withPile(discard: CardId[], hands: Record<string, CardId[]>): Game {
  const g = new Game({ players: 4 })
  g.do({ type: 'startRound' })
  g.rig({
    discard,
    hands,
    turn: 'p0',
    side: 'light',
    direction: 1,
    declaredColor: null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

describe('the Flip card', () => {
  it('exposes the BOTTOM card of the discard pile, on its other face', () => {
    const d = new Deal()
    // Build a pile bottom→top. `bottom` is the first card discarded this round; it is the one the
    // Flip will promote, and we will read its DARK face.
    const bottom = d.both('blue 2', 'orange 8')
    const middle = d.face('light', 'blue 5')
    const top = d.face('light', 'blue 7')
    const flip = d.both('blue flip', 'purple 6')

    const g = withPile([bottom, middle, top], { p0: [flip, ...d.filler(2)], p1: d.filler(3) })

    expect(g.side).toBe('light')
    expect(light(g.topId)).toBe('blue 7')

    const events = g.do({ type: 'play', player: 'p0', card: flip })

    // The side flipped…
    expect(g.side).toBe('dark')
    // …the pile inverted, so the Flip card we just played is now at the BOTTOM…
    expect(g.state.discardPile[0]).toBe(flip)
    // …and the card that was at the bottom is now on top, showing its dark face.
    expect(g.topId).toBe(bottom)
    expect(dark(g.topId)).toBe('orange 8')

    // NOT the flip card's own dark face — that is the bug this test exists to prevent. If the
    // engine ever "simplifies" to showing the played card's back, the active colour becomes purple.
    expect(dark(flip)).toBe('purple 6')
    expect(colorNow(g.state)).toBe('orange')
    expect(colorNow(g.state)).not.toBe('purple')

    const flipped = expectEvent(events, 'flipped')
    expect(flipped.side).toBe('dark')
    expect(flipped.newTop).toBe(bottom)
  })

  it('inverts the whole pile, not just the top card (D5)', () => {
    const d = new Deal()
    const a = d.face('light', 'blue 2')
    const b = d.face('light', 'blue 3')
    const c = d.face('light', 'blue 5')
    const flip = d.face('light', 'blue flip')

    const g = withPile([a, b, c], { p0: [flip, ...d.filler(2)], p1: d.filler(3) })
    g.do({ type: 'play', player: 'p0', card: flip })

    // bottom→top was [a, b, c, flip]; inverted it is [flip, c, b, a].
    expect(g.state.discardPile).toEqual([flip, c, b, a])
  })

  it('flips back: a second Flip re-inverts the pile and returns to the light side', () => {
    const d = new Deal()
    const bottom = d.both('blue 2', 'orange 8')
    const mid = d.face('light', 'blue 5')
    const flip1 = d.both('blue flip', 'purple 6')
    // After the first Flip the top reads `orange 8`, so p1 needs a dark Flip that is *orange* to
    // play on it. `green 1 / orange flip` is exactly that card — and note that to p1 it looks like
    // a green 1.
    const flip2 = d.both('green 1', 'orange flip')

    const g = withPile([bottom, mid], { p0: [flip1, ...d.filler(2)], p1: [flip2, ...d.filler(2)] })

    g.do({ type: 'play', player: 'p0', card: flip1 })
    expect(g.side).toBe('dark')
    expect(g.state.discardPile).toEqual([flip1, mid, bottom])
    expect(g.turnId).toBe('p1')

    g.do({ type: 'play', player: 'p1', card: flip2 })

    // The pile was [flip1, mid, bottom, flip2]; inverted, [flip2, bottom, mid, flip1].
    expect(g.side).toBe('light')
    expect(g.state.discardPile).toEqual([flip2, bottom, mid, flip1])
    // The new top is flip1 — on its LIGHT face, which is where this round started.
    expect(g.topId).toBe(flip1)
    expect(light(g.topId)).toBe('blue flip')
    expect(colorNow(g.state)).toBe('blue')
  })

  it('hands and the draw pile flip for free — the same cards now read as their other faces', () => {
    const d = new Deal()
    const bottom = d.both('blue 2', 'orange 8')
    const flip = d.both('blue flip', 'purple 6')
    const held = d.both('blue 5', 'pink 9')

    const g = withPile([bottom], { p0: [flip, held], p1: d.filler(3) })

    const handBefore = [...g.hand('p0')]
    g.do({ type: 'play', player: 'p0', card: flip })

    // The hand is still the same card ids — nothing was re-dealt or re-paired…
    expect(g.hand('p0')).toEqual(handBefore.filter(id => id !== flip))
    // …but the live face of every one of them is now the dark one.
    expect(light(held)).toBe('blue 5')
    expect(dark(held)).toBe('pink 9')
    expect(faceStr(face(held, g.side))).toBe('pink 9')
  })

  it('the draw pile is physically inverted, so a different card is next', () => {
    const d = new Deal()
    const bottom = d.both('blue 2', 'orange 8')
    const flip = d.face('light', 'blue flip')

    const g = withPile([bottom], { p0: [flip, ...d.filler(2)], p1: d.filler(3) })

    const drawBefore = [...g.state.drawPile]
    g.do({ type: 'play', player: 'p0', card: flip })

    expect(g.state.drawPile).toEqual(drawBefore.slice().reverse())
  })
})

// ---------------------------------------------------------------------------------------------
// D3 — a Flip exposes a wild face. Exactly 8 of the 112 cards can do this.
// ---------------------------------------------------------------------------------------------

describe('a Flip that exposes a wild (D3)', () => {
  // c031 is `blue reverse / wild`: a card that looks like a boring Reverse to you, and is a Wild
  // the whole table can see coming.
  const BLUE_REVERSE_WILD = 'c031'

  it('leaves no active colour, and the player who flipped chooses it', () => {
    expect(dark(BLUE_REVERSE_WILD)).toBe('wild')

    const d = new Deal()
    d.card(BLUE_REVERSE_WILD)
    const mid = d.face('light', 'blue 5')
    const flip = d.face('light', 'blue flip')

    const g = withPile([BLUE_REVERSE_WILD, mid], { p0: [flip, ...d.filler(2)], p1: d.filler(3) })
    g.do({ type: 'play', player: 'p0', card: flip })

    expect(g.side).toBe('dark')
    expect(g.topId).toBe(BLUE_REVERSE_WILD)
    expect(g.phase).toBe('awaitingColorChoice')

    const phase = g.state.phase as { t: 'awaitingColorChoice'; chooser: string; reason: string }
    expect(phase.chooser).toBe('p0') // the player who played the Flip
    expect(phase.reason).toBe('flip')

    // Nobody may play until a colour exists.
    expect(g.reject({ type: 'play', player: 'p1', card: g.hand('p1')[0]! }).code).toBe('wrong_phase')
    expect(g.reject({ type: 'chooseColor', player: 'p1', color: 'teal' }).code).toBe('not_your_turn')
    // And it must be a *dark* colour — we are on the dark side now.
    expect(g.reject({ type: 'chooseColor', player: 'p0', color: 'blue' }).code).toBe('bad_color_for_side')

    g.do({ type: 'chooseColor', player: 'p0', color: 'teal' })

    expect(g.state.declaredColor).toBe('teal')
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1') // and only now does the turn advance
  })

  it('the colour declared on the old side does not carry across the flip', () => {
    const d = new Deal()
    d.card(BLUE_REVERSE_WILD)
    const flip = d.face('light', 'blue flip')

    const g = withPile([BLUE_REVERSE_WILD, d.face('light', 'blue 5')], {
      p0: [flip, ...d.filler(2)],
      p1: d.filler(3),
    })
    g.rig({ declaredColor: 'blue' }) // a light colour was in force

    g.do({ type: 'play', player: 'p0', card: flip })

    // `blue` is meaningless on the dark side, and the engine must not carry it over.
    expect(g.state.declaredColor).toBeNull()
    expect(g.phase).toBe('awaitingColorChoice')
  })
})

// ---------------------------------------------------------------------------------------------
// D4 — a Flip exposes an action card. It was revealed, not played.
// ---------------------------------------------------------------------------------------------

describe('a Flip that exposes an action card (D4)', () => {
  it('does NOT apply the action — the card was revealed, not played', () => {
    const d = new Deal()
    // `blue 4 / teal draw5`: flipping onto it exposes a Draw Five. Nobody should draw five.
    const bottom = d.both('blue 4', 'teal draw5')
    const flip = d.face('light', 'blue flip')

    const g = withPile([bottom, d.face('light', 'blue 5')], {
      p0: [flip, ...d.filler(2)],
      p1: d.filler(3),
    })

    const p1Before = g.hand('p1').length
    const events = g.do({ type: 'play', player: 'p0', card: flip })

    expect(g.topId).toBe(bottom)
    expect(dark(bottom)).toBe('teal draw5')

    // Nobody drew anything…
    expect(g.hand('p1')).toHaveLength(p1Before)
    expect(events.filter(e => e.t === 'cardsDrawn')).toHaveLength(0)
    // …and nobody was skipped: the turn passed normally.
    expect(g.turnId).toBe('p1')

    // But it *does* set the active colour and symbol, so the next play must match a teal or a
    // Draw Five.
    expect(g.state.side).toBe('dark')
  })

  it('an exposed Reverse does not reverse', () => {
    const d = new Deal()
    const bottom = d.both('blue 5', 'orange reverse')
    const flip = d.face('light', 'blue flip')

    const g = withPile([bottom, d.face('light', 'blue 7')], {
      p0: [flip, ...d.filler(2)],
      p1: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: flip })

    expect(dark(bottom)).toBe('orange reverse')
    expect(g.state.direction).toBe(1) // unchanged
    expect(g.turnId).toBe('p1')
  })
})

// ---------------------------------------------------------------------------------------------
// D11 — a reshuffle collapses the discard pile, changing what the next Flip exposes.
// ---------------------------------------------------------------------------------------------

describe('reshuffle × Flip (D11)', () => {
  it('after a reshuffle the pile is one card, so a Flip exposes that card’s other face', () => {
    const d = new Deal()
    const top = d.both('blue 4', 'purple 1')
    const buried = d.filler(6)
    const flip = d.both('blue flip', 'purple 6')

    const g = new Game()
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [flip, ...d.filler(1)], p1: d.filler(2) },
      discard: [...buried, top],
      turn: 'p0',
      side: 'light',
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })
    g.parkDrawPileIn('p3')

    // Force the reshuffle: p0 draws, which empties the discard down to `top`.
    g.do({ type: 'draw', player: 'p0' })
    expect(g.state.discardPile).toEqual([top])

    // Whatever p0 drew, get the turn back to them and play the Flip.
    g.rig({ turn: 'p0', phase: { t: 'awaitingPlay' } })
    g.do({ type: 'play', player: 'p0', card: flip })

    // The pile was [top, flip]; inverted it is [flip, top]. The Flip exposes `top`'s dark face —
    // the reshuffle reset what "the bottom card" means.
    expect(g.state.discardPile).toEqual([flip, top])
    expect(g.topId).toBe(top)
    expect(dark(top)).toBe('purple 1')
  })
})

// ---------------------------------------------------------------------------------------------
// The house-rule escape hatch, in case playtesting hates the real rule.
// ---------------------------------------------------------------------------------------------

describe('flipInvertsDiscardPile: false (the house-rule toggle)', () => {
  it('exposes the played Flip card’s own dark face instead', () => {
    const d = new Deal()
    const bottom = d.both('blue 2', 'orange 8')
    const flip = d.both('blue flip', 'purple 6')

    const g = new Game({ players: 4, options: { flipInvertsDiscardPile: false } })
    g.do({ type: 'startRound' })
    g.rig({
      discard: [bottom, d.face('light', 'blue 5')],
      hands: { p0: [flip, ...d.filler(2)], p1: d.filler(3) },
      turn: 'p0',
      side: 'light',
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })

    g.do({ type: 'play', player: 'p0', card: flip })

    expect(g.side).toBe('dark')
    expect(g.topId).toBe(flip) // the pile did not invert
    expect(dark(g.topId)).toBe('purple 6')
  })
})
