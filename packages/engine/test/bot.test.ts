/**
 * The computer player.
 *
 * The load-bearing test here is the last one: a table of four bots plays whole games to completion
 * with the reducer's invariants checked after every action. It is the cheapest possible proof that
 * the bot never gets stuck, never proposes an illegal action, and — because `assertStateInvariants`
 * runs each time — that nothing it does breaks card conservation.
 */

import { describe, expect, it } from 'vitest'
import { decideBot, seedRng, viewFor } from '../src/index.js'
import type { Action, BotDifficulty, BotIntent, GameState, PlayerId, RngState } from '../src/index.js'
import { cardIdForKey } from '../src/index.js'
import { Deal, Game } from './harness.js'

const RNG = seedRng('bot-test')

/** Turn a bot intent into an engine action, exactly as the Durable Object does. */
function toAction(state: GameState, player: PlayerId, intent: BotIntent): Action {
  switch (intent.t) {
    case 'play': {
      const card = cardIdForKey(state, intent.key)
      if (!card) throw new Error(`bot named an unknown card key "${intent.key}"`)
      return { type: 'play', player, card, declaredColor: intent.declaredColor }
    }
    case 'draw':
      return { type: 'draw', player }
    case 'pass':
      return { type: 'pass', player }
    case 'chooseColor':
      return { type: 'chooseColor', player, color: intent.color }
    case 'challenge':
      return { type: 'challenge', player }
    case 'acceptDraw':
      return { type: 'acceptDraw', player }
    case 'callUno':
      return { type: 'callUno', player }
    case 'callout':
      return { type: 'callout', player, target: intent.target }
  }
}

/** Ask one seat what it wants to do, from nothing but its own redacted view. */
function ask(
  state: GameState,
  player: PlayerId,
  difficulty: BotDifficulty = 'normal',
  rng: RngState = RNG,
): BotIntent | null {
  return decideBot(viewFor(state, player), rng, difficulty).intent
}

describe('decideBot — whose decision is it', () => {
  it('says nothing on a seat that owes nothing', () => {
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    const idle = g.state.players.find(p => p.id !== g.turnId)!
    expect(ask(g.state, idle.id)).toBeNull()
  })

  it('plays or draws when it is its turn', () => {
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    const intent = ask(g.state, g.turnId)
    expect(intent).not.toBeNull()
    expect(['play', 'draw', 'callUno']).toContain(intent!.t)
  })

  it('draws when it holds nothing legal', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    // A hand of blue numbers against a red 5 top: nothing matches by colour or by value.
    g.rig({
      hands: {
        p0: [d.face('light', 'blue 1'), d.face('light', 'blue 2'), d.face('light', 'blue 3')],
        p1: d.filler(3),
      },
      discard: [d.face('light', 'red 5')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    expect(ask(g.state, 'p0')).toEqual({ t: 'draw' })
  })

  it('passes on a drawn card it cannot play', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    const drawn = d.face('light', 'blue 1')
    g.rig({
      hands: { p0: [drawn, d.face('light', 'blue 2')], p1: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p0',
      phase: { t: 'awaitingDrawnCardChoice', card: drawn },
      declaredColor: null,
    })
    expect(ask(g.state, 'p0')).toEqual({ t: 'pass' })
  })
})

describe('decideBot — it plays only what it is allowed to see', () => {
  it('never names a card that is not in its own hand', () => {
    const g = new Game({ players: 4 })
    g.do({ type: 'startRound' })
    for (let i = 0; i < 200; i++) {
      const actor = owes(g.state)
      if (!actor) break
      const intent = decideBot(viewFor(g.state, actor), g.state.rng, 'normal').intent
      if (intent?.t === 'play') {
        const id = cardIdForKey(g.state, intent.key)
        expect(g.hand(actor)).toContain(id)
      }
      if (!intent) break
      g.do(toAction(g.state, actor, intent))
      if (g.phase === 'roundOver' || g.phase === 'gameOver') break
    }
  })
})

describe('decideBot — UNO discipline', () => {
  it('declares UNO before playing its second-to-last card', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [d.face('light', 'red 1'), d.face('light', 'red 2')], p1: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    expect(ask(g.state, 'p0')).toEqual({ t: 'callUno' })

    // Having said it, it gets on with the game rather than saying it again.
    g.do({ type: 'callUno', player: 'p0' })
    expect(ask(g.state, 'p0')?.t).toBe('play')
  })

  it('rescues its own forgotten UNO while the window is still open', () => {
    const d = new Deal()
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [d.face('light', 'red 1')], p1: d.filler(3), p2: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p1',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    g.state.unoWindow = 'p0'
    expect(ask(g.state, 'p0')).toEqual({ t: 'callUno' })
  })

  it('catches an opponent who is one card down and silent', () => {
    const d = new Deal()
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: d.filler(3), p1: [d.face('light', 'red 1')], p2: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p2',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    g.state.unoWindow = 'p1'
    expect(ask(g.state, 'p0')).toEqual({ t: 'callout', target: 'p1' })
  })

  it('does not call out a player who did say UNO', () => {
    const d = new Deal()
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: d.filler(3), p1: [d.face('light', 'red 1')], p2: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p2',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    g.state.unoWindow = 'p1'
    g.state.players[1]!.saidUno = true
    expect(ask(g.state, 'p0')).toBeNull()
  })

  it('an easy bot never calls anyone out', () => {
    const d = new Deal()
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: d.filler(3), p1: [d.face('light', 'red 1')], p2: d.filler(3) },
      discard: [d.face('light', 'red 5')],
      turn: 'p2',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    g.state.unoWindow = 'p1'
    // Across many RNG states an easy bot's vigilance never fires.
    let rng = seedRng('vigilance')
    for (let i = 0; i < 50; i++) {
      const decision = decideBot(viewFor(g.state, 'p0'), rng, 'easy')
      expect(decision.intent).toBeNull()
      rng = decision.rng
    }
  })
})

