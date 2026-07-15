/**
 * Test harness.
 *
 * `Game` wraps the reducer with two things every test wants and nobody should have to remember:
 *
 * 1. **The invariants run after every single action.** All 112 cards accounted for, no duplicates,
 *    no wild showing without a colour, turn in range. Per the plan, this one check catches most
 *    engine bugs, so it is not opt-in.
 * 2. **State is rigged, not played into position.** Reaching "player 2 holds the only Flip card and
 *    it is their turn" by playing a real game is a nightmare; `rig()` just puts it there, and then
 *    re-checks conservation so a rigged state can't be a broken one.
 */

import { expect } from 'vitest'
import {
  DECK,
  assertStateInvariants,
  createGame,
  reduce,
  UNOFLIP_PACK_ID,
} from '../src/index.js'
import type {
  Action,
  Card,
  CardId,
  Face,
  GameEvent,
  GameState,
  PlayerId,
  ReduceResult,
  RuleOptions,
  Side,
} from '../src/index.js'

export const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fi', 'Gus', 'Hal', 'Ivy', 'Jo']

export function players(n: number): Array<{ id: PlayerId; name: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: NAMES[i] as string }))
}

export class Game {
  state: GameState
  /** Every event ever emitted, in order. Tests assert against this. */
  events: GameEvent[] = []
  /** Every action ever accepted. Feed it back to `replay()` to prove determinism. */
  actions: Action[] = []

  constructor(opts: { players?: number; seed?: string; options?: Partial<RuleOptions> } = {}) {
    this.state = createGame({
      packId: UNOFLIP_PACK_ID,
      players: players(opts.players ?? 4),
      seed: opts.seed ?? 'test-seed',
      options: opts.options ?? {},
    })
  }

  /** Apply an action, assert it succeeded, and re-check every invariant. */
  do(action: Action): GameEvent[] {
    const result = reduce(this.state, action)
    if (!result.ok) {
      throw new Error(`action ${action.type} rejected: ${result.code} — ${result.message}`)
    }
    this.state = result.state
    this.actions.push(action)
    this.events.push(...result.events)
    assertStateInvariants(this.state)
    return result.events
  }

  /** Apply an action expecting it to be rejected, and return the rejection. */
  reject(action: Action): Extract<ReduceResult, { ok: false }> {
    const result = reduce(this.state, action)
    if (result.ok) throw new Error(`action ${action.type} was expected to fail, but succeeded`)
    return result
  }

