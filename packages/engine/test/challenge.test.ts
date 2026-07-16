/**
 * The challenge.
 *
 * D7: we do **not** hard-block an "illegal" wild-draw. Blocking it is easy and it deletes the
 * challenge minigame — which is a real, published rule on both wild-draw cards. So the engine
 * allows the play and lets the next player police it.
 *
 * Guilty  → the accused draws instead of you, and you keep your turn.
 * Innocent → you draw, plus two more, and lose your turn.
 */

import { describe, expect, it } from 'vitest'
import { DECK, cardIndex, faceOn, getPack } from '../src/index.js'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, expectEvent, noEvent } from './harness.js'

const CARDS = cardIndex(getPack('unoflip'))

function rigged(
  top: CardId,
  hands: Record<PlayerId, CardId[]>,
  opts: {
    players?: number
    side?: 'light' | 'dark'
    declaredColor?: 'red' | 'yellow' | 'green' | 'blue'
    options?: Record<string, unknown>
  } = {},
): Game {
  const g = new Game({ players: opts.players ?? 4, options: opts.options ?? {} })
  g.do({ type: 'startRound' })
  g.rig({
    discard: [top],
    hands,
    turn: 'p0',
    side: opts.side ?? 'light',
    direction: 1,
    declaredColor: opts.declaredColor ?? null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

describe('Wild Draw Two', () => {
  it('opens a challenge window at the next player instead of drawing immediately', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'wildDraw2'), ...d.filler(1)],
      p1: d.filler(3),
      p2: d.filler(2),
    })

    const events = g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]!, declaredColor: 'red' })

    expect(g.phase).toBe('awaitingChallenge')
    const opened = expectEvent(events, 'challengeOpened')
    expect(opened.challenger).toBe('p1')
    expect(opened.accused).toBe('p0')
    expect(opened.kind).toBe('wildDraw2')

    noEvent(events, 'cardsDrawn') // nothing is drawn until the challenge resolves
    expect(g.hand('p1')).toHaveLength(3)
  })

  it('accepting the draw: two cards, and you lose your turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'wildDraw2'), ...d.filler(1)],
      p1: d.filler(3),
      p2: d.filler(2),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]!, declaredColor: 'red' })

    expect(g.reject({ type: 'acceptDraw', player: 'p2' }).code).toBe('not_your_turn')
    g.do({ type: 'acceptDraw', player: 'p1' })

    expect(g.hand('p1')).toHaveLength(5)
    expect(g.turnId).toBe('p2') // p1 lost their turn
    expect(g.state.declaredColor).toBe('red')
  })

  // "Guilty → they draw 2 instead of you."
  it('a successful challenge: the accused draws two, and the challenger keeps their turn', () => {
    const d = new Deal()
    const blue4 = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')
    const guiltyCard = d.face('light', 'blue 9') // p0 held a blue — they should not have played it

    const g = rigged(blue4, { p0: [wd2, guiltyCard], p1: d.filler(3), p2: d.filler(2) })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do({ type: 'challenge', player: 'p1' })
    const verdict = expectEvent(events, 'challenged')

    expect(verdict.guilty).toBe(true)
    expect(verdict.revealed).toEqual([guiltyCard]) // shown to the challenger
    expect(g.hand('p0')).toHaveLength(3) // p0 drew the two
    expect(g.hand('p1')).toHaveLength(3) // p1 drew nothing
    expect(g.turnId).toBe('p1') // and keeps their turn
  })

  // "Innocent → you draw 2 + 2 more (4 total)."
  it('a failed challenge: the challenger draws four and loses their turn', () => {
    const d = new Deal()
    const blue4 = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')
    const innocent = d.face('light', 'red 9') // no blue in hand: the play was legal

    const g = rigged(blue4, { p0: [wd2, innocent], p1: d.filler(3), p2: d.filler(2) })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do({ type: 'challenge', player: 'p1' })
    expect(expectEvent(events, 'challenged').guilty).toBe(false)

    expect(g.hand('p0')).toHaveLength(1) // p0 drew nothing
    expect(g.hand('p1')).toHaveLength(7) // 3 + 2 + 2
    expect(g.turnId).toBe('p2') // and lost their turn
  })

  // D8. "Does holding another Wild count as a match?" — presumably not, and it falls out of the
  // model: a wild face has no colour, so it can never equal the active colour.
  it('holding another Wild is not a colour match, so the play was innocent (D8)', () => {
    const d = new Deal()
    const blue4 = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')
    const anotherWild = d.face('light', 'wild')

    const g = rigged(blue4, { p0: [wd2, anotherWild], p1: d.filler(3), p2: d.filler(2) })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do({ type: 'challenge', player: 'p1' })
    expect(expectEvent(events, 'challenged').guilty).toBe(false)
  })

  // D8, the other half: when the top card is a wild, "matches the COLOR" means the *declared*
  // colour.
  it('guilt is measured against the DECLARED colour when a wild is on top (D8)', () => {
    const d = new Deal()
    const topWild = d.face('light', 'wild')
    const wd2 = d.face('light', 'wildDraw2')
    const green5 = d.face('light', 'green 5')

    // Green is the colour in force, declared over the wild on top of the pile.
    const g = rigged(
      topWild,
      { p0: [wd2, green5], p1: d.filler(3), p2: d.filler(2) },
      { declaredColor: 'green' },
    )

    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })
    const events = g.do({ type: 'challenge', player: 'p1' })

    // p0 held a green, and green was the active colour. Guilty.
    expect(expectEvent(events, 'challenged').guilty).toBe(true)
  })

  it('only the challenger may challenge, and only while the window is open', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'wildDraw2'), ...d.filler(1)],
      p1: d.filler(3),
      p2: d.filler(2),
    })

    expect(g.reject({ type: 'challenge', player: 'p1' }).code).toBe('nothing_to_challenge')

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]!, declaredColor: 'red' })
    expect(g.reject({ type: 'challenge', player: 'p2' }).code).toBe('not_your_turn')
    expect(g.reject({ type: 'play', player: 'p1', card: g.hand('p1')[0]! }).code).toBe('wrong_phase')

    g.do({ type: 'challenge', player: 'p1' })
    expect(g.reject({ type: 'challenge', player: 'p1' }).code).toBe('nothing_to_challenge')
  })
})

