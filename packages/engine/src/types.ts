/**
 * The core data model.
 *
 * Every type here is JSON-plain: no `Map`, `Set`, class instance, `undefined`, or `Symbol`. This is
 * not fussiness — `GameState` is persisted to the Durable Object's SQLite, replayed from an
 * append-only log, and (Stage 3) serialized across a QuickJS sandbox boundary. Anything that does
 * not survive `JSON.parse(JSON.stringify(x))` is a bug waiting for production.
 */

import type { Card, CardId, Color, Face, Side } from './data/deck.js'
import type { RngState } from './rng.js'

export type { Card, CardId, Color, DarkColor, Face, Kind, LightColor, Side } from './data/deck.js'
export type { RngState } from './rng.js'

export type PlayerId = string

/** +1 = play proceeds up the seat order, -1 = down. */
export type Direction = 1 | -1

export interface Player {
  id: PlayerId
  name: string
  /** Seat order is array order in `GameState.players`; this is the index, denormalized for reads. */
  seat: number
  hand: CardId[]
  /** Cumulative across rounds. First to `options.scoreLimit` wins the game. */
  score: number
  /** Set by `callUno`; cleared whenever the hand grows back past one card. */
  saidUno: boolean
}

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

/**
 * The game is a state machine, and the phase is the whole of it. A phase that is *awaiting*
 * something names both what it wants and who owes it — the reducer never has to reconstruct
 * "whose decision is this?" from context.
 */
export type Phase =
  | { t: 'lobby' }
  /** The player at `state.turn` must play, or draw. */
  | { t: 'awaitingPlay' }
  /** They drew `card`; they may play *that card only*, or pass. */
  | { t: 'awaitingDrawnCardChoice'; card: CardId }
  /**
   * A wild face is showing with no colour behind it. `chooser` must name one before play resumes.
   * Reached three ways: the opening card was a Wild; a Flip exposed a wild face (D3 — exactly 8 of
   * the 112 cards can do this); or a pack did something equivalent.
   */
  | {
      t: 'awaitingColorChoice'
      chooser: PlayerId
      reason: 'opening' | 'flip'
      /** The suspended turn advance. Null at the opening, where the turn is already correct. */
      resume: TurnResume | null
    }
  /** A wild-draw was played. `challenger` may challenge it, or take the draw. */
  | {
      t: 'awaitingChallenge'
      challenger: PlayerId
      accused: PlayerId
      kind: 'wildDraw2' | 'wildDrawColor'
      /** The colour the accused declared — what a Wild Draw Color will make the victim draw to. */
      color: Color
      /** The colour that was active *before* the play. Guilt is "did they hold a match for this?" */
      priorColor: Color | null
      resume: TurnResume
    }
  | { t: 'roundOver'; winner: PlayerId; points: number }
  | { t: 'gameOver'; winner: PlayerId }

export type PhaseName = Phase['t']

// ---------------------------------------------------------------------------------------------
// Rule options — one row per decided ambiguity. See docs/decisions.md.
// ---------------------------------------------------------------------------------------------

export interface RuleOptions {
  /** D6. Mattel is silent on 2-player Reverse. Universal player expectation is "acts as Skip". */
  twoPlayerReverseActsAsSkip: boolean
  /** D5. Playing a Flip inverts the *entire* discard pile, per the rules text. */
  flipInvertsDiscardPile: boolean
  /** D4. A card *revealed* by a Flip was not played: it sets colour/symbol and nothing else. */
  flipExposedActionCardTakesEffect: boolean
  /** D7. Allow an "illegal" wild-draw and let the challenge decide, rather than hard-blocking it. */
  enforceWildDrawColorRestriction: boolean
  /** D7. The challenge minigame itself. Off ⇒ wild-draws resolve immediately. */
  challengesEnabled: boolean
  /** D9. Structural backstop on Wild Draw Color. Exhaustion is the real guarantee; this is belt. */
  drawUntilColorCap: number
  /** D12. Penalty for being caught with one card and no UNO call. */
  unoPenaltyCards: number
  /** Penalty for calling out a player who *did* say UNO. Mattel is silent; 0 = no penalty. */
  falseCalloutPenaltyCards: number
  /** House rule, confirmed NOT official (Mattel, May 2019). Off by default. */
  stackingEnabled: boolean
  /** First to this many points wins the game. */
  scoreLimit: number
  /** Cards dealt to each player at the start of a round. */
  handSize: number
}