  try(action: Action): ReduceResult {
    const result = reduce(this.state, action)
    if (result.ok) {
      this.state = result.state
      this.actions.push(action)
      this.events.push(...result.events)
      assertStateInvariants(this.state)
    }
    return result
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────

  get phase(): GameState['phase']['t'] {
    return this.state.phase.t
  }
  get side(): Side {
    return this.state.side
  }
  get turnId(): PlayerId {
    return (this.state.players[this.state.turn] as { id: string }).id
  }
  get topId(): CardId {
    return this.state.discardPile[this.state.discardPile.length - 1] as CardId
  }
  get topFace(): Face {
    return face(this.topId, this.state.side)
  }
  hand(id: PlayerId): CardId[] {
    return player(this.state, id).hand
  }
  score(id: PlayerId): number {
    return player(this.state, id).score
  }
  /** Events emitted by the most recent action only. */
  lastEvents(n: number): GameEvent[] {
    return this.events.slice(-n)
  }
  eventTypes(): Array<GameEvent['t']> {
    return this.events.map(e => e.t)
  }

  // ── rigging ────────────────────────────────────────────────────────────────────────────────

  /**
   * Force the state into a specific position. Everything not named is left alone, and card
   * conservation is re-asserted afterwards — so a rig that forgets to take a card out of the draw
   * pile fails loudly instead of quietly testing a 113-card deck.
   */
  rig(patch: {
    hands?: Record<PlayerId, CardId[]>
    discard?: CardId[]
    drawPile?: CardId[]
    turn?: PlayerId
    side?: Side
    direction?: 1 | -1
    declaredColor?: GameState['declaredColor']
    phase?: GameState['phase']
    scores?: Record<PlayerId, number>
  }): this {
    const s = this.state

    // Naming *any* hand means you are describing the whole table: every player you did not name
    // is empty-handed. The alternative — leaving them holding whatever the deal gave them — is how
    // a rig quietly ends up with two of the same card in play.
    if (patch.hands) {
      for (const p of s.players) p.hand = [...(patch.hands[p.id] ?? [])]
    }
    if (patch.scores) for (const [id, score] of Object.entries(patch.scores)) player(s, id).score = score
    if (patch.discard) s.discardPile = [...patch.discard]
    if (patch.turn) s.turn = s.players.findIndex(p => p.id === patch.turn)
    if (patch.side) s.side = patch.side
    if (patch.direction) s.direction = patch.direction
    if (patch.declaredColor !== undefined) s.declaredColor = patch.declaredColor
    if (patch.phase) s.phase = patch.phase

    // Everything the rig didn't place explicitly goes back into the draw pile, so the deck is
    // always whole. An explicit `drawPile` wins.
    if (patch.drawPile) {
      s.drawPile = [...patch.drawPile]
    } else if (patch.hands || patch.discard) {
      const placed = new Set<CardId>([...s.players.flatMap(p => p.hand), ...s.discardPile])
      s.drawPile = DECK.map(c => c.id).filter(id => !placed.has(id))
    }

    assertStateInvariants(s)
    return this
  }

  /**
   * Empty the draw pile by parking its contents in someone's hand.
   *
   * Every card has to be *somewhere* — that's the invariant — so a test that wants an exhausted
   * draw pile can't just throw the rest of the deck away. This is how you set up a reshuffle or a
   * genuine exhaustion without breaking conservation.
   */
  parkDrawPileIn(id: PlayerId): this {
    const p = player(this.state, id)
    p.hand = [...p.hand, ...this.state.drawPile]
    this.state.drawPile = []
    assertStateInvariants(this.state)
    return this
  }

  /** Put `ids` on top of the draw pile, last one drawn first. */
  stackDraw(...ids: CardId[]): this {
    const s = this.state
    const set = new Set(ids)
    s.drawPile = [...s.drawPile.filter(id => !set.has(id)), ...ids.slice().reverse()]
    assertStateInvariants(s)
    return this
  }
}

/**
 * A card picker that never hands out the same card twice.
 *
 * Rigs are the natural home of duplicate-card bugs: you ask for "a blue 4" in two places and get
 * the same physical card, and now the deck has 113 cards in it. `Deal` makes that impossible, and
 * the invariant check in `rig()` catches anything it misses.
 */
export class Deal {
  readonly used = new Set<CardId>()

  /** Reserve a specific card. */
  card(id: CardId): CardId {
    if (this.used.has(id)) throw new Error(`card "${id}" was already dealt`)
    this.used.add(id)
    return id
  }

  /** An unused card whose face on `side` reads like `'blue 4'`, `'red skip'`, or `'wildDraw2'`. */
  face(side: Side, desc: string): CardId {
    const id = DECK.find(c => faceStr(c[side]) === desc && !this.used.has(c.id))?.id
    if (!id) throw new Error(`no unused card has ${side} face "${desc}"`)
    return this.card(id)
  }

  /** An unused card matching BOTH faces, e.g. `both('blue reverse', 'wild')`. */
  both(light: string, dark: string): CardId {
    const id = DECK.find(
      c => faceStr(c.light) === light && faceStr(c.dark) === dark && !this.used.has(c.id),
    )?.id
    if (!id) throw new Error(`no unused card is "${light} / ${dark}"`)
    return this.card(id)
  }

