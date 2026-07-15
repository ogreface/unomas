/**
 * Official UNO FLIP! — as a rule pack.
 *
 * This file is the *only* place in the engine that knows what a "Skip Everyone" is. The reducer
 * knows about `Effect`s and phases; it does not know about Uno. That separation is what makes
 * Stage 3 a swap rather than a rewrite.
 *
 * Rules source: Mattel GDR44 (docs/research/rules-spec.md). Ambiguities: docs/decisions.md.
 */

import { DECK } from '../../data/deck.js'
import type { OpeningPolicy, PlayEffectContext, PlayabilityContext, RulePack } from '../../rulepack.js'
import type { Card, Color, Effect, Face, RuleOptions, Side } from '../../types.js'
import { DARK_COLORS, DEFAULT_OPTIONS, LIGHT_COLORS, isWildKind } from '../../types.js'

export const UNOFLIP_PACK_ID = 'unoflip'

/** Mattel GDR44, §Scoring. Both sides in one table. */
const CARD_VALUES: Record<string, number> = {
  draw1: 10,
  draw5: 20,
  reverse: 20,
  skip: 20,
  skipEveryone: 30,
  flip: 20,
  wild: 40,
  wildDraw2: 50,
  wildDrawColor: 60,
}

/**
 * *"may only be played on a matching color or on another [same-type] card."*
 *
 * The restriction is repeated on every colored action card, and it is stricter than most people
 * play it: symbol matching is **type-for-type**. A Skip does not go on a Reverse.
 */
function isPlayable(ctx: PlayabilityContext): boolean {
  const { face, activeFace, activeColor } = ctx

  // Wilds are always playable. Wild Draw Two / Wild Draw Color are *not* hard-blocked by the
  // "no other matching colour" restriction — that is what the challenge exists to police (D7).
  if (isWildKind(face)) return true

  if (activeColor !== null && face.color === activeColor) return true

  if (face.kind === 'number' && activeFace.kind === 'number') {
    return face.value === activeFace.value
  }

  // Type-for-type. Note a coloured card can never match a wild active face by symbol, because
  // `isWildKind(face)` returned false above — so this cannot accidentally let a Skip onto a Wild.
  return face.kind === activeFace.kind
}

function requiresColorChoice(face: Face): boolean {
  return isWildKind(face)
}

function effectsForPlay(ctx: PlayEffectContext): Effect[] {
  const { face, options, playerCount } = ctx

  switch (face.kind) {
    case 'number':
      return []

    case 'draw1':
      return [
        { type: 'draw', target: 'next', n: 1 },
        { type: 'skip', n: 1 },
      ]

    case 'draw5':
      return [
        { type: 'draw', target: 'next', n: 5 },
        { type: 'skip', n: 1 },
      ]

    case 'skip':
      return [{ type: 'skip', n: 1 }]

    case 'skipEveryone':
      // "Play returns to whoever played the card" — they take another turn. With two players this
      // degenerates to a plain Skip, which is the right answer and needs no special case (D14).
      return [{ type: 'skipEveryone' }]

    case 'reverse':
      // Mattel's sheet has no two-player section at all, so a literal reading makes this a no-op.
      // Nobody expects that. Default: acts as Skip (D6).
      return playerCount === 2 && options.twoPlayerReverseActsAsSkip
        ? [{ type: 'reverse' }, { type: 'skip', n: 1 }]
        : [{ type: 'reverse' }]

    case 'flip':
      return [{ type: 'flip' }]

    case 'wild':
      return [{ type: 'setColor', color: 'declared' }]

    case 'wildDraw2':
      return options.challengesEnabled
        ? [{ type: 'setColor', color: 'declared' }, { type: 'openChallenge', kind: 'wildDraw2' }]
        : [
            { type: 'setColor', color: 'declared' },
            { type: 'draw', target: 'next', n: 2 },
            { type: 'skip', n: 1 },
          ]

    case 'wildDrawColor':
      return options.challengesEnabled
        ? [{ type: 'setColor', color: 'declared' }, { type: 'openChallenge', kind: 'wildDrawColor' }]
        : [
            { type: 'setColor', color: 'declared' },
            { type: 'drawUntilColor', target: 'next', color: 'declared' },
            { type: 'skip', n: 1 },
          ]

    default: {
      const never: never = face.kind
      throw new Error(`unoflip: no effects defined for kind "${String(never)}"`)
    }
  }
}

/**
 * The opening discard. GDR44 gives a rule for every card *except* Flip — see D2.
 */
function openingPolicy(face: Face): OpeningPolicy {
  switch (face.kind) {
    case 'wildDraw2':
    case 'wildDrawColor':
      // Mattel: "Return it to the deck and pick another card."
      return { t: 'redraw' }

    case 'flip':
      // 🔴 Unspecified by Mattel. We borrow their own escape hatch (D2): return it and draw again.
      // The alternative — flipping the pile when the pile is one card — is degenerate: the Flip
      // card would immediately become the active card again, on its other face, which is a rule
      // that reads as a bug to every player who sees it.
      return { t: 'redraw' }

    case 'wild':
      // "Player to the left of the dealer chooses the color."
      return { t: 'chooseColor' }

    // An opening card was played by nobody, so the reducer runs these effects with the **dealer**
    // as the actor: `next` is the player to their left, and the normal single turn-advance from
    // the dealer lands on that same player. Read every target below with that in mind.

    case 'draw1':
      return { t: 'accept', effects: [{ type: 'draw', target: 'next', n: 1 }, { type: 'skip', n: 1 }] }

    case 'draw5':
      return { t: 'accept', effects: [{ type: 'draw', target: 'next', n: 5 }, { type: 'skip', n: 1 }] }

    case 'skip':
      // "The player to the left of the dealer is skipped."
      return { t: 'accept', effects: [{ type: 'skip', n: 1 }] }

    case 'skipEveryone':
      // Nobody played it, so there is no "play returns to whoever played the card" to honour. The
      // nearest sane reading is a plain Skip of the starting player.
      return { t: 'accept', effects: [{ type: 'skip', n: 1 }] }

    case 'reverse':
      // "The dealer goes first, and play then moves to the right."
      //
      // "The dealer goes first" is a turn no amount of skipping can express — reversing and
      // advancing one from the dealer lands on the dealer's *right*, not on the dealer. This is
      // the reason `setTurn` exists in the Effect union.
      return { t: 'accept', effects: [{ type: 'reverse' }, { type: 'setTurn', target: 'current' }] }

    case 'number':
      return { t: 'accept', effects: [] }

    default: {
      const never: never = face.kind
      throw new Error(`unoflip: no opening policy for kind "${String(never)}"`)
    }
  }
}

function cardValue(face: Face): number {
  if (face.kind === 'number') return face.value ?? 0
  const v = CARD_VALUES[face.kind]
  if (v === undefined) throw new Error(`unoflip: no score value for kind "${face.kind}"`)
  return v
}

export const unoflipPack: RulePack = {
  id: UNOFLIP_PACK_ID,
  version: 1,
  name: 'Uno Flip (official)',

  buildDeck(): readonly Card[] {
    return DECK
  },

  defaultOptions(): RuleOptions {
    return { ...DEFAULT_OPTIONS }
  },

  colorsFor(side: Side): readonly Color[] {
    return side === 'light' ? LIGHT_COLORS : DARK_COLORS
  },

  isPlayable,
  requiresColorChoice,
  effectsForPlay,
  openingPolicy,
  cardValue,

  isGameWon(score: number, options: RuleOptions): boolean {
    return score >= options.scoreLimit
  },
}
