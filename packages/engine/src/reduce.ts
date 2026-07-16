/**
 * The reducer. `(state, action) → { state, events }`, pure and synchronous.
 *
 * It knows about phases, turns, piles and effects. It does **not** know what a Skip Everyone is —
 * that lives in the rule pack. If a rule name ever appears in this file, the architecture has
 * failed.
 *
 * Purity is enforced three ways: ESLint bans the clock, entropy and I/O in this package; the RNG's
 * state lives in `GameState`; and every reduction begins by cloning the input through JSON, which
 * both guarantees the caller's state is untouched *and* fails loudly the moment a `Map` or a
 * `Date` sneaks into the state shape.
 */

import { cardIndex, getPack } from './rulepack.js'
import type { PlayEffectContext, PlayabilityContext, RulePack } from './rulepack.js'
import type {
  Action,
  Card,
  CardId,
  Color,
  Face,
  GameEvent,
  GameState,
  Player,
  PlayerId,
  ReduceResult,
  RuleOptions,
  TurnResume,
} from './types.js'
import { DEFAULT_OPTIONS, RuleError, isWildDrawKind, isWildKind } from './types.js'
import {
  activeColor,
  activeFace,
  applyEffects,
  cardOf,
  drawTo,
  drawUntilColor,
  faceOn,
  newEffectCtx,
  playerIndex,
  seatAfter,
  topCardId,
} from './effects.js'
import type { EffectCtx } from './effects.js'
import { roundPoints } from './score.js'
import { seedRng, shuffle } from './rng.js'

/**
 * JSON round-trip clone. Deliberately not `structuredClone`: this one *enforces* the JSON-plain
 * invariant rather than merely tolerating it, and it is the same operation the state will make
 * when it crosses the sandbox boundary in Stage 3.
 */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

// ---------------------------------------------------------------------------------------------
// Game construction
// ---------------------------------------------------------------------------------------------

export interface CreateGameSpec {
  packId: string
  players: Array<{ id: PlayerId; name: string }>
  seed: string
  options?: Partial<RuleOptions>
}

export function createGame(spec: CreateGameSpec): GameState {
  const pack = getPack(spec.packId)
  if (spec.players.length < 2) {
    throw new RuleError('not_enough_players', 'a game needs at least two players')
  }

  const options: RuleOptions = { ...DEFAULT_OPTIONS, ...pack.defaultOptions(), ...spec.options }

  return {
    v: 1,
    packId: pack.id,
    options,
    rng: seedRng(spec.seed),
    phase: { t: 'lobby' },
    side: 'light',
    players: spec.players.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      hand: [],
      score: 0,
      saidUno: false,
    })),
    turn: 0,
    direction: 1,
    dealer: 0,
    drawPile: [],
    discardPile: [],
    declaredColor: null,
    unoWindow: null,
    alias: {},
    roundNumber: 0,
    seq: 0,
  }
}

/**
 * Assign each card a fresh opaque alias for the round.
 *
 * The aliases are `k000`…`k111` handed out in *shuffled* order, so an alias reveals nothing about
 * the card behind it — which is the whole point. Reshuffling every round means a client cannot
 * accumulate a mapping across rounds either.
 */
function assignAliases(state: GameState, deck: readonly CardId[]): void {
  const [order, rng] = shuffle(deck, state.rng)
  state.rng = rng

  const alias: Record<CardId, string> = {}
  order.forEach((id, i) => {
    alias[id] = `k${String(i).padStart(3, '0')}`
  })
  state.alias = alias
}

// ---------------------------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------------------------

export function reduce(input: GameState, action: Action): ReduceResult {
  const pack = getPack(input.packId)
  const cards = cardIndex(pack)

  const state = clone(input)
  const events: GameEvent[] = []
  const windowAtStart = state.unoWindow

  try {
    dispatch(state, action, pack, cards, events)
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, code: err.code, message: err.message }
    throw err
  }

  closeUnoWindow(state, action, windowAtStart)
  state.seq = input.seq + 1

  return { ok: true, state, events }
}