describe('decideBot — choosing a colour', () => {
  it('declares the colour it holds most of', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    const wild = d.face('light', 'wild')
    g.rig({
      hands: {
        p0: [
          wild,
          d.face('light', 'green 1'),
          d.face('light', 'green 2'),
          d.face('light', 'green 3'),
          d.face('light', 'red 4'),
        ],
        p1: d.filler(3),
      },
      discard: [d.face('light', 'blue 5')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    expect(intent?.t).toBe('play')
    if (intent?.t !== 'play') throw new Error('unreachable')
    // Whatever it chose to play, if it played the wild it named green.
    if (cardIdForKey(g.state, intent.key) === wild) expect(intent.declaredColor).toBe('green')
  })

  it('answers an awaitingColorChoice with a legal colour for the side', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: [d.face('light', 'red 1')], p1: d.filler(3) },
      discard: [d.face('light', 'blue 5')],
      turn: 'p0',
      phase: { t: 'awaitingColorChoice', chooser: 'p0', reason: 'opening', resume: null },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    expect(intent?.t).toBe('chooseColor')
    if (intent?.t !== 'chooseColor') throw new Error('unreachable')
    expect(['red', 'yellow', 'green', 'blue']).toContain(intent.color)
  })
})

describe('decideBot — challenges', () => {
  const rigChallenge = (kind: 'wildDraw2' | 'wildDrawColor', priorColor: 'red' | null) => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    g.rig({
      hands: { p0: d.filler(4), p1: d.filler(4) },
      discard: [d.face('light', 'wildDraw2')],
      turn: 'p0',
      declaredColor: 'green',
      phase: {
        t: 'awaitingChallenge',
        challenger: 'p0',
        accused: 'p1',
        kind,
        color: 'green',
        priorColor,
        resume: { actor: 1, extraSkips: 0, forcedTurn: null },
      },
    })
    return g
  }

  it('takes the cards rather than challenging when no colour was live to match', () => {
    const g = rigChallenge('wildDraw2', null)
    let rng = seedRng('challenge-none')
    for (let i = 0; i < 30; i++) {
      const decision = decideBot(viewFor(g.state, 'p0'), rng, 'normal')
      expect(decision.intent).toEqual({ t: 'acceptDraw' })
      rng = decision.rng
    }
  })

  it('an easy bot always just takes the cards', () => {
    const g = rigChallenge('wildDrawColor', 'red')
    let rng = seedRng('challenge-easy')
    for (let i = 0; i < 30; i++) {
      const decision = decideBot(viewFor(g.state, 'p0'), rng, 'easy')
      expect(decision.intent).toEqual({ t: 'acceptDraw' })
      rng = decision.rng
    }
  })

  it('a normal bot sometimes challenges, and always answers one way or the other', () => {
    const g = rigChallenge('wildDrawColor', 'red')
    let rng = seedRng('challenge-normal')
    let challenged = 0
    for (let i = 0; i < 100; i++) {
      const decision = decideBot(viewFor(g.state, 'p0'), rng, 'normal')
      expect(['challenge', 'acceptDraw']).toContain(decision.intent?.t)
      if (decision.intent?.t === 'challenge') challenged++
      rng = decision.rng
    }
    expect(challenged).toBeGreaterThan(0)
    expect(challenged).toBeLessThan(100)
  })
})

