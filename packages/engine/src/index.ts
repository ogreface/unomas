/**
 * @flipside/engine — a pure, dependency-free rules engine.
 *
 * Importing this module registers the official Uno Flip rule pack. That is the *only* privileged
 * thing about it: it goes through `registerPack` like any pack will.
 */

import { registerPack } from './rulepack.js'
import { unoflipPack } from './packs/unoflip/index.js'

registerPack(unoflipPack)

export { UNOFLIP_PACK_ID, unoflipPack } from './packs/unoflip/index.js'

export * from './types.js'
export { seedRng, nextInt, nextUint32, shuffle } from './rng.js'
export type { RngState } from './rng.js'

export { createGame, reduce, assertCardConservation, assertStateInvariants } from './reduce.js'
export type { CreateGameSpec } from './reduce.js'

export {
  activeColor,
  activeFace,
  cardOf,
  faceOn,
  topCardId,
  playerIndex,
  currentPlayer,
  seatAfter,
} from './effects.js'

export { handValue, roundPoints } from './score.js'

export { LocalRuleHost } from './host.js'

export {
  registerPack,
  getPack,
  knownPacks,
  cardIndex,
} from './rulepack.js'
export type {
  NewGameSpec,
  OpeningPolicy,
  PlayEffectContext,
  PlayabilityContext,
  RuleHost,
  RulePack,
} from './rulepack.js'

export {
  viewFor,
  tableView,
  redactEvent,
  redactEvents,
  keyOf,
  cardIdForKey,
} from './view.js'
export type { CardView, EventView, PhaseView, PlayerSummaryView, PlayerView, TableView } from './view.js'

export { DECK, CARDS_BY_ID } from './data/deck.js'