function dispatch(
  state: GameState,
  action: Action,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  switch (action.type) {
    case 'startRound':
      return startRound(state, pack, cards, events)
    case 'play':
      return doPlay(state, action.player, action.card, action.declaredColor ?? null, pack, cards, events)
    case 'draw':
      return doDraw(state, action.player, pack, cards, events)
    case 'pass':
      return doPass(state, action.player, pack, cards, events)
    case 'chooseColor':
      return doChooseColor(state, action.player, action.color, pack, cards, events)
    case 'challenge':
      return doChallenge(state, action.player, true, pack, cards, events)
    case 'acceptDraw':
      return doChallenge(state, action.player, false, pack, cards, events)
    case 'callUno':
      return doCallUno(state, action.player, events)
    case 'callout':
      return doCallout(state, action.player, action.target, pack, cards, events)
    default: {
      const never: never = action
      throw new RuleError('internal', `unknown action ${JSON.stringify(never)}`)
    }
  }
}

/**
 * *"if you are caught before the next player begins their turn, you must draw two cards."*
 *
 * The window is open from the moment a player is left holding one card, and it closes when some
 * **other** player acts. Keeping it open across the window-owner's own follow-up turns matters:
 * a Skip Everyone hands them an immediate second turn, and the physical game would still let you
 * shout at them in that gap (D12).
 */
function closeUnoWindow(state: GameState, action: Action, windowAtStart: PlayerId | null): void {
  if (windowAtStart === null) return
  if (state.unoWindow !== windowAtStart) return // a fresh window opened; leave it alone

  const actor = 'player' in action ? action.player : null
  if (actor === windowAtStart) return // the owner's own action does not close their window
  if (action.type === 'callout') return // the callout handler owns the window

  state.unoWindow = null
}

// ---------------------------------------------------------------------------------------------
// Round setup
// ---------------------------------------------------------------------------------------------

/** Enough to exhaust every Flip and wild-draw in a 112-card deck several times over. */
const MAX_OPENING_REDRAWS = 200

function startRound(
  state: GameState,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'lobby' && state.phase.t !== 'roundOver') {
    throw new RuleError('wrong_phase', `cannot start a round from phase "${state.phase.t}"`)
  }
  if (state.players.length < 2) {
    throw new RuleError('not_enough_players', 'a game needs at least two players')
  }

  const deck = pack.buildDeck().map(c => c.id)
  assignAliases(state, deck)

  const [shuffled, rng] = shuffle(deck, state.rng)

  state.rng = rng
  state.drawPile = shuffled
  state.discardPile = []
  state.side = 'light' // "The game always starts on the Light Side."
  state.direction = 1
  state.declaredColor = null
  state.unoWindow = null
  state.roundNumber += 1

  for (const player of state.players) {
    player.hand = []
    player.saidUno = false
  }

  // Deal from the dealer's left, one card at a time round the table — as you would by hand. The
  // order matters only because it must be *reproducible*, and dealing in rounds is what a replay
  // of the seed will show.
  const n = state.players.length
  for (let i = 0; i < state.options.handSize; i++) {
    for (let k = 1; k <= n; k++) {
      const seat = (state.dealer + k) % n
      const id = state.drawPile.pop()
      if (id === undefined) throw new RuleError('internal', 'deck too small to deal')
      ;(state.players[seat] as Player).hand.push(id)
    }
  }

  const starter = (state.dealer + 1) % n
  state.turn = starter

  const dealerId = (state.players[state.dealer] as Player).id
  const opening = turnUpOpeningCard(state, pack, cards)

  events.push({
    t: 'roundStarted',
    round: state.roundNumber,
    dealer: dealerId,
    starter: (state.players[starter] as Player).id,
    opening,
  })
  events.push({ t: 'handsDealt', count: state.options.handSize })

  applyOpeningPolicy(state, opening, starter, pack, cards, events)
}

