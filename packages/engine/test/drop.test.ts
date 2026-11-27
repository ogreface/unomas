/**
 * Leaving the table (D18): what dropping a player *does* to a game in progress.
 *
 * *When* somebody is dropped is the Durable Object's business — it owns the sockets and the clock,
 * and `apps/game/test/presence.test.ts` covers that half. Everything below is the rule: the seat
 * goes quiet, the cards go back in the deck, whatever the table was waiting on them for is settled
 * so play can carry on, and the last player still sitting there wins.
 */

import { describe, expect, it } from 'vitest'
import { decideBot, playerToAct, seedRng, tableView, viewFor } from '../src/index.js'
import type { Action, BotIntent, CardId, GameState, PlayerId } from '../src/index.js'
import { cardIdForKey } from '../src/index.js'
import { Deal, Game, expectEvent, noEvent, player } from './harness.js'

function rigged(
  top: CardId | CardId[],
  hands: Record<PlayerId, CardId[]>,
  opts: { players?: number; side?: 'light' | 'dark' } = {},
): Game {
  const g = new Game({ players: opts.players ?? 4 })
  g.do({ type: 'startRound' })
  g.rig({
    discard: Array.isArray(top) ? top : [top],
    hands,
    turn: 'p0',
    side: opts.side ?? 'light',
    direction: 1,
    declaredColor: null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

const drop = (player: PlayerId): Action => ({ type: 'drop', player, reason: 'disconnected' })

describe('dropping a player', () => {
  it('takes them out of the game and shuffles their hand back into the draw pile', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: d.filler(4),
      p2: d.filler(3),
      p3: d.filler(3),
    })
    const held = g.hand('p1').slice()
    const pileBefore = g.state.drawPile.length

    const events = g.do(drop('p1'))

    expect(expectEvent(events, 'playerDropped')).toMatchObject({
      player: 'p1',
      reason: 'disconnected',
      cards: 4,
    })
    expect(player(g.state, 'p1').dropped).toBe('disconnected')
    expect(g.hand('p1')).toEqual([])
    expect(g.state.drawPile).toHaveLength(pileBefore + 4)
    for (const id of held) expect(g.state.drawPile).toContain(id)
    // Shuffled in, not stacked on top: the table has seen the backs of those four cards, so the
    // next four draws must not simply be them.
    expect(g.state.drawPile.slice(-4).sort()).not.toEqual(held.slice().sort())

    // It was not their turn, so nothing else about the round moves.
    expect(g.turnId).toBe('p0')
    expect(g.phase).toBe('awaitingPlay')
    noEvent(events, 'turnChanged')
  })

  it('play passes over the empty seat', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })

    g.do(drop('p1'))
    g.do({ type: 'play', player: 'p0', card: blue7 })

    expect(g.turnId).toBe('p2')
  })

  it('…in whichever direction play is moving', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })
    g.rig({ direction: -1 })

    g.do(drop('p3'))
    g.do({ type: 'play', player: 'p0', card: blue7 })

    expect(g.turnId).toBe('p2')
  })

  it('hands the turn on when the player who left was the one holding it', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: d.filler(3),
      p2: d.filler(3),
    })

    const events = g.do(drop('p0'))

    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
    expect(playerToAct(g.state)).toBe('p1')
    expect(expectEvent(events, 'turnChanged').player).toBe('p1')
    // Nothing is drawn on their way out: the cards are going back in the deck anyway.
    noEvent(events, 'cardsDrawn')
  })

  it('…even halfway through deciding what to do with a card they drew', () => {
    const d = new Deal()
    const blue9 = d.face('light', 'blue 9')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue9, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
    })
    g.rig({ phase: { t: 'awaitingDrawnCardChoice', card: blue9 } })

    g.do(drop('p0'))

    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
    expect(g.state.drawPile).toContain(blue9)
  })

  it('ends the game when only one player is left, and that player wins it', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) }, { players: 2 })

    const events = g.do(drop('p0'))

    expect(g.state.phase).toEqual({ t: 'gameOver', winner: 'p1' })
    expect(expectEvent(events, 'gameEnded').winner).toBe('p1')
    // Nobody went out, so no round was won and no points change hands.
    noEvent(events, 'roundEnded')
    expect(g.score('p1')).toBe(0)
    expect(playerToAct(g.state)).toBeNull()
  })

  it('keeps going while two are left, and ends when the second of three leaves', () => {
    const d = new Deal()
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) },
      { players: 3 },
    )

    g.do(drop('p1'))
    expect(g.phase).toBe('awaitingPlay')

    g.do(drop('p0'))
    expect(g.state.phase).toEqual({ t: 'gameOver', winner: 'p2' })
  })

  it('closes their own UNO window on the way out', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(1)],
      p1: d.filler(3),
      p2: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: blue7 })
    expect(g.state.unoWindow).toBe('p0')

    g.do(drop('p0'))

    expect(g.state.unoWindow).toBeNull()
  })

  it('does not close somebody else’s UNO window — nobody began a turn', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [blue7, ...d.filler(1)],
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: blue7 })

    g.do(drop('p3'))

    expect(g.state.unoWindow).toBe('p0')
    g.do({ type: 'callout', player: 'p1', target: 'p0' })
    expect(g.hand('p0')).toHaveLength(3)
  })
})

