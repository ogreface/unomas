/**
 * A computer player.
 *
 * ## It plays from a `PlayerView`, not from `GameState`
 *
 * That single choice is the whole design. The bot is handed exactly the redacted view a human at
 * that seat would receive — its own active faces, its opponents' *inactive* faces, the draw pile's
 * peek, and `legalPlays` as computed by the pack. It has no handle on the hidden state, so it
 * **cannot** cheat, and no amount of later tinkering with its heuristics can make it start. It also
 * means a bot could one day run in the browser for offline practice with identical behaviour, since
 * a `PlayerView` is precisely what the client already holds.
 *
 * ## It is pure, like everything else in this package
 *
 * `decideBot` takes an `RngState` and returns the advanced one. No clock, no `Math.random`. The
 * caller (the Durable Object) owns persisting that state, so a bot's coin-flips are as replayable
 * as the deal is.
 *
 * ## It returns *one* intent at a time
 *
 * Declaring UNO and then playing your second-to-last card are two actions, and the bot returns the
 * first, is asked again, and returns the second. The driver loop stays trivial and every bot move
 * goes through the same validate → reduce → broadcast path a human's does.
 *
 * The heuristics below are deliberately shallow — this is a house opponent, not an engine. What it
 * does do is play *legally*, keep the game moving, punish a forgotten UNO, and lean on you when you
 * are close to going out.
 */

import type { Color, Face, PlayerId, RngState } from './types.js'
import { colorsFor, isWildKind } from './types.js'
import { nextInt } from './rng.js'
import type { CardView, PlayerSummaryView, PlayerView } from './view.js'

export const BOT_DIFFICULTIES = ['easy', 'normal'] as const
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number]

/**
 * What the bot wants to do. Structurally identical to the game-action half of the client protocol,
 * so the Durable Object routes it through exactly the same builder a human's message takes.
 */
export type BotIntent =
  | { t: 'play'; key: string; declaredColor?: Color }
  | { t: 'draw' }
  | { t: 'pass' }
  | { t: 'chooseColor'; color: Color }
  | { t: 'challenge' }
  | { t: 'acceptDraw' }
  | { t: 'callUno' }
  | { t: 'callout'; target: PlayerId }

export interface BotDecision {
  /** `null` means "nothing for me to do right now" — the common case on someone else's turn. */
  intent: BotIntent | null
  /** Always advanced past any coin-flips taken, whether or not an intent came out. Persist it. */
  rng: RngState
}

interface Profile {
  /** % chance of remembering to declare UNO. A bot that never forgets is no fun to catch out. */
  unoDiscipline: number
  /** % chance of catching an opponent who is one card down and forgot to say it. */
  vigilance: number
  /** Weigh the legal plays, rather than picking one at random. */
  playsWell: boolean
  /** Declare the colour it holds most of, rather than any legal colour. */
  picksColorWell: boolean
  /** Whether it ever challenges a wild-draw at all. */
  challenges: boolean
  /** Base % chance of a challenge, before the accused's hand size is taken into account. */
  challengeBase: number
}