/**
 * Turn cards up until one is acceptable as the opening discard.
 *
 * Wild Draw Two is Mattel's own explicit case ("return it to the deck and pick another"), and we
 * extend the same treatment to Flip, which GDR44 simply never addresses (D2). A rejected card goes
 * back into the draw pile and the pile is reshuffled, so the choice stays deterministic under the
 * seed.
 */
function turnUpOpeningCard(state: GameState, pack: RulePack, cards: Record<CardId, Card>): CardId {
  for (let i = 0; i < MAX_OPENING_REDRAWS; i++) {
    const id = state.drawPile.pop()
    if (id === undefined) throw new RuleError('internal', 'draw pile exhausted while turning up the opening card')

    const policy = pack.openingPolicy(faceOn(cards, id, state.side))
    if (policy.t !== 'redraw') {
      state.discardPile = [id]
      return id
    }

    state.drawPile.push(id)
    const [reshuffled, rng] = shuffle(state.drawPile, state.rng)
    state.drawPile = reshuffled
    state.rng = rng
  }
  throw new RuleError('internal', 'could not find an acceptable opening card')
}

function applyOpeningPolicy(
  state: GameState,
  opening: CardId,
  starter: number,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  const policy = pack.openingPolicy(faceOn(cards, opening, state.side))

  if (policy.t === 'chooseColor') {
    // "Player to the left of the dealer chooses the color" — and then plays.
    state.phase = {
      t: 'awaitingColorChoice',
      chooser: (state.players[starter] as Player).id,
      reason: 'opening',
      resume: null,
    }
    return
  }
  if (policy.t === 'redraw') {
    throw new RuleError('internal', 'turnUpOpeningCard returned a card the pack wants redrawn')
  }

  // Nobody played this card, so the effects run with the **dealer** as the actor: the normal
  // single advance from the dealer lands on the starter, which is exactly "play begins to the
  // dealer's left". A Skip then advances one further; a Reverse uses `setTurn` to hand the first
  // turn back to the dealer.
  const ctx = newEffectCtx(state, pack, cards, events, state.dealer, null)
  applyEffects(ctx, policy.effects)

  state.turn = ctx.forcedTurn ?? seatAfter(state, state.dealer, 1 + ctx.extraSkips)
  state.phase = { t: 'awaitingPlay' }
  events.push({ t: 'turnChanged', player: (state.players[state.turn] as Player).id })
}

// ---------------------------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------------------------

function requirePlayer(state: GameState, id: PlayerId): Player {
  const player = state.players.find(p => p.id === id)
  if (!player) throw new RuleError('internal', `unknown player "${id}"`)
  return player
}

function requireTurn(state: GameState, id: PlayerId): Player {
  const player = requirePlayer(state, id)
  if (state.players[state.turn]?.id !== id) {
    throw new RuleError('not_your_turn', `it is not ${player.name}'s turn`)
  }
  return player
}

function playabilityContext(
  state: GameState,
  cards: Record<CardId, Card>,
  face: Face,
): PlayabilityContext {
  return Object.freeze({
    side: state.side,
    options: Object.freeze({ ...state.options }),
    face: Object.freeze({ ...face }),
    activeFace: Object.freeze({ ...activeFace(state, cards) }),
    activeColor: activeColor(state, cards),
  })
}