describe('a drop the game cannot act on', () => {
  it('is rejected for a player who has already left', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) })
    g.do(drop('p1'))
    expect(g.reject(drop('p1')).code).toBe('not_in_game')
  })

  it('is rejected before the first deal and after the last', () => {
    const lobby = new Game({ players: 2 })
    expect(lobby.reject(drop('p0')).code).toBe('wrong_phase')

    const d = new Deal()
    const over = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) })
    over.rig({ phase: { t: 'gameOver', winner: 'p0' } })
    expect(over.reject(drop('p1')).code).toBe('game_over')
  })

  it('and a player who has left can no longer do anything at all', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: [blue7, ...d.filler(1)],
      p2: d.filler(3),
    })
    g.do({ type: 'draw', player: 'p0' })
    if (g.phase === 'awaitingDrawnCardChoice') g.do({ type: 'pass', player: 'p0' })
    g.do({ type: 'play', player: 'p1', card: blue7 }) // p1 is now one card down, window open
    g.do(drop('p0'))

    expect(g.reject({ type: 'callout', player: 'p0', target: 'p1' }).code).toBe('not_in_game')
    expect(g.reject({ type: 'draw', player: 'p0' }).code).toBe('not_in_game')
    expect(g.reject({ type: 'callUno', player: 'p0' }).code).toBe('not_in_game')
    expect(g.reject({ type: 'timeout', player: 'p0' }).code).toBe('not_in_game')
  })
})

describe('the cards still count the players who are left', () => {
  it('three become two: a Reverse now acts as a Skip (D6)', () => {
    const d = new Deal()
    const reverse = d.face('light', 'blue reverse')
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: [reverse, ...d.filler(2)], p1: d.filler(3), p2: d.filler(3) },
      { players: 3 },
    )

    g.do(drop('p2'))
    g.do({ type: 'play', player: 'p0', card: reverse })

    expect(g.turnId).toBe('p0')
  })

  it('Skip Everyone still comes back to whoever played it', () => {
    const d = new Deal()
    const skipAll = d.face('dark', 'purple skipEveryone')
    const g = rigged(
      d.face('dark', 'purple 1'),
      { p0: [skipAll, ...d.filler(2)], p1: d.filler(3), p2: d.filler(3), p3: d.filler(3) },
      { side: 'dark' },
    )

    g.do(drop('p2'))
    g.do({ type: 'play', player: 'p0', card: skipAll })

    expect(g.turnId).toBe('p0')
  })

  it('a Draw One lands on the next player still sitting there', () => {
    const d = new Deal()
    const draw1 = d.face('light', 'blue draw1')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [draw1, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })

    g.do(drop('p1'))
    const events = g.do({ type: 'play', player: 'p0', card: draw1 })

    expect(expectEvent(events, 'cardsDrawn').player).toBe('p2')
    expect(g.hand('p2')).toHaveLength(4)
    expect(g.hand('p1')).toEqual([])
    expect(g.turnId).toBe('p3') // …and p2 is the one who loses the turn
  })

  it('a round won afterwards scores nothing for the empty seat', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const red5 = d.face('light', 'red 5')
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: [blue7], p1: d.filler(6), p2: [red5] },
      { players: 3 },
    )

    g.do(drop('p1'))
    const events = g.do({ type: 'play', player: 'p0', card: blue7 })

    expect(expectEvent(events, 'roundEnded').points).toBe(5) // p2's red 5, and nothing of p1's
  })
})

