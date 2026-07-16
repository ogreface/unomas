/**
 * Redaction: `GameState` → `PlayerView`.
 *
 * ## The mechanic
 *
 * Setup step 3: *"Hold the cards with the Light Side facing you and the Dark Side facing your
 * opponents."* So while the game is on the light side:
 *
 * - **you see the light faces of your own hand, and not the dark ones**;
 * - **your opponents see the dark faces of your hand, and not the light ones**.
 *
 * That single asymmetry *is* the mechanic, and it is why this file exists. Generalized: you see
 * the **active** face of your own cards and the **inactive** face of everyone else's. The draw
 * pile is dealt light-side-*down*, so its top card shows its inactive face to the whole table —
 * the same rule, applied to a pile.
 *
 * ## Why the view sends faces, not cards
 *
 * The client is never given the deck. If it were — if it held the light↔dark bijection and a card
 * id — then knowing an opponent's dark face would mechanically hand you their light face, and the
 * mechanic above would be worth exactly nothing. So a `PlayerView` carries **only the faces the
 * player is entitled to see**, and every card is referenced by a per-round opaque alias rather
 * than its deck id. A scraped client bundle learns nothing; a scraped `deck.ts` learns nothing,
 * because the alias is reshuffled from the seeded RNG every round.
 *
 * (What we do *not* defend against: a player who memorizes all 112 pairings by watching cards get
 * revealed over many rounds. Neither does the physical game.)
 */

import type {
  Card,
  CardId,
  Color,
  Direction,
  Face,
  GameEvent,
  GameState,
  Phase,
  PlayerId,
  RuleOptions,
  Side,
} from './types.js'
import { otherSide } from './types.js'
import { cardIndex, getPack } from './rulepack.js'
import { activeColor, activeFace, faceOn, topCardId } from './effects.js'

/** A card as a player is allowed to see it: one face, and an opaque handle to act on. */
export interface CardView {
  /** Opaque, stable within a round. The wire protocol plays by this, never by a deck id. */
  key: string
  face: Face
}

export interface PlayerSummaryView {
  id: PlayerId
  name: string
  seat: number
  score: number
  handCount: number
  saidUno: boolean
  /**
   * What you can see of this player's hand — the **inactive** face of each card, in hand order.
   * Empty for yourself: you are not allowed to see your own backs.
   */
  visible: CardView[]
}

export interface PlayerView {
  v: 1
  seq: number
  you: PlayerId
  roundNumber: number
  options: RuleOptions

  phase: PhaseView
  side: Side
  direction: Direction
  turn: PlayerId | null
  dealer: PlayerId
  /** The colour play must match. A wild's declared colour, or the top card's own. */
  activeColor: Color | null
  declaredColor: Color | null
  unoWindow: PlayerId | null

  /** The top of the discard, on the active side, plus how deep the pile is. */
  discard: { count: number; top: CardView }
  /**
   * The draw pile is placed active-side-**down**, so everyone can see the *inactive* face of the
   * next card to be drawn. A real mechanic, and one almost no digital version models.
   */
  drawPile: { count: number; peek: CardView | null }

  players: PlayerSummaryView[]
  /** Your hand, active faces. */
  hand: CardView[]
  /** Which of `hand` you may legally play right now. Computed server-side; the client has no rules. */
  legalPlays: string[]
}

/** `Phase`, with card ids swapped for aliases. Same shape otherwise. */
export type PhaseView =
  | Exclude<Phase, { t: 'awaitingDrawnCardChoice' }>
  | { t: 'awaitingDrawnCardChoice'; card: string }

// ---------------------------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------------------------

export function keyOf(state: GameState, id: CardId): string {
  const key = state.alias[id]
  if (key === undefined) throw new Error(`no alias for card "${id}" — was the round started?`)
  return key
}

/**
 * Invert the alias map. The DO calls this once per inbound action to turn a client's key back into
 * a deck id; an unknown key is simply not a card, which is exactly the error the reducer wants.
 */