function doPlay(
  state: GameState,
  playerId: PlayerId,
  cardId: CardId,
  declared: Color | null,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'awaitingPlay' && state.phase.t !== 'awaitingDrawnCardChoice') {
    throw new RuleError('wrong_phase', `cannot play during "${state.phase.t}"`)
  }
  const player = requireTurn(state, playerId)

  if (!cards[cardId]) throw new RuleError('unknown_card', `no such card "${cardId}"`)

  const handIndex = player.hand.indexOf(cardId)
  if (handIndex < 0) throw new RuleError('card_not_in_hand', `${player.name} does not hold that card`)

  // "you may only play *that* drawn card — no other card from your hand."
  if (state.phase.t === 'awaitingDrawnCardChoice' && state.phase.card !== cardId) {
    throw new RuleError('not_drawn_card', 'after drawing you may only play the card you drew')
  }

  const face = faceOn(cards, cardId, state.side)
  const ctxIn = playabilityContext(state, cards, face)

  if (!pack.isPlayable(ctxIn)) {
    throw new RuleError('illegal_play', 'that card does not match the discard pile')
  }

  // Colour declaration
  const needsColor = pack.requiresColorChoice(face)
  if (needsColor) {
    if (declared === null) throw new RuleError('color_required', 'a wild needs a colour')
    if (!pack.colorsFor(state.side).includes(declared)) {
      throw new RuleError('bad_color_for_side', `"${declared}" is not a ${state.side}-side colour`)
    }
  } else if (declared !== null) {
    throw new RuleError('color_not_allowed', 'only a wild may declare a colour')
  }

  // D7: off by default. The rules-accurate behaviour is to *allow* the play and let the challenge
  // decide — hard-blocking it here would delete the challenge minigame entirely.
  if (state.options.enforceWildDrawColorRestriction && isWildDrawKind(face)) {
    const active = ctxIn.activeColor
    const hasMatch = player.hand.some(
      (id, i) => i !== handIndex && active !== null && faceOn(cards, id, state.side).color === active,
    )
    if (hasMatch) {
      throw new RuleError('illegal_play', 'you hold a card of the active colour')
    }
  }

  const priorColor = ctxIn.activeColor

  player.hand.splice(handIndex, 1)
  state.discardPile.push(cardId)
  // A coloured card carries its own colour; any colour declared over an earlier wild is now dead.
  // A wild re-sets this via its `setColor` effect a few lines below.
  state.declaredColor = null

  events.push({ t: 'cardPlayed', player: player.id, card: cardId, declaredColor: declared })

  // "Play your next-to-last card → yell UNO." The window opens the instant the hand hits one, and
  // stays open even while the game blocks on a colour choice or a challenge.
  if (player.hand.length === 1) state.unoWindow = player.id

  const seat = player.seat
  const effectCtx: PlayEffectContext = Object.freeze({
    ...ctxIn,
    player: player.id,
    playerCount: state.players.length,
    declaredColor: declared,
  })

  const ctx = newEffectCtx(state, pack, cards, events, seat, declared)
  applyEffects(ctx, pack.effectsForPlay(effectCtx))

  settle(state, ctx, pack, cards, events, priorColor)
}

// ---------------------------------------------------------------------------------------------
// Drawing / passing
// ---------------------------------------------------------------------------------------------

function doDraw(
  state: GameState,
  playerId: PlayerId,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'awaitingPlay') {
    throw new RuleError('wrong_phase', `cannot draw during "${state.phase.t}"`)
  }
  const player = requireTurn(state, playerId)
  const ctx = newEffectCtx(state, pack, cards, events, player.seat, null)

  const drawn = drawTo(ctx, player.seat, 1)
  const id = drawn[0]

  if (id === undefined) {
    // D10: both piles are exhausted. There is nothing to draw and nothing to play — the turn
    // simply passes rather than the game hanging.
    events.push({ t: 'passed', player: player.id })
    finishTurn(state, ctx, events)
    return
  }

  const face = faceOn(cards, id, state.side)
  if (pack.isPlayable(playabilityContext(state, cards, face))) {
    // "A drawn card may be played immediately if playable." Their choice — hold the turn.
    state.phase = { t: 'awaitingDrawnCardChoice', card: id }
    return
  }

  events.push({ t: 'passed', player: player.id })
  finishTurn(state, ctx, events)
}

function doPass(
  state: GameState,
  playerId: PlayerId,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'awaitingDrawnCardChoice') {
    throw new RuleError('wrong_phase', 'you may only pass after drawing')
  }
  const player = requireTurn(state, playerId)

  events.push({ t: 'passed', player: player.id })
  finishTurn(state, newEffectCtx(state, pack, cards, events, player.seat, null), events)
}

// ---------------------------------------------------------------------------------------------
// Colour choice
// ---------------------------------------------------------------------------------------------