describe('when the game was waiting on the player who left', () => {
  it('names a colour for them at the opening, and the turn moves on', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) })
    g.rig({ phase: { t: 'awaitingColorChoice', chooser: 'p0', reason: 'opening', resume: null } })

    const events = g.do(drop('p0'))

    expect(expectEvent(events, 'colorChosen')).toMatchObject({ player: 'p0', color: 'red' })
    expect(g.state.declaredColor).toBe('red')
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
  })

  it('names a colour for a Flip they played, and resumes the turn they had suspended (D3)', () => {
    // c031 is `blue reverse / wild`: at the bottom of the pile, it is what a Flip turns up.
    const d = new Deal()
    const exposed = d.card('c031')
    const flip = d.face('light', 'blue flip')
    const g = rigged([exposed, d.face('light', 'blue 5')], {
      p0: [flip, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: flip })
    expect(g.phase).toBe('awaitingColorChoice')

    const events = g.do(drop('p0'))

    expect(expectEvent(events, 'colorChosen').color).toBe('pink') // DARK_COLORS[0]
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
    expect(player(g.state, 'p0').dropped).toBe('disconnected')
  })

  it('the target of a wild draw leaves: nobody draws, the play stands, and the turn passes them by', () => {
    const d = new Deal()
    const wd2 = d.face('light', 'wildDraw2')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [wd2, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })
    expect(playerToAct(g.state)).toBe('p1')

    const events = g.do(drop('p1'))

    noEvent(events, 'cardsDrawn')
    noEvent(events, 'challenged')
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p2')
    expect(g.state.declaredColor).toBe('red')
  })

  it('…and if that wild draw was the accused’s last card, they have won the round', () => {
    const d = new Deal()
    const wd2 = d.face('light', 'wildDraw2')
    const red5 = d.face('light', 'red 5')
    const g = rigged(d.face('light', 'blue 4'), { p0: [wd2], p1: d.filler(3), p2: [red5] })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do(drop('p1'))

    expect(expectEvent(events, 'roundEnded')).toMatchObject({ winner: 'p0', points: 5 })
    expect(g.phase).toBe('roundOver')
  })

  it('the player who played a wild draw leaves: the draw is void, and its target simply plays on', () => {
    const d = new Deal()
    const wd2 = d.face('light', 'wildDraw2')
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [wd2, ...d.filler(2)],
      p1: d.filler(3),
      p2: d.filler(3),
    })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do(drop('p0'))

    // There is no hand left to show a challenger, so the fair reading is that there is nothing
    // left to challenge: p1 neither draws nor loses the turn.
    expect(expectEvent(events, 'challengeVoided').challenger).toBe('p1')
    noEvent(events, 'cardsDrawn')
    expect(g.hand('p1')).toHaveLength(3)
    expect(g.phase).toBe('awaitingPlay')
    expect(g.turnId).toBe('p1')
    expect(g.state.declaredColor).toBe('red') // the wild is still on the pile, and still red
  })
})

describe('between rounds', () => {
  it('the next deal leaves the empty seat out', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })
    g.rig({ phase: { t: 'roundOver', winner: 'p0', points: 20 } })

    g.do(drop('p1'))
    expect(g.phase).toBe('roundOver')
    g.do({ type: 'startRound' })

    expect(g.hand('p1')).toEqual([])
    for (const id of ['p0', 'p2', 'p3']) expect(g.hand(id).length).toBeGreaterThanOrEqual(7)
    expect(playerToAct(g.state)).not.toBe('p1')
  })

  it('the deal does not go to a dealer who has left — it moves to the next seat', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: d.filler(3),
      p1: d.filler(3),
      p2: d.filler(3),
      p3: d.filler(3),
    })
    g.rig({ phase: { t: 'roundOver', winner: 'p0', points: 20 } })
    g.state.dealer = 1

    g.do(drop('p1'))
    const events = g.do({ type: 'startRound' })

    expect(expectEvent(events, 'roundStarted').dealer).toBe('p2')
    expect(g.state.dealer).toBe(2)
  })

  it('the deal rotates past an empty seat when a round ends', () => {
    const d = new Deal()
    const blue7 = d.face('light', 'blue 7')
    const g = rigged(
      d.face('light', 'blue 4'),
      { p0: [blue7], p1: d.filler(3), p2: d.filler(3) },
      { players: 3 },
    )
    g.state.dealer = 0

    g.do(drop('p1'))
    g.do({ type: 'play', player: 'p0', card: blue7 })

    expect(g.phase).toBe('roundOver')
    expect(g.state.dealer).toBe(2)
  })

  it('ends the game there and then if the drop leaves one player', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3) }, { players: 2 })
    g.rig({ phase: { t: 'roundOver', winner: 'p0', points: 20 } })

    g.do(drop('p0'))

    expect(g.state.phase).toEqual({ t: 'gameOver', winner: 'p1' })
  })
})