describe('Wild Draw Color (dark)', () => {
  it('the victim draws until they get the chosen colour', () => {
    const d = new Deal()
    const top = d.face('dark', 'teal 2')
    const wdc = d.face('dark', 'wildDrawColor')

    const g = rigged(top, { p0: [wdc, ...d.filler(1)], p1: d.filler(2), p2: d.filler(2) }, { side: 'dark' })

    g.do({ type: 'play', player: 'p0', card: wdc, declaredColor: 'pink' })
    g.do({ type: 'acceptDraw', player: 'p1' })

    const hand = g.hand('p1')

    // The termination condition is the colour, not a count: they drew until a pink turned up, and
    // the pink is the last card in their hand.
    expect(hand.length).toBeGreaterThan(2)
    expect(faceOn(CARDS, hand[hand.length - 1]!, 'dark').color).toBe('pink')
    // …and nothing before it was pink, or they would have stopped sooner.
    for (const id of hand.slice(2, -1)) {
      expect(faceOn(CARDS, id, 'dark').color).not.toBe('pink')
    }

    expect(g.turnId).toBe('p2') // and they lost their turn
  })

  it('a successful challenge makes the accused draw to colour instead', () => {
    const d = new Deal()
    const top = d.face('dark', 'teal 2')
    const wdc = d.face('dark', 'wildDrawColor')
    const guiltyCard = d.face('dark', 'teal 9') // p0 held a teal

    const g = rigged(top, { p0: [wdc, guiltyCard], p1: d.filler(2), p2: d.filler(2) }, { side: 'dark' })

    g.do({ type: 'play', player: 'p0', card: wdc, declaredColor: 'pink' })
    const events = g.do({ type: 'challenge', player: 'p1' })

    expect(expectEvent(events, 'challenged').guilty).toBe(true)
    expect(g.hand('p0').length).toBeGreaterThan(1) // p0 drew to pink
    expect(g.hand('p1')).toHaveLength(2) // p1 drew nothing
    expect(g.turnId).toBe('p1') // and keeps their turn
  })

  // 🔴 D9 — "draws until they get a color of your choosing (however many it takes)" has no
  // termination guarantee in Mattel's text. If every card of that colour is already in someone's
  // hand, a literal reading loops forever.
  //
  // It terminates here for a structural reason: every draw moves a card permanently out of the
  // piles and into a hand, so the supply strictly shrinks. This test constructs the pathological
  // deck — every pink card hoarded in a hand that is not drawing — and proves the engine stops.
  it('terminates when the chosen colour is unreachable (D9)', () => {
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })

    // The pathological deck: every pink card in the game is hoarded in p2's hand, so p1 can never
    // draw one, however long they draw.
    const allPink = DECK.filter(c => c.dark.color === 'pink').map(c => c.id)
    const taken = new Set(allPink)
    const pick = (f: (c: (typeof DECK)[number]) => boolean): CardId => {
      const c = DECK.find(x => !taken.has(x.id) && f(x))
      if (!c) throw new Error('no card')
      taken.add(c.id)
      return c.id
    }

    const wdc = pick(c => c.dark.kind === 'wildDrawColor')
    const top = pick(c => c.dark.color === 'teal' && c.dark.kind === 'number')
    // p0 keeps a spare card, or playing the Wild Draw Color would empty their hand and end the
    // round — which is correct, but not what this test is measuring.
    const spare = pick(c => c.dark.kind === 'number')

    g.rig({
      hands: { p0: [wdc, spare], p1: [], p2: allPink },
      discard: [top],
      turn: 'p0',
      side: 'dark',
      direction: 1, // the deal may have opened on a Reverse; pin it
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })

    const inDrawPile = g.state.drawPile.length

    g.do({ type: 'play', player: 'p0', card: wdc, declaredColor: 'pink' })
    g.do({ type: 'acceptDraw', player: 'p1' })

    // p1 drew every card that could possibly be drawn — the whole draw pile, *plus* the card that
    // had been under the Wild Draw Color, which a reshuffle recycled back in underneath them — and
    // never found a pink. Then the engine **stopped**. A literal reading of Mattel's text ("draws
    // until they get a color of your choosing, however many it takes") loops here forever.
    expectEvent(g.events, 'reshuffled')
    expectEvent(g.events, 'pilesExhausted')
    expect(g.hand('p1')).toHaveLength(inDrawPile + 1)
    expect(g.state.drawPile).toHaveLength(0)
    expect(g.state.discardPile).toEqual([wdc]) // one card left: nothing to reshuffle
    expect(g.phase).toBe('awaitingPlay') // and the game carried on

    // The point of the test, stated plainly: p1 holds no pink card, and never will.
    for (const id of g.hand('p1')) {
      expect(faceOn(CARDS, id, 'dark').color).not.toBe('pink')
    }
  })

  it('the hard cap bounds the draw even when the colour is reachable (D9, belt-and-braces)', () => {
    const d = new Deal()
    const top = d.face('dark', 'teal 2')
    const wdc = d.face('dark', 'wildDrawColor')

    const g = rigged(
      top,
      { p0: [wdc, ...d.filler(1)], p1: d.filler(2), p2: d.filler(2) },
      { side: 'dark', options: { drawUntilColorCap: 3 } },
    )

    g.do({ type: 'play', player: 'p0', card: wdc, declaredColor: 'pink' })
    g.do({ type: 'acceptDraw', player: 'p1' })

    expect(g.hand('p1').length).toBeLessThanOrEqual(2 + 3)
  })
})

describe('challengesEnabled: false', () => {
  it('a wild-draw resolves immediately, with no window', () => {
    const d = new Deal()
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: [d.face('light', 'wildDraw2'), ...d.filler(1)], p1: d.filler(3), p2: d.filler(2) },
      { options: { challengesEnabled: false } },
    )

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]!, declaredColor: 'red' })

    expect(g.phase).toBe('awaitingPlay')
    expect(g.hand('p1')).toHaveLength(5)
    expect(g.turnId).toBe('p2')
  })
})

describe('enforceWildDrawColorRestriction: true (D7, the other way)', () => {
  it('hard-blocks the play when you hold the active colour', () => {
    const d = new Deal()
    const blue4 = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')
    const blue9 = d.face('light', 'blue 9')

    const g = rigged(
      blue4,
      { p0: [wd2, blue9], p1: d.filler(3) },
      { options: { enforceWildDrawColorRestriction: true } },
    )

    expect(g.reject({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' }).code).toBe(
      'illegal_play',
    )

    // Drop the blue and the same play becomes legal.
    g.rig({ hands: { p0: [wd2, d.face('light', 'red 9')], p1: g.hand('p1') } })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })
  })
})
