import { describe, expect, it } from 'vitest'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, expectEvent, noEvent } from './harness.js'

function rigged(
  top: CardId,
  hands: Record<PlayerId, CardId[]>,
  opts: { players?: number; side?: 'light' | 'dark' } = {},
): Game {
  const g = new Game({ players: opts.players ?? 4 })
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

describe('Skip (light)', () => {
  it('the next player loses their turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue skip'), ...d.filler(1)],
      p1: d.filler(2),
      p2: d.filler(2),
      p3: d.filler(2),
    })

    const events = g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p2')
    expect(expectEvent(events, 'skipped').player).toBe('p1')
  })
})

describe('Draw One (light) / Draw Five (dark)', () => {
  it('Draw One: the next player draws one and misses their turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue draw1'), ...d.filler(1)],
      p1: d.filler(2),
      p2: d.filler(2),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.hand('p1')).toHaveLength(3)
    expect(g.turnId).toBe('p2')
  })

  it('Draw Five: the next player draws five and misses their turn', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'teal 2'),
      {
        p0: [d.face('dark', 'teal draw5'), ...d.filler(1)],
        p1: d.filler(2),
        p2: d.filler(2),
      },
      { side: 'dark' },
    )

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.hand('p1')).toHaveLength(7)
    expect(g.turnId).toBe('p2')
  })
})

describe('Reverse', () => {
  it('reverses the direction of play', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue reverse'), ...d.filler(1)],
      p1: d.filler(2),
      p2: d.filler(2),
      p3: d.filler(2),
    })

    const events = g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.state.direction).toBe(-1)
    expect(expectEvent(events, 'directionChanged').direction).toBe(-1)
    expect(g.turnId).toBe('p3') // play now moves the other way
  })

  it('reverses back', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue reverse'), ...d.filler(1)],
      p1: d.filler(2),
      p2: d.filler(2),
      p3: [d.face('light', 'red reverse'), ...d.filler(1)],
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p3')

    g.do({ type: 'play', player: 'p3', card: g.hand('p3')[0]! })
    expect(g.state.direction).toBe(1)
    expect(g.turnId).toBe('p0')
  })

  // D6. GDR44 has no two-player section at all — a literal reading makes Reverse a no-op, which is
  // nobody's expectation. Default: it acts as Skip.
  it('with two players it acts as a Skip (D6, default on)', () => {
    const d = new Deal()
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: [d.face('light', 'blue reverse'), ...d.filler(1)], p1: d.filler(2) },
      { players: 2 },
    )

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p0') // they go again
  })

  it('with the toggle off, two-player Reverse is a literal no-op (D6, off)', () => {
    const d = new Deal()
    const g = new Game({ players: 2, options: { twoPlayerReverseActsAsSkip: false } })
    g.do({ type: 'startRound' })
    g.rig({
      discard: [d.face('light', 'blue 4')],
      hands: { p0: [d.face('light', 'blue reverse'), ...d.filler(1)], p1: d.filler(2) },
      turn: 'p0',
      side: 'light',
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p1') // the turn just passes
  })
})

describe('Skip Everyone (dark)', () => {
  // "All players are skipped. Play returns to whoever played the card → they take another turn."
  it('returns the turn to the player who played it', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'purple 1'),
      {
        p0: [d.face('dark', 'purple skipEveryone'), ...d.filler(1)],
        p1: d.filler(2),
        p2: d.filler(2),
        p3: d.filler(2),
      },
      { side: 'dark' },
    )

    const events = g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(expectEvent(events, 'skippedEveryone').by).toBe('p0')
    expect(g.turnId).toBe('p0') // they go again
  })

  it('still returns to them when the direction is reversed', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'purple 1'),
      {
        p0: [d.face('dark', 'purple skipEveryone'), ...d.filler(1)],
        p1: d.filler(2),
        p2: d.filler(2),
        p3: d.filler(2),
      },
      { side: 'dark' },
    )
    g.rig({ direction: -1 })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p0')
  })

  // D14 — with two players it degenerates to a plain Skip, which is the right answer and needs no
  // special case: advancing by `playerCount` lands on you either way.
  it('with two players it degenerates to a Skip, which is the same thing (D14)', () => {
    const d = new Deal()
    const g = rigged(
      d.face('dark', 'purple 1'),
      { p0: [d.face('dark', 'purple skipEveryone'), ...d.filler(1)], p1: d.filler(2) },
      { players: 2, side: 'dark' },
    )

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })
    expect(g.turnId).toBe('p0')
  })
})

describe('Wild', () => {
  it('sets the colour and passes the turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'wild'), ...d.filler(1)],
      p1: d.filler(2),
    })

    const events = g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]!, declaredColor: 'red' })
    expect(expectEvent(events, 'colorChosen').color).toBe('red')
    expect(g.state.declaredColor).toBe('red')
    expect(g.turnId).toBe('p1')
    noEvent(events, 'cardsDrawn')
  })
})

describe('stacking is off by default', () => {
  // Confirmed NOT official — Mattel said so publicly in May 2019. A Draw One in the face means you
  // draw and lose your turn; you do not get to answer it with your own Draw One.
  it('the victim of a Draw One cannot answer with a Draw One — they never get the turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue draw1'), ...d.filler(1)],
      p1: [d.face('light', 'red draw1'), ...d.filler(1)],
      p2: d.filler(2),
    })

    g.do({ type: 'play', player: 'p0', card: g.hand('p0')[0]! })

    expect(g.state.options.stackingEnabled).toBe(false)
    expect(g.hand('p1')).toHaveLength(3) // they drew
    expect(g.turnId).toBe('p2') // and the turn skipped straight past them
    expect(g.reject({ type: 'play', player: 'p1', card: g.hand('p1')[0]! }).code).toBe('not_your_turn')
  })
})