function doChooseColor(
  state: GameState,
  playerId: PlayerId,
  color: Color,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'awaitingColorChoice') {
    throw new RuleError('wrong_phase', `nothing is waiting on a colour (phase "${state.phase.t}")`)
  }
  const phase = state.phase
  if (phase.chooser !== playerId) {
    throw new RuleError('not_your_turn', 'it is not your colour to choose')
  }
  if (!pack.colorsFor(state.side).includes(color)) {
    throw new RuleError('bad_color_for_side', `"${color}" is not a ${state.side}-side colour`)
  }

  state.declaredColor = color
  events.push({ t: 'colorChosen', player: playerId, color })

  if (phase.resume === null) {
    // The opening Wild: the chooser *is* the starting player, and the turn is already theirs.
    state.phase = { t: 'awaitingPlay' }
    events.push({ t: 'turnChanged', player: (state.players[state.turn] as Player).id })
    return
  }

  resumeTurn(state, phase.resume, pack, cards, events)
}

// ---------------------------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------------------------

function doChallenge(
  state: GameState,
  playerId: PlayerId,
  challenging: boolean,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  if (state.phase.t !== 'awaitingChallenge') {
    throw new RuleError('nothing_to_challenge', `nothing to challenge (phase "${state.phase.t}")`)
  }
  const phase = state.phase
  if (phase.challenger !== playerId) {
    throw new RuleError('not_your_turn', 'the challenge is not yours to make')
  }

  const accused = requirePlayer(state, phase.accused)
  const challenger = requirePlayer(state, phase.challenger)
  const ctx = newEffectCtx(state, pack, cards, events, accused.seat, phase.color)
  ctx.extraSkips = phase.resume.extraSkips
  ctx.forcedTurn = phase.resume.forcedTurn

  const drawVictim = (seat: number): void => {
    if (phase.kind === 'wildDraw2') drawTo(ctx, seat, 2)
    else drawUntilColor(ctx, seat, phase.color)
  }

  if (!challenging) {
    events.push({ t: 'drawAccepted', player: challenger.id })
    drawVictim(challenger.seat)
    ctx.extraSkips += 1 // "…and loses their turn."
    settle(state, ctx, pack, cards, events, null)
    return
  }

  // Guilt: did the accused hold a card of the colour that was active *before* they played the
  // wild-draw? A Wild in hand has no colour, so it never counts as a match — which is D8's
  // presumed reading, and it falls out of the model rather than needing a rule.
  const guilty =
    phase.priorColor !== null &&
    accused.hand.some(id => faceOn(cards, id, state.side).color === phase.priorColor)

  events.push({
    t: 'challenged',
    challenger: challenger.id,
    accused: accused.id,
    guilty,
    // "the challenged player shows their hand to the challenger" — and only to the challenger.
    // `view.ts` strips this for every other recipient at the broadcast boundary.
    revealed: accused.hand.slice(),
  })

  if (guilty) {
    // "Guilty → they draw instead of you." The challenger keeps their turn.
    drawVictim(accused.seat)
  } else {
    // "Innocent → you draw, plus 2 more."
    drawVictim(challenger.seat)
    drawTo(ctx, challenger.seat, 2)
    ctx.extraSkips += 1
  }

  settle(state, ctx, pack, cards, events, null)
}

// ---------------------------------------------------------------------------------------------
// UNO
// ---------------------------------------------------------------------------------------------

function doCallUno(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const player = requirePlayer(state, playerId)

  // Legal either pre-emptively — holding two cards on your own turn, about to play one — or
  // reactively, during your own open callout window. The second is the self-rescue: you forgot,
  // nobody has caught you yet, and you may still say it.
  const preemptive = player.hand.length === 2 && state.players[state.turn]?.id === playerId
  const rescue = state.unoWindow === playerId && player.hand.length === 1

  if (!preemptive && !rescue) {
    throw new RuleError('uno_not_available', 'you cannot call UNO right now')
  }

  player.saidUno = true
  events.push({ t: 'unoCalled', player: player.id })
}

