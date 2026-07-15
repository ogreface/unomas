/**
 * The trusted effect applier.
 *
 * Rule packs return `Effect[]`. Nothing else in the system may mutate `GameState`. When packs
 * become untrusted (Stage 3), this file is the entire attack surface — which is why every effect
 * here resolves its own targets, bounds its own loops, and never trusts a number it was handed.
 */

import type {
  Card,
  CardId,
  Color,
  Effect,
  EffectTarget,
  Face,
  GameEvent,
  GameState,
  Player,
  Side,
} from './types.js'
import { otherSide } from './types.js'
import type { RulePack } from './rulepack.js'
import { shuffle } from './rng.js'

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function topCardId(state: GameState): CardId {
  const id = state.discardPile[state.discardPile.length - 1]
  if (id === undefined) throw new Error('discard pile is empty — the reducer should never allow this')
  return id
}

export function cardOf(cards: Record<CardId, Card>, id: CardId): Card {
  const card = cards[id]
  if (!card) throw new Error(`unknown card id "${id}"`)
  return card
}

export function faceOn(cards: Record<CardId, Card>, id: CardId, side: Side): Face {
  return cardOf(cards, id)[side]
}

/** The face currently showing on top of the discard pile. */
export function activeFace(state: GameState, cards: Record<CardId, Card>): Face {
  return faceOn(cards, topCardId(state), state.side)
}

/**
 * The colour play must currently match. A coloured face carries its own; a wild face carries the
 * colour that was declared over it.
 */
export function activeColor(state: GameState, cards: Record<CardId, Card>): Color | null {
  return activeFace(state, cards).color ?? state.declaredColor
}

export function playerIndex(state: GameState, id: string): number {
  const i = state.players.findIndex(p => p.id === id)
  if (i < 0) throw new Error(`unknown player "${id}"`)
  return i
}

export function currentPlayer(state: GameState): Player {
  const p = state.players[state.turn]
  if (!p) throw new Error(`turn ${state.turn} is out of range`)
  return p
}

export function seatAfter(state: GameState, from: number, steps: number): number {
  const n = state.players.length
  return (((from + state.direction * steps) % n) + n) % n
}

// ---------------------------------------------------------------------------------------------
// The applier's working context
// ---------------------------------------------------------------------------------------------

export interface EffectCtx {
  state: GameState
  pack: RulePack
  cards: Record<CardId, Card>
  events: GameEvent[]
  /** The seat that caused these effects. Effect targets resolve relative to this. */
  actor: number
  /** The colour the actor declared, for `color: 'declared'`. */
  declared: Color | null

  // --- outputs the reducer consults after applying ---
  /** Extra turn advances on top of the normal one. */
  extraSkips: number
  /** A `skipEveryone` fired: play returns to the actor. */
  returnsToActor: boolean
  /** A wild-draw deferred its draw to the challenge machinery. */
  challenge: { kind: 'wildDraw2' | 'wildDrawColor'; color: Color } | null
  /** A `setTurn` fired: this seat plays next, whatever the skips say. */
  forcedTurn: number | null
  /** A flip fired. Diagnostic only — the reducer detects an exposed wild from state, not this. */
  flipped: boolean
}