describe('three strikes — the clock drops a player who keeps running it out', () => {
  /** Run the clock out on p0, and then put the turn back in their hands for the next one. */
  function strike(g: Game) {
    const events = g.do({ type: 'timeout', player: 'p0' })
    if (g.phase !== 'gameOver' && !player(g.state, 'p0').dropped) {
      g.rig({ turn: 'p0', phase: { t: 'awaitingPlay' } })
    }
    return events
  }

  function table(options: ConstructorParameters<typeof Game>[0] = {}): Game {
    const d = new Deal()
    const g = new Game({ players: 3, ...options })
    g.do({ type: 'startRound' })
    g.rig({
      discard: [d.face('light', 'blue 4')],
      hands: { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) },
      turn: 'p0',
      side: 'light',
      direction: 1,
      declaredColor: null,
      phase: { t: 'awaitingPlay' },
    })
    return g
  }

  it('says which strike each timeout is, and how many the room allows', () => {
    const g = table()

    expect(expectEvent(strike(g), 'timedOut')).toMatchObject({ strikes: 1, limit: 3 })
    expect(expectEvent(strike(g), 'timedOut')).toMatchObject({ strikes: 2, limit: 3 })
    expect(player(g.state, 'p0').dropped).toBeNull()
  })

  it('drops them on the third in a row, instead of forfeiting a third turn', () => {
    const g = table()
    strike(g)
    strike(g)
    const handBefore = g.hand('p0').length

    const events = strike(g)

    expect(expectEvent(events, 'timedOut')).toMatchObject({ player: 'p0', strikes: 3 })
    expect(expectEvent(events, 'playerDropped')).toMatchObject({
      player: 'p0',
      reason: 'timeouts',
      cards: handBefore,
    })
    // The third strike is the drop itself — there is no point drawing a card for an empty chair.
    noEvent(events, 'cardsDrawn')
    noEvent(events, 'passed')
    expect(player(g.state, 'p0').dropped).toBe('timeouts')
    expect(g.turnId).toBe('p1')
    expect(g.phase).toBe('awaitingPlay')
  })

  it('counts only timeouts in a row: anything the player does themselves wipes the slate', () => {
    const g = table()
    strike(g)
    strike(g)

    // They are back. One move of their own is all the proof of life the count needs.
    g.do({ type: 'draw', player: 'p0' })
    if (g.phase === 'awaitingDrawnCardChoice') g.do({ type: 'pass', player: 'p0' })
    g.rig({ turn: 'p0', phase: { t: 'awaitingPlay' } })

    expect(expectEvent(strike(g), 'timedOut').strikes).toBe(1)
    expect(player(g.state, 'p0').dropped).toBeNull()
  })

  it('a rejected action is not proof of life', () => {
    const g = table()
    strike(g)
    g.rig({ turn: 'p1', phase: { t: 'awaitingPlay' } })
    g.reject({ type: 'draw', player: 'p0' }) // not their turn
    g.rig({ turn: 'p0', phase: { t: 'awaitingPlay' } })

    expect(expectEvent(strike(g), 'timedOut').strikes).toBe(2)
  })

  it('never drops anyone when dropAfterTimeouts is 0', () => {
    const g = table({ options: { dropAfterTimeouts: 0 } })

    for (let i = 1; i <= 5; i++) {
      expect(expectEvent(strike(g), 'timedOut')).toMatchObject({ strikes: i, limit: 0 })
    }
    expect(player(g.state, 'p0').dropped).toBeNull()
  })

  it('drops the last opponent standing and hands the other the game', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    g.rig({
      discard: [d.face('light', 'blue 4')],
      hands: { p0: d.filler(3), p1: d.filler(3) },
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    strike(g)
    strike(g)

    const events = strike(g)

    expectEvent(events, 'playerDropped')
    expect(g.state.phase).toEqual({ t: 'gameOver', winner: 'p1' })
  })

  it('still counts for a game saved before strikes existed', () => {
    const g = table()
    // A snapshot written by an older build has none of the new fields; it must not turn the count
    // into NaN and quietly never drop anyone.
    const old = JSON.parse(JSON.stringify(g.state)) as GameState
    for (const p of old.players) {
      delete (p as Partial<typeof p>).timeouts
      delete (p as Partial<typeof p>).dropped
    }
    delete (old.options as Partial<typeof old.options>).dropAfterTimeouts
    g.state = old

    strike(g)
    strike(g)
    const events = strike(g)

    expect(expectEvent(events, 'playerDropped').reason).toBe('timeouts')
  })
})