export function cardIdForKey(state: GameState, key: string): CardId | null {
  for (const id of Object.keys(state.alias)) {
    if (state.alias[id] === key) return id
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

function cardView(state: GameState, cards: Record<CardId, Card>, id: CardId, side: Side): CardView {
  return { key: keyOf(state, id), face: { ...faceOn(cards, id, side) } }
}

function phaseView(state: GameState): PhaseView {
  const phase = state.phase
  if (phase.t === 'awaitingDrawnCardChoice') {
    return { t: 'awaitingDrawnCardChoice', card: keyOf(state, phase.card) }
  }
  return phase
}

export function viewFor(state: GameState, you: PlayerId): PlayerView {
  const pack = getPack(state.packId)
  const cards = cardIndex(pack)
  const inactive = otherSide(state.side)

  const me = state.players.find(p => p.id === you)
  if (!me) throw new Error(`no such player "${you}"`)

  const inRound = state.discardPile.length > 0

  const top = inRound ? topCardId(state) : null
  const peekId = state.drawPile[state.drawPile.length - 1]

  const legal: string[] = []
  if (inRound && isPlayablePhase(state, you)) {
    const face = activeFace(state, cards)
    const color = activeColor(state, cards)
    for (const id of me.hand) {
      if (state.phase.t === 'awaitingDrawnCardChoice' && state.phase.card !== id) continue
      const ctx = {
        side: state.side,
        options: state.options,
        face: faceOn(cards, id, state.side),
        activeFace: face,
        activeColor: color,
      }
      if (pack.isPlayable(ctx)) legal.push(keyOf(state, id))
    }
  }

  return {
    v: 1,
    seq: state.seq,
    you,
    roundNumber: state.roundNumber,
    options: { ...state.options },

    phase: phaseView(state),
    side: state.side,
    direction: state.direction,
    turn: state.players[state.turn]?.id ?? null,
    dealer: (state.players[state.dealer] ?? state.players[0])?.id ?? '',
    activeColor: inRound ? activeColor(state, cards) : null,
    declaredColor: state.declaredColor,
    unoWindow: state.unoWindow,

    discard: {
      count: state.discardPile.length,
      // Non-null in every phase a client renders; the lobby view is never drawn as a table.
      top: top ? cardView(state, cards, top, state.side) : { key: '', face: { color: null, kind: 'wild' } },
    },
    drawPile: {
      count: state.drawPile.length,
      peek: peekId ? cardView(state, cards, peekId, inactive) : null,
    },

    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      handCount: p.hand.length,
      saidUno: p.saidUno,
      // ── the channel ──────────────────────────────────────────────────────────────────────
      // Everyone else's cards are seen from behind: their INACTIVE face. Your own are not seen
      // from behind at all — you are holding them.
      visible: p.id === you ? [] : p.hand.map(id => cardView(state, cards, id, inactive)),
    })),

    hand: me.hand.map(id => cardView(state, cards, id, state.side)),
    legalPlays: legal,
  }
}

function isPlayablePhase(state: GameState, you: PlayerId): boolean {
  if (state.phase.t !== 'awaitingPlay' && state.phase.t !== 'awaitingDrawnCardChoice') return false
  return state.players[state.turn]?.id === you
}

// ---------------------------------------------------------------------------------------------
// Event redaction
// ---------------------------------------------------------------------------------------------

/** An event as it goes on the wire: card ids replaced by aliases, private payloads stripped. */
export type EventView =
  | Exclude<GameEvent, { t: 'cardsDrawn' } | { t: 'challenged' } | { t: 'cardPlayed' } | { t: 'flipped' } | { t: 'roundStarted' }>
  | { t: 'cardsDrawn'; player: PlayerId; count: number; cards: string[] }
  | { t: 'challenged'; challenger: PlayerId; accused: PlayerId; guilty: boolean; revealed: CardView[] }
  | { t: 'cardPlayed'; player: PlayerId; card: string; face: Face; declaredColor: Color | null }
  | { t: 'flipped'; side: Side; newTop: string; face: Face }
  | { t: 'roundStarted'; round: number; dealer: PlayerId; starter: PlayerId; opening: string; face: Face }