const PROFILES: Record<BotDifficulty, Profile> = {
  easy: {
    unoDiscipline: 50,
    vigilance: 0,
    playsWell: false,
    picksColorWell: false,
    challenges: false,
    challengeBase: 0,
  },
  normal: {
    unoDiscipline: 100,
    vigilance: 90,
    playsWell: true,
    picksColorWell: true,
    challenges: true,
    challengeBase: 15,
  },
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/**
 * What this bot wants to do, given only what it is allowed to see.
 *
 * The order below is the order of priority, and two of the branches fire on turns that are not the
 * bot's own: catching a forgotten UNO, and rescuing its own. Everything after that is the ordinary
 * "whose decision is this?" question, answered from the phase.
 */
export function decideBot(
  view: PlayerView,
  rng: RngState,
  difficulty: BotDifficulty = 'normal',
): BotDecision {
  const profile = PROFILES[difficulty] ?? PROFILES.normal
  const me = view.players.find(p => p.id === view.you)
  if (!me) return { intent: null, rng }

  let state = rng

  // ── 1. Catch someone out. Free cards, and it can happen on anyone's turn. ──────────────────
  const caught = calloutTarget(view)
  if (caught) {
    const [yes, next] = chance(state, profile.vigilance)
    state = next
    if (yes) return { intent: { t: 'callout', target: caught.id }, rng: state }
  }

  // ── 2. Rescue your own forgotten UNO before anyone else notices. ───────────────────────────
  if (view.unoWindow === view.you && me.handCount === 1 && !me.saidUno) {
    const [yes, next] = chance(state, profile.unoDiscipline)
    state = next
    if (yes) return { intent: { t: 'callUno' }, rng: state }
  }

  // ── 3. Whatever the phase is actually waiting on this bot for. ─────────────────────────────
  const phase = view.phase

  if (phase.t === 'awaitingColorChoice' && phase.chooser === view.you) {
    const [color, next] = pickColor(view, state, profile)
    return { intent: { t: 'chooseColor', color }, rng: next }
  }

  if (phase.t === 'awaitingChallenge' && phase.challenger === view.you) {
    return decideChallenge(view, state, profile, phase.kind, phase.priorColor, phase.accused)
  }

  const myTurn = view.turn === view.you

  if (phase.t === 'awaitingDrawnCardChoice' && myTurn) {
    // Exactly one card is playable here — the one just drawn — or nothing is.
    if (!view.legalPlays.includes(phase.card)) return { intent: { t: 'pass' }, rng: state }
    const uno = declareUno(me, state, profile)
    state = uno.rng
    if (uno.declare) return { intent: { t: 'callUno' }, rng: state }
    return playCard(view, phase.card, state, profile)
  }

  if (phase.t === 'awaitingPlay' && myTurn) {
    if (view.legalPlays.length === 0) return { intent: { t: 'draw' }, rng: state }
    const uno = declareUno(me, state, profile)
    state = uno.rng
    if (uno.declare) return { intent: { t: 'callUno' }, rng: state }
    const [card, next] = choosePlay(view, state, profile)
    return playCard(view, card.key, next, profile)
  }

  return { intent: null, rng: state }
}

/** The opponent who is one card down, hasn't said it, and is therefore free money. */
function calloutTarget(view: PlayerView): PlayerSummaryView | null {
  if (view.unoWindow === null || view.unoWindow === view.you) return null
  const target = view.players.find(p => p.id === view.unoWindow)
  if (!target || target.saidUno || target.handCount !== 1) return null
  return target
}

/**
 * *"UNO!"*, said on your own turn while holding two — because the card you are about to play takes
 * you to one. A bot that skips this is a bot the table gets to punish, which is the point of the
 * `unoDiscipline` dial.
 *
 * Returns the advanced RNG whether or not it fired, so a refused roll is still spent and the bot
 * does not get a fresh coin-flip on the very next tick.
 */
function declareUno(
  me: PlayerSummaryView,
  rng: RngState,
  profile: Profile,
): { declare: boolean; rng: RngState } {
  if (me.handCount !== 2 || me.saidUno) return { declare: false, rng }
  const [yes, next] = chance(rng, profile.unoDiscipline)
  return { declare: yes, rng: next }
}

/** Turn a chosen card into a `play` intent, naming a colour if the face is a wild. */
function playCard(view: PlayerView, key: string, rng: RngState, profile: Profile): BotDecision {
  const card = view.hand.find(c => c.key === key)
  if (!card) return { intent: { t: 'draw' }, rng }
  if (card.face.color !== null) return { intent: { t: 'play', key }, rng }
  const [color, next] = pickColor(view, rng, profile)
  return { intent: { t: 'play', key, declaredColor: color }, rng: next }
}

// ---------------------------------------------------------------------------------------------
// Choosing a card
// ---------------------------------------------------------------------------------------------

/** Mattel's scoring table, as the bot's estimate of what a card costs to be caught holding. */
const SHED_VALUE: Record<string, number> = {
  draw1: 10,
  draw5: 20,
  skip: 20,
  skipEveryone: 30,
  reverse: 20,
  flip: 20,
}

/**
 * How keen the bot is to burn a wild when something else would do. The *stronger* the wild the
 * lower the number: a Wild Draw Color you are still holding is a turn you can always take and a
 * punishment you can always land, and spending it on a quiet turn throws both away.
 */
const WILD_URGE: Record<string, number> = { wild: 6, wildDraw2: 4, wildDrawColor: 3 }

/**
 * What a wild is worth instead when the next player is nearly out — a *separate* table, because the
 * ordering inverts. `WILD_URGE` ranks a plain Wild highest precisely because it is the one that
 * costs nothing to spend; under pressure that makes it the one card you least want to play, since
 * it is the only wild that does not punish the player it lands on. A flat bonus on top of
 * `WILD_URGE` would carry the quiet-turn ordering over intact and play them in exactly the wrong
 * order, so the pressure case names its own numbers.
 */
const WILD_PRESSURE: Record<string, number> = { wild: 0, wildDraw2: 90, wildDrawColor: 100 }

/** Cards that cost the next player something. Worth a lot more when they are about to go out. */
const AGGRESSIVE: readonly string[] = ['draw1', 'draw5', 'skip', 'skipEveryone']

function choosePlay(view: PlayerView, rng: RngState, profile: Profile): [CardView, RngState] {
  const legal = view.hand.filter(c => view.legalPlays.includes(c.key))
  // `decideBot` only calls this with a non-empty `legalPlays`, and every key in it came from this
  // same hand — but fall back rather than throw if a pack ever produces a key we can't find.
  if (legal.length === 0) return [view.hand[0] as CardView, rng]
  if (!profile.playsWell) return pickOne(legal, rng)

  const pressure = nextHandCount(view) <= 2
  const counts = colorCounts(view)

  let best = -Infinity
  const top: CardView[] = []
  for (const card of legal) {
    const score = scoreCard(card.face, counts, pressure)
    if (score > best) {
      best = score
      top.length = 0
      top.push(card)
    } else if (score === best) {
      top.push(card)
    }
  }
  return pickOne(top, rng)
}

/**
 * How much the bot wants to play this face right now. Three ideas, in order of weight:
 *
 * 1. **Land a punisher when it hurts.** A Draw Five into a player holding two cards is the single
 *    best move on the board; the same card into a full hand is just a card.
 * 2. **Shed points.** You are scored on what you are still holding when someone goes out, so all
 *    else equal the expensive card goes first.
 * 3. **Stay in your strong colour**, so the next turn has options.
 *
 * Wilds invert (1) and (2): they are the escape hatch that stops you drawing on a dead turn, so
 * their value is heavily discounted unless they are landing a draw on someone who is nearly out.
 * Note "landing a draw" is the whole of it — a plain Wild punishes nobody, so pressure is not a
 * reason to spend one, and it keeps its quiet-turn score.
 */
function scoreCard(face: Face, counts: Record<string, number>, pressure: boolean): number {
  if (isWildKind(face)) {
    const urge = WILD_URGE[face.kind] ?? 5
    // `max`, so pressure can only ever make a wild *more* attractive — a plain Wild simply keeps
    // its quiet-turn score and goes on losing to anything that actually costs the victim a card.
    return pressure ? Math.max(urge, WILD_PRESSURE[face.kind] ?? 0) : urge
  }

  let score = face.kind === 'number' ? (face.value ?? 0) : (SHED_VALUE[face.kind] ?? 15)
  if (AGGRESSIVE.includes(face.kind)) score += pressure ? 45 : 10
  if (face.color) score += (counts[face.color] ?? 0) * 3
  return score
}

/** How many cards the player who acts next is holding. Public information; no peeking involved. */
function nextHandCount(view: PlayerView): number {
  const n = view.players.length
  const me = view.players.find(p => p.id === view.you)
  if (!me || n === 0) return 99
  const seat = (((me.seat + view.direction) % n) + n) % n
  return view.players.find(p => p.seat === seat)?.handCount ?? 99
}

function colorCounts(view: PlayerView): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const card of view.hand) {
    if (card.face.color) counts[card.face.color] = (counts[card.face.color] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------------------------
// Choosing a colour
// ---------------------------------------------------------------------------------------------

/** The colour the bot holds most of on the active side — or, for an easy bot, any legal one. */
function pickColor(view: PlayerView, rng: RngState, profile: Profile): [Color, RngState] {
  const legal = colorsFor(view.side)
  if (!profile.picksColorWell) return pickOne(legal, rng)

  const counts = colorCounts(view)
  let best = -1
  const top: Color[] = []
  for (const color of legal) {
    const n = counts[color] ?? 0
    if (n > best) {
      best = n
      top.length = 0
      top.push(color)
    } else if (n === best) {
      top.push(color)
    }
  }
  return pickOne(top, rng)
}

// ---------------------------------------------------------------------------------------------
// Challenging
// ---------------------------------------------------------------------------------------------

/**
 * *"Did they really have nothing else?"*
 *
 * The bot cannot see the accused's active faces, so it has one honest signal: how many cards they
 * are holding. The more they hold, the likelier one of them matched the colour that was live before
 * they played — so the likelier the challenge sticks. A Wild Draw Color is worth more risk than a
 * Wild Draw Two, because taking it is far worse than losing the challenge.
 */
function decideChallenge(
  view: PlayerView,
  rng: RngState,
  profile: Profile,
  kind: 'wildDraw2' | 'wildDrawColor',
  priorColor: Color | null,
  accusedId: PlayerId,
): BotDecision {
  // With no colour live before the play there is nothing they could have matched: guilt is
  // impossible and a challenge is a guaranteed loss.
  if (!profile.challenges || priorColor === null) return { intent: { t: 'acceptDraw' }, rng }

  const held = view.players.find(p => p.id === accusedId)?.handCount ?? 0
  const odds = clamp(profile.challengeBase + held * 7 + (kind === 'wildDrawColor' ? 20 : 0), 0, 80)
  const [yes, next] = chance(rng, odds)
  return { intent: yes ? { t: 'challenge' } : { t: 'acceptDraw' }, rng: next }
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

function pickOne<T>(items: readonly T[], rng: RngState): [T, RngState] {
  if (items.length === 1) return [items[0] as T, rng]
  const [i, next] = nextInt(rng, items.length)
  return [items[i] as T, next]
}

/** A percentage coin-flip. 0 never fires, 100 always does, and neither wastes an RNG draw. */
function chance(rng: RngState, percent: number): [boolean, RngState] {
  if (percent <= 0) return [false, rng]
  if (percent >= 100) return [true, rng]
  const [roll, next] = nextInt(rng, 100)
  return [roll < percent, next]
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
