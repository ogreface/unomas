/**
 * The UNO call and the callout.
 *
 * D12: there is no "catching" in a digital game, so the window has to be defined explicitly.
 * Ours: it opens the moment a player is left holding one card, and it closes when some **other**
 * player acts. Keeping it open across the window-owner's own follow-up turns matters — a Skip
 * Everyone hands them an immediate second turn, and the physical game would still let you shout at
 * them in that gap.
 */

import { describe, expect, it } from 'vitest'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, expectEvent } from './harness.js'

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

describe('the UNO call', () => {
  it('may be called pre-emptively, holding two cards on your own turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
      p1: d.filler(3),
    })

    const events = g.do({ type: 'callUno', player: 'p0' })
    expect(expectEvent(events, 'unoCalled').player).toBe('p0')
    expect(g.state.players[0]!.saidUno).toBe(true)

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.state.unoWindow).toBe('p0') // the window opens anyway…
    expect(g.state.players[0]!.saidUno).toBe(true) // …but they are safe inside it
  })

  it('may be called reactively, inside your own open window — the self-rescue', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
      p1: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! }) // forgot to call
    expect(g.state.unoWindow).toBe('p0')
    expect(g.state.players[0]!.saidUno).toBe(false)

    g.do({ type: 'callUno', player: 'p0' }) // caught themselves in time
    expect(g.state.players[0]!.saidUno).toBe(true)

    const events = g.do({ type: 'callout', player: 'p1', target: 'p0' })
    expectEvent(events, 'calloutFailed')
    expect(g.hand('p0')).toHaveLength(1) // no penalty
  })

  it('cannot be called with a full hand', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(5), p1: d.filler(3) })
    expect(g.reject({ type: 'callUno', player: 'p0' }).code).toBe('uno_not_available')
  })

  it('cannot be called on someone else’s turn just because you hold two cards', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
    })
    expect(g.reject({ type: 'callUno', player: 'p1' }).code).toBe('uno_not_available')
  })
})

describe('the callout', () => {
  it('catches a player who did not call, and makes them draw two', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
      p1: d.filler(3),
      p2: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.hand('p0')).toHaveLength(1)

    const events = g.do({ type: 'callout', player: 'p2', target: 'p0' })
    const penalty = expectEvent(events, 'unoPenalty')

    expect(penalty.player).toBe('p0')
    expect(penalty.by).toBe('p2')
    expect(penalty.cards).toBe(2)
    expect(g.hand('p0')).toHaveLength(3)

    // The window is spent — otherwise every other player queues a callout on the same target.
    expect(g.state.unoWindow).toBeNull()
    expect(g.reject({ type: 'callout', player: 'p1', target: 'p0' }).code).toBe('callout_not_available')
  })

  it('drawing the penalty clears their UNO status', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
      p1: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    g.do({ type: 'callout', player: 'p1', target: 'p0' })
    expect(g.state.players[0]!.saidUno).toBe(false)
  })

  it('closes once another player acts (D12)', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
      p1: [d.face('light', 'blue 7'), ...d.filler(2)],
      p2: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.state.unoWindow).toBe('p0')

    g.do({ type: 'play', player: 'p1', card: g.hand('p1')[0]! }) // the next player takes their turn
    expect(g.state.unoWindow).toBeNull()

    // Too late.
    expect(g.reject({ type: 'callout', player: 'p2', target: 'p0' }).code).toBe('callout_not_available')
  })

  // The Skip Everyone gap. The window must survive the window-owner's own extra turn, or a player
  // could Skip Everyone down to one card and then immediately win, uncatchable.
  it('survives the caller’s own follow-up turn after a Skip Everyone', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'purple 1'),
      {
        p0: [d.face('dark', 'purple skipEveryone'), d.face('dark', 'purple 5'), d.face('dark', 'purple 6')],
        p1: d.filler(3),
        p2: d.filler(3),
      },
      { side: 'dark' },
    )

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p0') // play returned to them
    expect(g.hand('p0')).toHaveLength(2)

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! }) // down to one, no UNO call
    expect(g.state.unoWindow).toBe('p0')

    // p0 is about to win. p1 can still catch them.
    const events = g.do({ type: 'callout', player: 'p1', target: 'p0' })
    expectEvent(events, 'unoPenalty')
    expect(g.hand('p0')).toHaveLength(3)
  })

  it('cannot be used on a player who is not at UNO, or on yourself', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })

    expect(g.reject({ type: 'callout', player: 'p1', target: 'p0' }).code).toBe('callout_not_available')
    expect(g.reject({ type: 'callout', player: 'p0', target: 'p0' }).code).toBe('callout_not_available')
  })

  it('a false callout can be made to cost cards, if the house says so', () => {
    const d = new Deal()
    const g = rigged(
      d.face('light', 'blue 4'),
      {
        p0: [d.face('light', 'blue 5'), d.face('light', 'blue 6')],
        p1: d.filler(3),
      },
      { options: { falseCalloutPenaltyCards: 2 } },
    )

    g.do({ type: 'callUno', player: 'p0' })
    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })

    g.do({ type: 'callout', player: 'p1', target: 'p0' })
    expect(g.hand('p0')).toHaveLength(1) // safe
    expect(g.hand('p1')).toHaveLength(5) // and the accuser paid for it
  })

  // Two players, so the Draw Five actually lands on the person at UNO.
  it('a Draw Five in the face ends your UNO — the hand grew back, so nothing is left to call', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'teal 2'),
      {
        p0: [d.face('dark', 'teal 3'), d.face('dark', 'teal 4')],
        p1: [d.face('dark', 'teal draw5'), ...d.filler(2)],
      },
      { players: 2, side: 'dark' },
    )

    g.do({ type: 'callUno', player: 'p0' })
    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! }) // p0 down to one
    expect(g.state.unoWindow).toBe('p0')
    expect(g.state.players[0]!.saidUno).toBe(true)

    // p1 plays a Draw Five straight into p0's face.
    g.do({ type: 'play', player: 'p1', card: g.hand('p1')[0]! })

    expect(g.hand('p0')).toHaveLength(6)
    expect(g.state.players[0]!.saidUno).toBe(false) // you are not "at UNO" with six cards
    expect(g.state.unoWindow).toBeNull()
  })
})