function doCallout(
  state: GameState,
  callerId: PlayerId,
  targetId: PlayerId,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  const caller = requirePlayer(state, callerId)
  const target = requirePlayer(state, targetId)

  if (callerId === targetId) {
    throw new RuleError('callout_not_available', 'you cannot call yourself out')
  }
  if (state.unoWindow !== targetId) {
    throw new RuleError('callout_not_available', `${target.name} is not open to a callout`)
  }

  const ctx = newEffectCtx(state, pack, cards, events, target.seat, null)

  if (target.saidUno) {
    events.push({ t: 'calloutFailed', player: caller.id, target: target.id })
    if (state.options.falseCalloutPenaltyCards > 0) {
      drawTo(ctx, caller.seat, state.options.falseCalloutPenaltyCards)
    }
  } else {
    drawTo(ctx, target.seat, state.options.unoPenaltyCards)
    events.push({
      t: 'unoPenalty',
      player: target.id,
      by: caller.id,
      cards: state.options.unoPenaltyCards,
    })
  }

  // Either way the window is spent — otherwise every player queues a callout on the same target.
  state.unoWindow = null
}

// ---------------------------------------------------------------------------------------------
// Settling a turn
// ---------------------------------------------------------------------------------------------

/**
 * What happens after a play's effects have run. The order of these three checks is load-bearing:
 *
 * 1. **A challenge blocks everything**, because a wild-draw's draw is *deferred* until it
 *    resolves. Ending the round first would rob the winner of those points — see (2).
 *
 * 2. **Then the win check**, after every draw the play caused. *"If the last card played was a
 *    Draw One / Draw Five / Wild Draw Two / Wild Draw Color, the next player must still draw — and
 *    those cards count toward the winner's score."* So a Wild Draw Two played as a last card is
 *    worth however much the victim is forced to pick up.
 *
 *    (Note what this ordering does *not* do: it cannot un-win a round. Guilt is "did the accused
 *    still hold a card of the active colour", and a winner's hand is empty — so a challenge
 *    against a winning wild-draw is always innocent, and it is the challenger who pays.)
 *
 * 3. **Then the exposed-wild invariant.** If a wild face is showing with no colour behind it,
 *    somebody must name one. This is checked as a property of the *state*, not as a consequence of
 *    the Flip effect — so it stays correct for any future pack that exposes a wild some other way.
 */
function settle(
  state: GameState,
  ctx: EffectCtx,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
  priorColor: Color | null,
): void {
  const actor = state.players[ctx.actor] as Player

  if (ctx.challenge) {
    const challengerSeat = seatAfter(state, ctx.actor, 1)
    const challenger = state.players[challengerSeat] as Player
    state.phase = {
      t: 'awaitingChallenge',
      challenger: challenger.id,
      accused: actor.id,
      kind: ctx.challenge.kind,
      color: ctx.challenge.color,
      priorColor,
      resume: { actor: ctx.actor, extraSkips: ctx.extraSkips, forcedTurn: ctx.forcedTurn },
    }
    events.push({
      t: 'challengeOpened',
      challenger: challenger.id,
      accused: actor.id,
      kind: ctx.challenge.kind,
    })
    return
  }

  if (actor.hand.length === 0) {
    endRound(state, ctx.actor, pack, cards, events)
    return
  }

  if (isWildKind(activeFace(state, cards)) && state.declaredColor === null) {
    state.phase = {
      t: 'awaitingColorChoice',
      chooser: actor.id,
      reason: 'flip',
      resume: { actor: ctx.actor, extraSkips: ctx.extraSkips, forcedTurn: ctx.forcedTurn },
    }
    return
  }

  finishTurn(state, ctx, events)
}

/** Re-enter `settle` after a blocking phase resolved, with the play's original advance intact. */
function resumeTurn(
  state: GameState,
  resume: TurnResume,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  const ctx = newEffectCtx(state, pack, cards, events, resume.actor, state.declaredColor)
  ctx.extraSkips = resume.extraSkips
  ctx.forcedTurn = resume.forcedTurn
  settle(state, ctx, pack, cards, events, null)
}