/**
 * Strip an event down to what `recipient` is entitled to see.
 *
 * Two events carry private payloads, and both would silently leak the game if broadcast raw:
 *
 * - **`cardsDrawn`** names the cards. Only the drawer may see them; everyone else gets the count.
 *   (They will learn the *inactive* faces anyway, from the drawer's `visible` list in the next
 *   view — which is right: those faces were on the table.)
 * - **`challenged`** carries the accused's hand. *"the challenged player shows their hand to the
 *   challenger"* — to the challenger, and to nobody else. Everyone learns the verdict.
 *
 * `state` must be the state **after** the events were produced, which is what `reduce` returns.
 */
export function redactEvent(state: GameState, event: GameEvent, recipient: PlayerId): EventView {
  const pack = getPack(state.packId)
  const cards = cardIndex(pack)

  switch (event.t) {
    case 'cardsDrawn':
      return {
        t: 'cardsDrawn',
        player: event.player,
        count: event.count,
        cards: event.player === recipient ? event.cards.map(id => keyOf(state, id)) : [],
      }

    case 'challenged':
      return {
        t: 'challenged',
        challenger: event.challenger,
        accused: event.accused,
        guilty: event.guilty,
        revealed:
          event.challenger === recipient
            ? event.revealed.map(id => cardView(state, cards, id, state.side))
            : [],
      }

    case 'cardPlayed':
      // A played card is face-up on the table: public, on the active side.
      return {
        t: 'cardPlayed',
        player: event.player,
        card: keyOf(state, event.card),
        face: { ...faceOn(cards, event.card, state.side) },
        declaredColor: event.declaredColor,
      }

    case 'flipped':
      return {
        t: 'flipped',
        side: event.side,
        newTop: keyOf(state, event.newTop),
        face: { ...faceOn(cards, event.newTop, event.side) },
      }

    case 'roundStarted':
      return {
        t: 'roundStarted',
        round: event.round,
        dealer: event.dealer,
        starter: event.starter,
        opening: keyOf(state, event.opening),
        face: { ...faceOn(cards, event.opening, 'light') },
      }

    default:
      return event
  }
}

export function redactEvents(state: GameState, events: readonly GameEvent[], recipient: PlayerId): EventView[] {
  return events.map(e => redactEvent(state, e, recipient))
}

// ---------------------------------------------------------------------------------------------
// The table view — read-only, for a screenshare
// ---------------------------------------------------------------------------------------------

/**
 * What a projector may see. Deliberately **not** `viewFor(spectator)`: a spectator view built from
 * a player's perspective would show that player's hand. The table shows only what is on the table
 * — piles, counts, turn order — plus the dark faces everyone can already see anyway.
 */
export interface TableView {
  v: 1
  seq: number
  roundNumber: number
  phase: PhaseView
  side: Side
  direction: Direction
  turn: PlayerId | null
  activeColor: Color | null
  unoWindow: PlayerId | null
  discard: { count: number; top: CardView }
  drawPile: { count: number; peek: CardView | null }
  players: Array<{
    id: PlayerId
    name: string
    seat: number
    score: number
    handCount: number
    saidUno: boolean
    /** Every player's hand as the *table* sees it: inactive faces. This is public information. */
    visible: CardView[]
  }>
}

export function tableView(state: GameState): TableView {
  const pack = getPack(state.packId)
  const cards = cardIndex(pack)
  const inactive = otherSide(state.side)

  const inRound = state.discardPile.length > 0
  const top = inRound ? topCardId(state) : null
  const peekId = state.drawPile[state.drawPile.length - 1]

  return {
    v: 1,
    seq: state.seq,
    roundNumber: state.roundNumber,
    phase: phaseView(state),
    side: state.side,
    direction: state.direction,
    turn: state.players[state.turn]?.id ?? null,
    activeColor: inRound ? activeColor(state, cards) : null,
    unoWindow: state.unoWindow,
    discard: {
      count: state.discardPile.length,
      top: top ? cardView(state, cards, top, state.side) : { key: '', face: { color: null, kind: 'wild' } },
    },
    drawPile: {
      count: state.drawPile.length,
      peek: peekId ? cardView(state, cards, peekId, inactive) : null,
    },
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      handCount: p.hand.length,
      saidUno: p.saidUno,
      visible: p.hand.map(id => cardView(state, cards, id, inactive)),
    })),
  }
}