describe('what everyone else is shown', () => {
  it('marks the empty seat in every player’s view, and on the projected table', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) })
    expect(viewFor(g.state, 'p0').players.map(p => p.dropped)).toEqual([null, null, null, null])

    g.do(drop('p1'))

    const seen = viewFor(g.state, 'p0').players.find(p => p.id === 'p1')
    expect(seen).toMatchObject({ dropped: 'disconnected', handCount: 0, visible: [] })
    expect(tableView(g.state).players.find(p => p.id === 'p1')?.dropped).toBe('disconnected')
  })

  it('still gives the player who left a view of their own — an empty hand, and nothing to play', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: d.filler(3) })
    g.do(drop('p0'))

    const view = viewFor(g.state, 'p0')

    expect(view.hand).toEqual([])
    expect(view.legalPlays).toEqual([])
    expect(view.players.find(p => p.id === 'p0')?.dropped).toBe('disconnected')
  })
})

describe('a table that loses players still plays to a finish', () => {
  /** Turn a bot intent into an engine action, exactly as the Durable Object does. */
  function toAction(state: GameState, id: PlayerId, intent: BotIntent): Action {
    switch (intent.t) {
      case 'play': {
        const card = cardIdForKey(state, intent.key)
        if (!card) throw new Error(`bot named an unknown card key "${intent.key}"`)
        return { type: 'play', player: id, card, declaredColor: intent.declaredColor }
      }
      case 'callout':
        return { type: 'callout', player: id, target: intent.target }
      case 'chooseColor':
        return { type: 'chooseColor', player: id, color: intent.color }
      default:
        return { type: intent.t, player: id }
    }
  }

  /** Who walks out, given the state of the game — or null if this is not the moment. */
  type Leaver = (state: GameState) => PlayerId | null

  const inPlay = (state: GameState): PlayerId[] => state.players.filter(p => !p.dropped).map(p => p.id)

  const leavers: Record<string, Leaver> = {
    'the player whose turn it is': s => (s.phase.t === 'awaitingPlay' ? playerToAct(s) : null),
    'a bystander': s =>
      s.phase.t === 'awaitingPlay' ? (inPlay(s).find(id => id !== playerToAct(s)) ?? null) : null,
    'a player deciding on a drawn card': s =>
      s.phase.t === 'awaitingDrawnCardChoice' ? playerToAct(s) : null,
    'the target of a wild draw': s => (s.phase.t === 'awaitingChallenge' ? s.phase.challenger : null),
    'the player who played a wild draw': s =>
      s.phase.t === 'awaitingChallenge' ? s.phase.accused : null,
    'a player who owes a colour': s => (s.phase.t === 'awaitingColorChoice' ? s.phase.chooser : null),
    'the next dealer, between rounds': s =>
      s.phase.t === 'roundOver' ? (s.players[s.dealer]?.id ?? null) : null,
  }

  // Five sit down and two walk out, each at a different kind of moment. `Game.do` checks every
  // invariant after every action, which is the real assertion here: all 112 cards accounted for,
  // no cards in an empty seat, and the game never left waiting on somebody who has gone.
  const scenarios: Array<[seed: string, first: string, second: string]> = [
    ['leavers-a', 'the player whose turn it is', 'a bystander'],
    ['leavers-b', 'the target of a wild draw', 'the player who played a wild draw'],
    ['leavers-c', 'the next dealer, between rounds', 'a player deciding on a drawn card'],
    ['leavers-d', 'the player who played a wild draw', 'the next dealer, between rounds'],
    ['leavers-e', 'a player who owes a colour', 'the target of a wild draw'],
  ]

  for (const [seed, first, second] of scenarios) {
    it(`five players, then ${first} leaves, then ${second}: three finish the game`, () => {
      const g = new Game({ players: 5, seed })
      let rng = seedRng(`drive-${seed}`)
      const pending = [first, second]
      // Not on the very first move of the game, and not back to back: let some play happen.
      let quietUntil = 12

      for (let step = 0; step < 40_000 && g.phase !== 'gameOver'; step++) {
        const leaver = step >= quietUntil && pending[0] ? leavers[pending[0]]!(g.state) : null
        if (leaver) {
          g.do(drop(leaver))
          pending.shift()
          quietUntil = step + 12
          continue
        }
        if (g.phase === 'lobby' || g.phase === 'roundOver') {
          g.do({ type: 'startRound' })
          continue
        }
        const actor = playerToAct(g.state)
        if (!actor) throw new Error(`no one owes an action in phase "${g.phase}"`)
        const decision = decideBot(viewFor(g.state, actor), rng, 'normal')
        rng = decision.rng
        if (!decision.intent) throw new Error(`bot ${actor} owed an action and had none`)
        g.do(toAction(g.state, actor, decision.intent))
      }

      expect(pending, 'the game ended before both players had left').toEqual([])
      expect(g.phase).toBe('gameOver')
      expect(g.state.players.filter(p => p.dropped)).toHaveLength(2)
    })
  }
})