function finishTurn(state: GameState, ctx: EffectCtx, events: GameEvent[]): void {
  const actor = state.players[ctx.actor] as Player

  if (actor.hand.length === 0) {
    throw new RuleError('internal', 'finishTurn reached with an empty-handed actor; settle should have ended the round')
  }

  // A hand that grew back past one card is no longer callable — a Draw Five in the face closes
  // your own UNO window.
  if (state.unoWindow !== null) {
    const owner = state.players.find(p => p.id === state.unoWindow)
    if (!owner || owner.hand.length !== 1) state.unoWindow = null
  }

  state.turn = ctx.forcedTurn ?? seatAfter(state, ctx.actor, 1 + ctx.extraSkips)
  state.phase = { t: 'awaitingPlay' }
  events.push({ t: 'turnChanged', player: (state.players[state.turn] as Player).id })
}

function endRound(
  state: GameState,
  winnerSeat: number,
  pack: RulePack,
  cards: Record<CardId, Card>,
  events: GameEvent[],
): void {
  const winner = state.players[winnerSeat] as Player

  // "score points based on which side the game ended on" — `state.side` is that side.
  const points = roundPoints(pack, cards, state, winner.id)
  winner.score += points
  state.unoWindow = null

  events.push({
    t: 'roundEnded',
    winner: winner.id,
    points,
    scores: state.players.map(p => ({ player: p.id, score: p.score })),
  })

  if (pack.isGameWon(winner.score, state.options)) {
    state.phase = { t: 'gameOver', winner: winner.id }
    events.push({ t: 'gameEnded', winner: winner.id })
    return
  }

  state.phase = { t: 'roundOver', winner: winner.id, points }
  state.dealer = (state.dealer + 1) % state.players.length
}

// ---------------------------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------------------------

/**
 * Every card in the deck is in exactly one place. This single assertion catches most engine bugs —
 * a Flip that loses the pile, a draw that duplicates a card, a reshuffle that drops the top card —
 * and the test suite runs it after *every* action of every game it plays.
 */
export function assertCardConservation(state: GameState): void {
  const pack = getPack(state.packId)
  const expected = pack.buildDeck().map(c => c.id)

  const seen: Record<CardId, number> = {}
  const count = (id: CardId, where: string): void => {
    const n = (seen[id] ?? 0) + 1
    seen[id] = n
    if (n > 1) throw new Error(`card "${id}" appears ${n} times (last seen in ${where})`)
  }

  for (const p of state.players) for (const id of p.hand) count(id, `${p.name}'s hand`)
  for (const id of state.drawPile) count(id, 'draw pile')
  for (const id of state.discardPile) count(id, 'discard pile')

  const total = Object.keys(seen).length
  if (total !== expected.length) {
    const missing = expected.filter(id => seen[id] === undefined)
    throw new Error(
      `expected ${expected.length} cards, found ${total}` +
        (missing.length ? `; missing ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}` : ''),
    )
  }
}

/** Cheap structural checks that should hold after every reduction. */
export function assertStateInvariants(state: GameState): void {
  assertCardConservation(state)

  if (state.phase.t !== 'lobby' && state.phase.t !== 'roundOver' && state.phase.t !== 'gameOver') {
    if (state.discardPile.length === 0) throw new Error('discard pile is empty mid-round')
    const pack = getPack(state.packId)
    const cards = cardIndex(pack)
    const face = activeFace(state, cards)
    if (isWildKind(face) && state.declaredColor === null && state.phase.t !== 'awaitingColorChoice') {
      throw new Error('a wild is showing with no colour declared, and nobody has been asked to choose')
    }
    if (state.declaredColor !== null && !pack.colorsFor(state.side).includes(state.declaredColor)) {
      throw new Error(`declared colour "${state.declaredColor}" is not a ${state.side}-side colour`)
    }
  }

  if (state.turn < 0 || state.turn >= state.players.length) {
    throw new Error(`turn ${state.turn} is out of range`)
  }
}

export { activeColor, activeFace, cardOf, faceOn, topCardId, playerIndex }