export const DEFAULT_OPTIONS: RuleOptions = {
  twoPlayerReverseActsAsSkip: true,
  flipInvertsDiscardPile: true,
  flipExposedActionCardTakesEffect: false,
  enforceWildDrawColorRestriction: false,
  challengesEnabled: true,
  drawUntilColorCap: 112,
  unoPenaltyCards: 2,
  falseCalloutPenaltyCards: 0,
  stackingEnabled: false,
  scoreLimit: 500,
  handSize: 7,
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface GameState {
  /** Schema version. Bump when the shape changes; the DO refuses to load a state it can't read. */
  v: 1
  packId: string
  options: RuleOptions
  rng: RngState

  phase: Phase
  side: Side
  players: Player[]
  /** Index into `players`. */
  turn: number
  direction: Direction
  /** Seat of the dealer for the current round. Rotates each round. */
  dealer: number

  /** index 0 = bottom, last = TOP (the next card drawn). */
  drawPile: CardId[]
  /**
   * index 0 = BOTTOM of the pile, last = TOP. This ordering is the crux of the engine: playing a
   * Flip is `discardPile.reverse()`, which drops the just-played card to the bottom and promotes
   * the pile's *bottom* card to the top — exactly Mattel's rule, with no special-casing.
   */
  discardPile: CardId[]

  /** Set only when the active face is a wild. `activeColor()` prefers the face's own colour. */
  declaredColor: Color | null

  /** The player whose UNO callout window is open, or null. Closes when the next action resolves. */
  unoWindow: PlayerId | null

  /**
   * Deck id → per-round opaque alias. The wire protocol speaks aliases, never deck ids.
   *
   * Without this, the inverted-information mechanic is worthless: a client that knows a card's id
   * and has read `deck.ts` (which is public, on GitHub) instantly knows both of its faces — so it
   * would know its own dark faces, which is exactly what the player is not allowed to see. The
   * alias is reshuffled from the seeded RNG at the start of every round, so it carries no
   * information about the card behind it. See `view.ts`.
   */
  alias: Record<CardId, string>

  roundNumber: number
  /** Monotonic; incremented once per accepted action. The client resyncs from it. */
  seq: number
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export type Action =
  | { type: 'startRound' }
  | { type: 'play'; player: PlayerId; card: CardId; declaredColor?: Color }
  | { type: 'draw'; player: PlayerId }
  | { type: 'pass'; player: PlayerId }
  | { type: 'chooseColor'; player: PlayerId; color: Color }
  | { type: 'challenge'; player: PlayerId }
  | { type: 'acceptDraw'; player: PlayerId }
  | { type: 'callUno'; player: PlayerId }
  | { type: 'callout'; player: PlayerId; target: PlayerId }

export type ActionType = Action['type']

// ---------------------------------------------------------------------------------------------
// Events — the wire format for "what just happened", and the client's animation script.
// ---------------------------------------------------------------------------------------------

/**
 * Some events carry private data (`cards` on a draw, `hand` on a challenge). They are emitted in
 * full and redacted per recipient by `view.ts` at the broadcast boundary — never assembled twice.
 */
export type GameEvent =
  | { t: 'roundStarted'; round: number; dealer: PlayerId; starter: PlayerId; opening: CardId }
  | { t: 'handsDealt'; count: number }
  | { t: 'cardPlayed'; player: PlayerId; card: CardId; declaredColor: Color | null }
  | { t: 'cardsDrawn'; player: PlayerId; count: number; cards: CardId[] }
  | { t: 'passed'; player: PlayerId }
  | { t: 'flipped'; side: Side; newTop: CardId }
  | { t: 'colorChosen'; player: PlayerId; color: Color }
  | { t: 'directionChanged'; direction: Direction }
  | { t: 'skipped'; player: PlayerId }
  | { t: 'skippedEveryone'; by: PlayerId }
  | { t: 'turnChanged'; player: PlayerId }
  | { t: 'unoCalled'; player: PlayerId }
  | { t: 'unoPenalty'; player: PlayerId; by: PlayerId; cards: number }
  | { t: 'calloutFailed'; player: PlayerId; target: PlayerId }
  | { t: 'challengeOpened'; challenger: PlayerId; accused: PlayerId; kind: 'wildDraw2' | 'wildDrawColor' }
  | {
      t: 'challenged'
      challenger: PlayerId
      accused: PlayerId
      guilty: boolean
      /** The accused's hand — visible to the challenger only. Redacted for everyone else. */
      revealed: CardId[]
    }
  | { t: 'drawAccepted'; player: PlayerId }
  | { t: 'reshuffled'; count: number }
  | { t: 'pilesExhausted' }
  | { t: 'roundEnded'; winner: PlayerId; points: number; scores: Array<{ player: PlayerId; score: number }> }
  | { t: 'gameEnded'; winner: PlayerId }

export type EventType = GameEvent['t']

// ---------------------------------------------------------------------------------------------
// Effects — the security boundary.
// ---------------------------------------------------------------------------------------------

/**
 * Rule hooks return effect *data*; only the trusted applier in `effects.ts` can touch state. This
 * union is therefore the interface a sandboxed rule pack gets to the world, and it is deliberately
 * closed and small. Widening it is a security decision, not a refactor.
 */
export type EffectTarget = 'current' | 'next' | 'allOthers' | 'all'

export type Effect =
  | { type: 'draw'; target: EffectTarget; n: number }
  | { type: 'drawUntilColor'; target: EffectTarget; color: Color | 'declared' }
  /** Advance the turn `n` extra times, on top of the normal single advance. */
  | { type: 'skip'; n: number }
  /** Every other player loses their turn; play returns to the player who acted. */
  | { type: 'skipEveryone' }
  | { type: 'reverse' }
  /** Discard pile inverts, draw pile inverts, hands show their other face. */
  | { type: 'flip' }
  | { type: 'setColor'; color: Color | 'declared' | null }
  /**
   * Give the turn to a specific seat, overriding the normal advance. This exists because the
   * opening Reverse means *"the dealer goes first"* — a turn that no amount of skipping can
   * express — and it generalizes to any pack that wants a "you play again" or "pass the turn to X"
   * card.
   */
  | { type: 'setTurn'; target: EffectTarget }
  /** Hand the draw to the challenge machinery instead of applying it now. */
  | { type: 'openChallenge'; kind: 'wildDraw2' | 'wildDrawColor' }

export type EffectType = Effect['type']

/**
 * A turn advance suspended mid-play, while the game waits on a player decision (a colour choice, a
 * challenge). Storing it in the phase — rather than recomputing it later — means the resumed turn
 * is the one the effects actually asked for, not one the reducer guessed at.
 */
export interface TurnResume {
  /** Seat of the player whose play is being resumed. */
  actor: number
  extraSkips: number
  forcedTurn: number | null
}

// ---------------------------------------------------------------------------------------------
// Reduction result
// ---------------------------------------------------------------------------------------------

export interface ReduceOk {
  ok: true
  state: GameState
  events: GameEvent[]
}

export interface ReduceErr {
  ok: false
  code: RuleErrorCode
  message: string
}

export type ReduceResult = ReduceOk | ReduceErr

export type RuleErrorCode =
  | 'not_your_turn'
  | 'wrong_phase'
  | 'unknown_card'
  | 'card_not_in_hand'
  | 'illegal_play'
  | 'color_required'
  | 'color_not_allowed'
  | 'bad_color_for_side'
  | 'not_drawn_card'
  | 'nothing_to_challenge'
  | 'uno_not_available'
  | 'callout_not_available'
  | 'game_over'
  | 'not_enough_players'
  | 'internal'

export class RuleError extends Error {
  constructor(
    readonly code: RuleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RuleError'
  }
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers over the card model
// ---------------------------------------------------------------------------------------------

export const LIGHT_COLORS = ['red', 'yellow', 'green', 'blue'] as const
export const DARK_COLORS = ['pink', 'teal', 'orange', 'purple'] as const

export const otherSide = (s: Side): Side => (s === 'light' ? 'dark' : 'light')

export const colorsFor = (side: Side): readonly Color[] => (side === 'light' ? LIGHT_COLORS : DARK_COLORS)

export const isWildKind = (f: Face): boolean =>
  f.kind === 'wild' || f.kind === 'wildDraw2' || f.kind === 'wildDrawColor'

export const isWildDrawKind = (f: Face): boolean => f.kind === 'wildDraw2' || f.kind === 'wildDrawColor'

/** Guard against a `Card` sneaking in with the wrong shape after a JSON round-trip. */
export const faceOf = (card: Card, side: Side): Face => card[side]
