import { describe, expect, it } from 'vitest'
import { unoflipPack } from '../src/index.js'
import { Game, expectEvent, face, find, gameOpeningOn, number, pair } from './harness.js'

describe('round setup', () => {
  it('deals 7 cards each, turns up an opening card, and starts on the light side', () => {
    const g = new Game({ players: 4 })
    g.do({ type: 'startRound' })

    for (const p of g.state.players) expect(p.hand).toHaveLength(7)
    expect(g.state.discardPile).toHaveLength(1)
    expect(g.state.drawPile).toHaveLength(112 - 28 - 1)
    expect(g.side).toBe('light') // "The game always starts on the Light Side."
  })

  it('the same seed deals the same game; a different seed does not', () => {
    const deal = (seed: string): unknown => {
      const g = new Game({ seed })
      g.do({ type: 'startRound' })
      return { hands: g.state.players.map(p => p.hand), draw: g.state.drawPile, top: g.topId }
    }
    expect(deal('identical')).toEqual(deal('identical'))
    expect(deal('one')).not.toEqual(deal('two'))
  })

  it('assigns every card a fresh opaque alias each round', () => {
    const g = new Game()
    g.do({ type: 'startRound' })

    const first = { ...g.state.alias }
    expect(Object.keys(first)).toHaveLength(112)
    expect(new Set(Object.values(first)).size).toBe(112)

    // If the alias were positional (`c000` → `k000`), it would encode the card and be worthless.
    const positional = Object.entries(first).every(([id, key]) => id.slice(1) === key.slice(1))
    expect(positional).toBe(false)

    // A new round reshuffles the mapping, so nothing accumulates across a game.
    g.state.phase = { t: 'roundOver', winner: 'p1', points: 0 }
    g.do({ type: 'startRound' })
    expect(g.state.alias).not.toEqual(first)
  })

  it('refuses to start with fewer than two players', () => {
    expect(() => new Game({ players: 1 })).toThrow(/at least two/)
  })

  it('play begins to the dealer’s left, wherever the dealer is', () => {
    const g = gameOpeningOn(f => f.kind === 'number')
    expect(g.state.dealer).toBe(0)
    expect(g.turnId).toBe('p1')

    // Move the dealer and re-deal until the opening is inert again, so we are reading the seating
    // rule and not an action card.
    for (let i = 0; i < 200; i++) {
      const g2 = new Game({ players: 4, seed: `dealer-${i}` })
      g2.state.dealer = 2
      g2.do({ type: 'startRound' })
      if (face(g2.topId, 'light').kind === 'number') {
        expect(g2.turnId).toBe('p3')
        return
      }
    }
    throw new Error('no seed produced an inert opening card')
  })
})

// ---------------------------------------------------------------------------------------------
// The opening card. GDR44 gives a rule for every card except Flip — see D2.
// ---------------------------------------------------------------------------------------------

describe('the opening card', () => {
  it('a number card starts play with the player to the dealer’s left', () => {
    const g = gameOpeningOn(f => f.kind === 'number')
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1') // dealer is seat 0
    expect(g.state.direction).toBe(1)
  })

  it('Skip: the player to the dealer’s left is skipped', () => {
    const g = gameOpeningOn(f => f.kind === 'skip')
    expect(g.turnId).toBe('p2')
    expectEvent(g.events, 'skipped')
  })

  it('Draw One: the player to the dealer’s left draws one and misses their turn', () => {
    const g = gameOpeningOn(f => f.kind === 'draw1')
    expect(g.hand('p1')).toHaveLength(8)
    expect(g.turnId).toBe('p2')
  })

  // "REVERSE — the dealer goes first, and play then moves to the right."
  it('Reverse: the dealer goes first and play moves right', () => {
    const g = gameOpeningOn(f => f.kind === 'reverse')
    expect(g.state.direction).toBe(-1)
    expect(g.turnId).toBe('p0') // the dealer
    expectEvent(g.events, 'directionChanged')
  })

  it('Wild: the starting player names a colour before anyone plays', () => {
    const g = gameOpeningOn(f => f.kind === 'wild')

    expect(g.phase).toBe('awaitingColorChoice')
    const phase = g.state.phase as { t: 'awaitingColorChoice'; chooser: string; reason: string }
    expect(phase.reason).toBe('opening')
    expect(phase.chooser).toBe('p1')

    expect(g.reject({ type: 'chooseColor', player: 'p2', color: 'red' }).code).toBe('not_your_turn')
    expect(g.reject({ type: 'chooseColor', player: 'p1', color: 'pink' }).code).toBe('bad_color_for_side')
    expect(g.reject({ type: 'play', player: 'p1', card: g.hand('p1')[0]! }).code).toBe('wrong_phase')

    g.do({ type: 'chooseColor', player: 'p1', color: 'red' })
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1') // they chose, and now they play
    expect(g.state.declaredColor).toBe('red')
  })

  // D2. Mattel is silent on Flip-as-opening-card, and a naive engine either crashes or produces a
  // rule nobody can explain. We use Mattel's own pattern for Wild Draw Two: put it back, turn
  // another. 300 seeds is enough that a regression here shows up immediately.
  it('is never a Flip or a Wild Draw Two — both go back in the deck (D2)', () => {
    const FLIPS = new Set(['c028', 'c029', 'c054', 'c055', 'c080', 'c081', 'c106', 'c107'])
    const WD2 = new Set(['c000', 'c001', 'c002', 'c003'])

    for (let i = 0; i < 300; i++) {
      const g = new Game({ seed: `open-${i}` })
      g.do({ type: 'startRound' })

      expect(FLIPS.has(g.topId), `seed open-${i} opened on a Flip (${g.topId})`).toBe(false)
      expect(WD2.has(g.topId), `seed open-${i} opened on a Wild Draw Two (${g.topId})`).toBe(false)

      // And the rejected card was not dropped on the floor. (`Game.do` asserts conservation after
      // every action, so this is belt — but a lost card at setup is the worst kind of bug.)
      const total =
        g.state.drawPile.length +
        g.state.discardPile.length +
        g.state.players.reduce((n, p) => n + p.hand.length, 0)
      expect(total).toBe(112)
    }
  })
})

describe('openingPolicy, at the pack level', () => {
  const policy = (id: string, side: 'light' | 'dark' = 'light') =>
    unoflipPack.openingPolicy(face(id, side)).t

  it('accepts numbers and plain actions, redraws Flip and the wild-draws, asks for a colour on Wild', () => {
    expect(policy(number('light', 'blue', 4))).toBe('accept')
    expect(policy(find('light', 'blue skip'))).toBe('accept')
    expect(policy(find('light', 'blue reverse'))).toBe('accept')
    expect(policy(find('light', 'blue draw1'))).toBe('accept')

    expect(policy(find('light', 'wild'))).toBe('chooseColor')
    expect(policy(find('light', 'wildDraw2'))).toBe('redraw')
    expect(policy(find('light', 'blue flip'))).toBe('redraw')
  })

  it('answers for the dark side too — a pack must, even though a round never opens there', () => {
    expect(policy(find('dark', 'teal flip'), 'dark')).toBe('redraw')
    expect(policy(pair('green 6', 'wildDrawColor'), 'dark')).toBe('redraw')
    expect(policy(pair('blue reverse', 'wild'), 'dark')).toBe('chooseColor')
    expect(policy(find('dark', 'teal draw5'), 'dark')).toBe('accept')
    expect(policy(find('dark', 'purple skipEveryone'), 'dark')).toBe('accept')
  })
})
