/**
 * The clock's half of the turn timeout: what a forfeited decision *does*.
 *
 * The clock itself belongs to the Durable Object (`apps/game/test/timeout.test.ts` covers the
 * alarm), because the engine is not allowed to know the time. Everything below is the rule: a
 * player who stops deciding loses exactly the turn, never more, and never to their advantage.
 */

import { describe, expect, it } from 'vitest'
import { playerToAct } from '../src/index.js'
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

describe('playerToAct — who the clock runs against', () => {
  it('names the player at the turn while a play is owed', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    expect(playerToAct(g.state)).toBe('p0')
  })

  it('names the chooser, not the turn, while a colour is owed', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    g.rig({ phase: { t: 'awaitingColorChoice', chooser: 'p1', reason: 'opening', resume: null } })
    expect(playerToAct(g.state)).toBe('p1')
  })

  it('names nobody in the lobby or between rounds — there is no turn to lose', () => {
    const g = new Game({ players: 2 })
    expect(playerToAct(g.state)).toBeNull()
    g.do({ type: 'startRound' })
    g.rig({ phase: { t: 'roundOver', winner: 'p0', points: 20 } })
    expect(playerToAct(g.state)).toBeNull()
    g.rig({ phase: { t: 'gameOver', winner: 'p0' } })
    expect(playerToAct(g.state)).toBeNull()
  })
})

describe('a forfeited turn', () => {
  it('draws one card and passes — even holding a card that would have played', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(2, { notColor: 'blue', notValue: 4 })],
      p1: d.filler(3, { notColor: 'blue', notValue: 4 }),
      p2: d.filler(3, { notColor: 'blue', notValue: 4 }),
      p3: d.filler(3, { notColor: 'blue', notValue: 4 }),
    })

    const events = g.do({ type: 'timeout', player: 'p0' })

    // The playable card is still in their hand: a timeout never plays for them.
    expect(g.hand('p0')).toContain(blue7)
    expect(g.hand('p0')).toHaveLength(4) // three, plus the one they were made to draw
    expect(expectEvent(events, 'timedOut').player).toBe('p0')
    expect(expectEvent(events, 'timedOut').phase).toBe('awaitingPlay')
    expect(expectEvent(events, 'cardsDrawn').count).toBe(1)
    expectEvent(events, 'passed')
    expect(g.turnId).toBe('p1')
    expect(g.phase).toBe('awaitingPlay')
  })

  it('does not stop on the drawn card: a playable draw is drawn, declined, and the turn moves on', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3, { notColor: 'blue', notValue: 4 }),
      p1: d.filler(3, { notColor: 'blue', notValue: 4 }),
    })
    // Next off the draw pile is a blue card, so a live player would have been offered the choice.
    const blue9 = d.face('light', 'blue 9')
    g.stackDraw(blue9)

    const events = g.do({ type: 'timeout', player: 'p0' })

    expect(g.hand('p0')).toContain(blue9)
    expectEvent(events, 'passed')
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
    // …and the card they declined is still theirs, not on the pile.
    expect(g.topId).not.toBe(blue9)
  })

  it('passes when the clock runs out on the drawn-card choice itself', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3, { notColor: 'blue', notValue: 4 }),
      p1: d.filler(3, { notColor: 'blue', notValue: 4 }),
    })
    const blue9 = d.face('light', 'blue 9')
    g.rig({ hands: { p0: [...g.hand('p0'), blue9], p1: g.hand('p1') } })
    g.rig({ phase: { t: 'awaitingDrawnCardChoice', card: blue9 } })

    const events = g.do({ type: 'timeout', player: 'p0' })

    expect(expectEvent(events, 'timedOut').phase).toBe('awaitingDrawnCardChoice')
    noEvent(events, 'cardsDrawn') // they already drew; the forfeit only declines the play
    expectEvent(events, 'passed')
    expect(g.turnId).toBe('p1')
  })

  it('picks the side’s first colour when a colour choice is owed, and play resumes', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    g.rig({ phase: { t: 'awaitingColorChoice', chooser: 'p0', reason: 'opening', resume: null } })

    const events = g.do({ type: 'timeout', player: 'p0' })

    expect(expectEvent(events, 'colorChosen').color).toBe('red') // LIGHT_COLORS[0]
    expect(g.state.declaredColor).toBe('red')
    expect(g.phase).toBe('awaitingPlay')
  })

  it('picks a dark colour on the dark side — never an off-side one', () => {
    const d = new Deal()
    const g = rigged(d.face('dark', 'teal 2'), { p0: d.filler(3), p1: d.filler(3) }, { side: 'dark' })
    g.rig({ phase: { t: 'awaitingColorChoice', chooser: 'p0', reason: 'opening', resume: null } })

    g.do({ type: 'timeout', player: 'p0' })

    expect(g.state.declaredColor).toBe('pink') // DARK_COLORS[0]
  })

  it('takes the cards rather than challenging — a challenge they did not ask for can cost them more', () => {
    const d = new Deal()
    const wd2 = d.face('light', 'wildDraw2')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [wd2, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })
    expect(g.phase).toBe('awaitingChallenge')
    expect(playerToAct(g.state)).toBe('p1')
    const before = g.hand('p1').length

    const events = g.do({ type: 'timeout', player: 'p1' })

    expect(expectEvent(events, 'timedOut').phase).toBe('awaitingChallenge')
    noEvent(events, 'challenged') // it never gambles on their behalf
    expectEvent(events, 'drawAccepted')
    expect(g.hand('p1')).toHaveLength(before + 2)
    expect(g.turnId).toBe('p2') // "…and loses their turn"
  })

  it('can end a round, when the forfeited draw hands the last card to a winner', () => {
    const d = new Deal()
    const wd2 = d.face('light', 'wildDraw2')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [wd2],
      p1: d.filler(2),
      p2: d.filler(2),
    })

    // p0 plays their last card; p1 owes the challenge decision and lets the clock take it.
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })
    const events = g.do({ type: 'timeout', player: 'p1' })

    expectEvent(events, 'roundEnded')
    expect(g.phase).toBe('roundOver')
    expect(g.score('p0')).toBeGreaterThan(0)
  })
})

describe('a timeout nobody owes', () => {
  it('is rejected for a player the game is not waiting on', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    expect(g.reject({ type: 'timeout', player: 'p1' }).code).toBe('not_your_turn')
  })

  it('is rejected between rounds, where the table waits on the host and not on a turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    g.rig({ phase: { t: 'roundOver', winner: 'p0', points: 20 } })
    expect(g.reject({ type: 'timeout', player: 'p0' }).code).toBe('wrong_phase')
  })

  it('is rejected once the game is over', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    g.rig({ phase: { t: 'gameOver', winner: 'p0' } })
    expect(g.reject({ type: 'timeout', player: 'p0' }).code).toBe('wrong_phase')
  })
})

describe('the clock and the UNO window', () => {
  it('a player left on one card keeps their callout window open through their own timeout', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(1, { notColor: 'blue', notValue: 4 })],
      p1: d.filler(3),
      p2: d.filler(3),
    })

    g.do({ type: 'play', player: 'p0', card: blue7 })
    expect(g.state.unoWindow).toBe('p0')

    // p1 lets the clock take their turn. That is still somebody else acting, so the window closes —
    // the same as any other action by another player (D12).
    g.do({ type: 'timeout', player: 'p1' })
    expect(g.state.unoWindow).toBeNull()
  })
})