  /**
   * Inert cards: plain numbers on *both* sides, so they can never trigger an effect, on either
   * side, no matter what the test does to the game. What you fill a hand with when you only care
   * about hand size.
   */
  filler(n: number, opts: { notColor?: string; notValue?: number } = {}): CardId[] {
    const out: CardId[] = []
    for (const c of DECK) {
      if (out.length === n) break
      if (this.used.has(c.id)) continue
      if (c.light.kind !== 'number' || c.dark.kind !== 'number') continue
      if (opts.notColor && c.light.color === opts.notColor) continue
      if (opts.notValue !== undefined && c.light.value === opts.notValue) continue
      out.push(this.card(c.id))
    }
    if (out.length < n) throw new Error(`only ${out.length} filler cards left, wanted ${n}`)
    return out
  }
}

// ── card lookups, for building rigs ──────────────────────────────────────────────────────────

export function player(state: GameState, id: PlayerId): GameState['players'][number] {
  const p = state.players.find(x => x.id === id)
  if (!p) throw new Error(`no player "${id}"`)
  return p
}

export function card(id: CardId): Card {
  const c = DECK.find(x => x.id === id)
  if (!c) throw new Error(`no card "${id}"`)
  return c
}

export function face(id: CardId, side: Side): Face {
  return card(id)[side]
}

/** Describe a face the way the deck table does, e.g. `blue 4`, `red skip`, `wildDraw2`. */
export function faceStr(f: Face): string {
  if (f.kind === 'number') return `${f.color} ${f.value}`
  return f.color ? `${f.color} ${f.kind}` : f.kind
}

/** Find every card whose face on `side` matches a description like `'blue 4'` or `'red skip'`. */
export function findAll(side: Side, desc: string): CardId[] {
  return DECK.filter(c => faceStr(c[side]) === desc).map(c => c.id)
}

/** Find one card by its face on `side`. Throws if there is none — a typo'd rig should not pass. */
export function find(side: Side, desc: string): CardId {
  const ids = findAll(side, desc)
  const id = ids[0]
  if (!id) throw new Error(`no card has ${side} face "${desc}"`)
  return id
}

/** Find a card by BOTH faces, e.g. `pair('blue reverse', 'wild')`. */
export function pair(light: string, dark: string): CardId {
  const c = DECK.find(x => faceStr(x.light) === light && faceStr(x.dark) === dark)
  if (!c) throw new Error(`no card is "${light} / ${dark}"`)
  return c.id
}

/** Cards that are safe filler: plain numbers on both sides, so they trigger nothing. */
export function filler(n: number, exclude: CardId[] = []): CardId[] {
  const out = DECK.filter(
    c => c.light.kind === 'number' && c.dark.kind === 'number' && !exclude.includes(c.id),
  ).map(c => c.id)
  const picked = out.slice(0, n)
  if (picked.length < n) throw new Error(`only ${picked.length} filler cards available, wanted ${n}`)
  return picked
}

/** A number card of a given colour on `side` that is *also* a plain number on the other side. */
export function number(side: Side, color: string, value: number, exclude: CardId[] = []): CardId {
  const other: Side = side === 'light' ? 'dark' : 'light'
  const c = DECK.find(
    x =>
      x[side].kind === 'number' &&
      x[side].color === color &&
      x[side].value === value &&
      x[other].kind === 'number' &&
      !exclude.includes(x.id),
  )
  if (!c) throw new Error(`no card is a plain ${side} ${color} ${value} with a plain number back`)
  return c.id
}

/**
 * Start a round whose opening card is one you asked for.
 *
 * The honest way to test the opening rules is through `startRound` itself — rigging the discard
 * pile afterwards would skip the very policy code under test. So: search seeds until the shuffle
 * turns up the card we want. It is brute force, but it exercises the real path, and a 112-card
 * deck finds any given face within a few hundred tries.
 */
export function gameOpeningOn(
  match: (f: Face) => boolean,
  opts: { players?: number; options?: Partial<RuleOptions> } = {},
): Game {
  for (let i = 0; i < 4000; i++) {
    const g = new Game({ ...opts, seed: `open-search-${i}` })
    g.do({ type: 'startRound' })
    if (match(face(g.topId, 'light'))) return g
  }
  throw new Error('no seed in 4000 tries produced the requested opening card')
}

export function expectEvent<T extends GameEvent['t']>(
  events: readonly GameEvent[],
  t: T,
): Extract<GameEvent, { t: T }> {
  const found = events.find(e => e.t === t)
  expect(found, `expected a "${t}" event in [${events.map(e => e.t).join(', ')}]`).toBeDefined()
  return found as Extract<GameEvent, { t: T }>
}

export function noEvent(events: readonly GameEvent[], t: GameEvent['t']): void {
  expect(
    events.find(e => e.t === t),
    `expected NO "${t}" event, got [${events.map(e => e.t).join(', ')}]`,
  ).toBeUndefined()
}