describe('decideBot — tactics', () => {
  it('lands a Draw Five on a player who is about to go out', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    const draw5 = d.face('dark', 'pink draw5')
    const number = d.face('dark', 'pink 9')
    g.rig({
      side: 'dark',
      hands: { p0: [draw5, number, ...d.filler(2)], p1: [d.face('dark', 'teal 1')] },
      discard: [d.face('dark', 'pink 3')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    expect(intent?.t).toBe('play')
    if (intent?.t !== 'play') throw new Error('unreachable')
    expect(cardIdForKey(g.state, intent.key)).toBe(draw5)
  })

  it('spends the wild that punishes, not the one that is cheapest to spend', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    const wild = d.face('light', 'wild')
    const wildDraw2 = d.face('light', 'wildDraw2')
    g.rig({
      // Both wilds are always legal, so the only thing separating them is what the bot wants.
      hands: { p0: [wild, wildDraw2, ...d.filler(2)], p1: [d.face('light', 'blue 1')] },
      discard: [d.face('light', 'red 3')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    if (intent?.t !== 'play') throw new Error(`expected a play, got ${intent?.t}`)
    // A plain Wild costs the opponent nothing, and they are one card from going out. The whole
    // point of holding a Wild Draw Two is this turn.
    expect(cardIdForKey(g.state, intent.key)).toBe(wildDraw2)
  })

  it('does not burn a plain wild on an opponent who is about to go out', () => {
    const d = new Deal()
    const g = new Game({ players: 2 })
    g.do({ type: 'startRound' })
    const wild = d.face('light', 'wild')
    const draw1 = d.face('light', 'red draw1')
    g.rig({
      hands: {
        p0: [wild, draw1, ...d.filler(2, { notColor: 'red', notValue: 3 })],
        p1: [d.face('light', 'blue 1')],
      },
      discard: [d.face('light', 'red 3')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    if (intent?.t !== 'play') throw new Error(`expected a play, got ${intent?.t}`)
    expect(cardIdForKey(g.state, intent.key)).toBe(draw1)
  })

  it('holds its wild when an ordinary card will do', () => {
    const d = new Deal()
    const g = new Game({ players: 3 })
    g.do({ type: 'startRound' })
    const wild = d.face('light', 'wild')
    const red = d.face('light', 'red 9')
    g.rig({
      // Filler that is neither red nor a 3 is illegal on a red 3, so the only choice the bot has
      // is "wild, or the one coloured card that matches".
      hands: {
        p0: [wild, red, ...d.filler(4, { notColor: 'red', notValue: 3 })],
        p1: d.filler(5),
        p2: d.filler(5),
      },
      discard: [d.face('light', 'red 3')],
      turn: 'p0',
      phase: { t: 'awaitingPlay' },
      declaredColor: null,
    })
    const intent = ask(g.state, 'p0')
    if (intent?.t !== 'play') throw new Error(`expected a play, got ${intent?.t}`)
    expect(cardIdForKey(g.state, intent.key)).toBe(red)
  })
})

describe('decideBot — a table of bots plays real games', () => {
  const difficulties: BotDifficulty[] = ['easy', 'normal']

  for (const difficulty of difficulties) {
    it(`${difficulty} bots play a four-handed round to completion without stalling`, () => {
      for (const seed of ['bots-a', 'bots-b', 'bots-c']) {
        const g = new Game({ players: 4, seed })
        g.do({ type: 'startRound' })

        let rng = seedRng(`drive-${seed}-${difficulty}`)
        let acted = 0
        for (; acted < 2000; acted++) {
          if (g.phase === 'roundOver' || g.phase === 'gameOver') break
          const actor = owes(g.state)
          // Nobody owes an action but the round has not ended: that would be a stall. The one
          // legitimate case is an exhausted table, which ends the round through `pilesExhausted`.
          if (!actor) break
          const decision = decideBot(viewFor(g.state, actor), rng, difficulty)
          rng = decision.rng
          if (!decision.intent) throw new Error(`bot ${actor} owed an action and had none`)
          // `Game.do` asserts every state invariant, including 112-card conservation.
          g.do(toAction(g.state, actor, decision.intent))
        }

        expect(g.phase, `seed ${seed} did not finish`).toMatch(/roundOver|gameOver/)
        expect(acted).toBeLessThan(2000)
      }
    })
  }

  it('plays a whole game to 500 without a stall or an illegal action', () => {
    const g = new Game({ players: 3, seed: 'full-game' })
    let rng = seedRng('drive-full')

    for (let step = 0; step < 40_000; step++) {
      if (g.phase === 'gameOver') break
      if (g.phase === 'lobby' || g.phase === 'roundOver') {
        g.do({ type: 'startRound' })
        continue
      }
      const actor = owes(g.state)
      if (!actor) throw new Error(`no one owes an action in phase "${g.phase}"`)
      const decision = decideBot(viewFor(g.state, actor), rng, 'normal')
      rng = decision.rng
      if (!decision.intent) throw new Error(`bot ${actor} owed an action and had none`)
      g.do(toAction(g.state, actor, decision.intent))
    }

    expect(g.phase).toBe('gameOver')
  })
})

/** Who, if anyone, the reducer is currently waiting on. Mirrors the DO's own scheduling check. */
function owes(state: GameState): PlayerId | null {
  switch (state.phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return state.players[state.turn]?.id ?? null
    case 'awaitingColorChoice':
      return state.phase.chooser
    case 'awaitingChallenge':
      return state.phase.challenger
    default:
      return null
  }
}
