/**
 * The rule-pack interface.
 *
 * This is the whole bet of the project: official Uno Flip is not special-cased anywhere in the
 * reducer — it is a *pack* (`packs/unoflip`) that implements exactly the interface a user's custom
 * pack will implement in Stage 3. If the reducer ever grows a branch that says "if this is the
 * official pack…", the bet has been lost.
 *
 * Two rules keep the interface sandbox-ready:
 *
 * - Hooks are **pure and synchronous** and receive a **frozen** view. They may not touch state.
 * - Hooks return **effect data**, never mutations. `Effect` is the security boundary.
 *
 * `RuleHost` is the single call site every rule decision routes through, and it is **async** —
 * even though `LocalRuleHost` is trivially synchronous. That async-ness is the entire point: in
 * Stage 3 a `QuickJSRuleHost` slots in behind the same signature and nothing else in the codebase
 * changes.
 */

import type {
  Action,
  Card,
  CardId,
  Color,
  Effect,
  Face,
  GameState,
  PlayerId,
  ReduceResult,
  RngState,
  RuleOptions,
  Side,
} from './types.js'

/** What a pack is shown when asked "is this play legal?". Frozen; no state handle. */
export interface PlayabilityContext {
  readonly side: Side
  readonly options: RuleOptions
  /** The face of the card being played, on the current side. */
  readonly face: Face
  /** The face currently showing on top of the discard pile. */
  readonly activeFace: Face
  /** `activeFace.color`, or the declared colour when the active face is a wild. */
  readonly activeColor: Color | null
}

/** What a pack is shown when asked "what does playing this card do?". Frozen; no state handle. */
export interface PlayEffectContext extends PlayabilityContext {
  readonly player: PlayerId
  readonly playerCount: number
  /** The colour the player declared, when the face is a wild. */
  readonly declaredColor: Color | null
}

/** How a card behaves when it is turned up as the round's opening discard. */
export type OpeningPolicy =
  /** Use it, applying `effects` before the first turn (`[]` for a plain number card). */
  | { t: 'accept'; effects: Effect[] }
  /** Return it to the deck, reshuffle, and turn another. (Wild Draw Two; and — our call — Flip.) */
  | { t: 'redraw' }
  /** Use it, but the starting player must name a colour before play begins. */
  | { t: 'chooseColor' }

export interface RulePack {
  readonly id: string
  readonly version: number
  readonly name: string

  /** The full deck, in canonical order. The reducer shuffles it; the pack must not. */
  buildDeck(): readonly Card[]

  defaultOptions(): RuleOptions

  /** Legal colours to declare on this side. */
  colorsFor(side: Side): readonly Color[]

  /** May `ctx.face` be played onto `ctx.activeFace` right now? */
  isPlayable(ctx: PlayabilityContext): boolean

  /** Does playing this face require the player to declare a colour? */
  requiresColorChoice(face: Face): boolean

  /** What playing this face does. Returned as data; applied by the trusted applier. */
  effectsForPlay(ctx: PlayEffectContext): Effect[]

  /** How this face behaves as the opening discard. */
  openingPolicy(face: Face): OpeningPolicy

  /** Points this face is worth in an opponent's hand at round end. */
  cardValue(face: Face): number

  /** Has this player won the game? (Called after each round is scored.) */
  isGameWon(score: number, options: RuleOptions): boolean
}

// ---------------------------------------------------------------------------------------------
// RuleHost — the one call site
// ---------------------------------------------------------------------------------------------

export interface NewGameSpec {
  packId: string
  players: Array<{ id: PlayerId; name: string }>
  seed: string
  options?: Partial<RuleOptions>
}

/**
 * Async by design. Stage 1 answers in-process; Stage 3 answers from inside a QuickJS sandbox.
 * Callers may not care which, and that is the point.
 */
export interface RuleHost {
  createGame(spec: NewGameSpec): Promise<GameState>
  reduce(state: GameState, action: Action): Promise<ReduceResult>
  /** The pack's deck, for rendering. Read-only; the client needs the light↔dark bijection. */
  deck(packId: string): Promise<readonly Card[]>
}

// ---------------------------------------------------------------------------------------------
// The pack registry
// ---------------------------------------------------------------------------------------------

const REGISTRY: Record<string, RulePack> = {}

export function registerPack(pack: RulePack): void {
  REGISTRY[pack.id] = pack
}

export function getPack(id: string): RulePack {
  const pack = REGISTRY[id]
  if (!pack) throw new Error(`unknown rule pack: "${id}" (registered: ${Object.keys(REGISTRY).join(', ') || 'none'})`)
  return pack
}

export function knownPacks(): string[] {
  return Object.keys(REGISTRY).sort()
}

/** Card lookup for a pack's deck. Built once per pack, not per reduction. */
const CARD_INDEX: Record<string, Record<CardId, Card>> = {}

export function cardIndex(pack: RulePack): Record<CardId, Card> {
  const cached = CARD_INDEX[pack.id]
  if (cached) return cached
  const index: Record<CardId, Card> = {}
  for (const card of pack.buildDeck()) index[card.id] = card
  CARD_INDEX[pack.id] = index
  return index
}

export type { RngState }