export function newEffectCtx(
  state: GameState,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
  actor: number,
  declared: Color | null,
): EffectCtx {
  return {
    state,
    pack,
    cards,
    events,
    actor,
    declared,
    extraSkips: 0,
    returnsToActor: false,
    challenge: null,
    forcedTurn: null,
    flipped: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------------------------

/**
 * Refill the draw pile from the discard, leaving the top card in place.
 *
 * The Spanish text of GDR44 is the precise one: *leave the top card*, reshuffle the rest. This
 * matters more here than it does in base Uno, because the discard pile's **bottom** card is what
 * the next Flip will expose — so a reshuffle silently resets the Flip target (D11).
 *
 * Returns false when there is nothing to reshuffle: the piles are genuinely exhausted (D10).
 */
export function reshuffle(ctx: EffectCtx): boolean {
  const { state } = ctx
  if (state.discardPile.length <= 1) {
    ctx.events.push({ t: 'pilesExhausted' })
    return false
  }

  const top = state.discardPile[state.discardPile.length - 1] as CardId
  const rest = state.discardPile.slice(0, -1)
  const [shuffled, rng] = shuffle(rest, state.rng)

  state.rng = rng
  state.drawPile = shuffled
  state.discardPile = [top]
  ctx.events.push({ t: 'reshuffled', count: shuffled.length })
  return true
}

/**
 * Draw `n` cards to a seat. Reshuffles when the draw pile runs dry; draws fewer than asked (and
 * says so) when both piles are exhausted, rather than hanging or throwing.
 */
export function drawTo(ctx: EffectCtx, seat: number, n: number): CardId[] {
  const player = ctx.state.players[seat]
  if (!player) throw new Error(`seat ${seat} is out of range`)

  const drawn: CardId[] = []
  for (let i = 0; i < n; i++) {
    const card = takeOne(ctx)
    if (card === null) break
    player.hand.push(card)
    drawn.push(card)
  }

  if (drawn.length > 0) {
    // A hand that grew back past one card can no longer be "at UNO".
    if (player.hand.length > 1) player.saidUno = false
    ctx.events.push({ t: 'cardsDrawn', player: player.id, count: drawn.length, cards: drawn })
  }
  return drawn
}

function takeOne(ctx: EffectCtx): CardId | null {
  if (ctx.state.drawPile.length === 0 && !reshuffle(ctx)) return null
  return ctx.state.drawPile.pop() ?? null
}

/**
 * 🔴 Wild Draw Color: *"draws until they get a color of your choosing (however many it takes)"*.
 *
 * This has no termination guarantee in Mattel's text — if every card of that colour is already in
 * players' hands, a literal reading loops forever. It terminates here for a structural reason:
 * every draw moves a card permanently out of the piles and into a hand, so the supply strictly
 * shrinks and `takeOne` eventually returns null. `drawUntilColorCap` is a second, belt-and-braces
 * bound (D9).
 */
export function drawUntilColor(ctx: EffectCtx, seat: number, color: Color): CardId[] {
  const player = ctx.state.players[seat]
  if (!player) throw new Error(`seat ${seat} is out of range`)

  const cap = Math.max(1, Math.min(ctx.state.options.drawUntilColorCap, 500))
  const drawn: CardId[] = []

  for (let i = 0; i < cap; i++) {
    const id = takeOne(ctx)
    if (id === null) break
    player.hand.push(id)
    drawn.push(id)
    if (faceOn(ctx.cards, id, ctx.state.side).color === color) break
  }

  if (drawn.length > 0) {
    if (player.hand.length > 1) player.saidUno = false
    ctx.events.push({ t: 'cardsDrawn', player: player.id, count: drawn.length, cards: drawn })
  }
  return drawn
}

// ---------------------------------------------------------------------------------------------
// The Flip
// ---------------------------------------------------------------------------------------------

/**
 * *"flip over the Discard Pile (the card just played will now be on the bottom), then the Draw
 * Pile, then everyone's hands must flip to the other side."*
 *
 * The whole mechanic falls out of one line. `discardPile` is bottom-to-top, so inverting the
 * physical stack is `reverse()`: the Flip card you just played (last = top) becomes index 0
 * (bottom), and the card that *was* at the bottom becomes the top — showing its other face,
 * because `state.side` decides which face of every card is live.
 *
 * Hands and the draw pile need no work at all: they are arrays of `CardId`, and flipping `side`
 * flips every card in them for free. The draw pile *is* physically inverted, though, which
 * changes which card is drawn next — so we reverse it too.
 */
export function applyFlip(ctx: EffectCtx): void {
  const { state } = ctx

  if (state.options.flipInvertsDiscardPile) {
    state.discardPile.reverse()
  }
  state.drawPile.reverse()
  state.side = otherSide(state.side)

  // The colour declared over the *old* side's wild does not carry across. If the newly exposed
  // face is itself a wild, the reducer opens an `awaitingColorChoice` phase for the flipper (D3).
  state.declaredColor = null

  ctx.flipped = true
  ctx.events.push({ t: 'flipped', side: state.side, newTop: topCardId(state) })
}

// ---------------------------------------------------------------------------------------------
// The applier
// ---------------------------------------------------------------------------------------------

function resolveTargets(ctx: EffectCtx, target: EffectTarget): number[] {
  switch (target) {
    case 'current':
      return [ctx.actor]
    case 'next':
      return [seatAfter(ctx.state, ctx.actor, 1)]
    case 'all':
      return ctx.state.players.map((_, i) => i)
    case 'allOthers':
      return ctx.state.players.map((_, i) => i).filter(i => i !== ctx.actor)
    default: {
      const never: never = target
      throw new Error(`unknown effect target "${String(never)}"`)
    }
  }
}

function resolveColor(ctx: EffectCtx, color: Color | 'declared' | null): Color | null {
  if (color === 'declared') return ctx.declared
  return color
}

/** Bound on `n` for a draw effect. A pack asking for 10_000 cards gets 112. */
const MAX_DRAW = 112

export function applyEffects(ctx: EffectCtx, effects: readonly Effect[]): void {
  for (const effect of effects) {
    applyEffect(ctx, effect)
  }
}

function applyEffect(ctx: EffectCtx, effect: Effect): void {
  const { state } = ctx

  switch (effect.type) {
    case 'draw': {
      const n = Math.max(0, Math.min(Math.floor(effect.n), MAX_DRAW))
      for (const seat of resolveTargets(ctx, effect.target)) drawTo(ctx, seat, n)
      return
    }

    case 'drawUntilColor': {
      const color = resolveColor(ctx, effect.color)
      if (color === null) throw new Error('drawUntilColor: no colour resolved')
      for (const seat of resolveTargets(ctx, effect.target)) drawUntilColor(ctx, seat, color)
      return
    }

    case 'skip': {
      const n = Math.max(0, Math.min(Math.floor(effect.n), state.players.length))
      ctx.extraSkips += n
      const skipped = state.players[seatAfter(state, ctx.actor, 1)]
      if (n > 0 && skipped) ctx.events.push({ t: 'skipped', player: skipped.id })
      return
    }

    case 'skipEveryone': {
      // Advancing by exactly `playerCount` lands back on the actor, for any player count and any
      // direction. With two players it degenerates to a plain Skip, which is the correct
      // behaviour and needs no special case (D14).
      ctx.extraSkips += state.players.length - 1
      ctx.returnsToActor = true
      const actor = state.players[ctx.actor]
      if (actor) ctx.events.push({ t: 'skippedEveryone', by: actor.id })
      return
    }

    case 'reverse': {
      state.direction = state.direction === 1 ? -1 : 1
      ctx.events.push({ t: 'directionChanged', direction: state.direction })
      return
    }

    case 'flip': {
      applyFlip(ctx)
      return
    }

    case 'setColor': {
      const color = resolveColor(ctx, effect.color)
      state.declaredColor = color
      const actor = state.players[ctx.actor]
      if (color !== null && actor) ctx.events.push({ t: 'colorChosen', player: actor.id, color })
      return
    }

    case 'setTurn': {
      const seats = resolveTargets(ctx, effect.target)
      const seat = seats[0]
      if (seat === undefined) throw new Error(`setTurn: target "${effect.target}" resolved to no seat`)
      ctx.forcedTurn = seat
      return
    }

    case 'openChallenge': {
      const color = ctx.declared
      if (color === null) throw new Error('openChallenge: a wild-draw was played with no declared colour')
      ctx.challenge = { kind: effect.kind, color }
      return
    }

    default: {
      const never: never = effect
      throw new Error(`unknown effect "${JSON.stringify(never)}"`)
    }
  }
}
