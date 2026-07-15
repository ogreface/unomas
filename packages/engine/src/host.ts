/**
 * The in-process rule host.
 *
 * Every rule decision in the system routes through `RuleHost`, and this is the Stage-1 answer to
 * it: run the reducer right here. The interface is `async` even though nothing in this file is,
 * because in Stage 3 a `QuickJSRuleHost` will implement the same three methods by serializing the
 * state into a sandbox — and when it does, **nothing outside this file changes**. That is the only
 * reason the async-ness exists, and it is worth the mild awkwardness.
 */

import type { Action, Card, GameState, ReduceResult } from './types.js'
import { RuleError } from './types.js'
import type { NewGameSpec, RuleHost } from './rulepack.js'
import { getPack } from './rulepack.js'
import { createGame, reduce } from './reduce.js'

export class LocalRuleHost implements RuleHost {
  async createGame(spec: NewGameSpec): Promise<GameState> {
    return createGame(spec)
  }

  async reduce(state: GameState, action: Action): Promise<ReduceResult> {
    try {
      return reduce(state, action)
    } catch (err) {
      // A pack that throws must not take the room down with it. In Stage 1 the only pack is
      // trusted, so this is belt-and-braces; in Stage 3 it is the difference between one bad
      // custom card and every player in the room getting disconnected.
      if (err instanceof RuleError) return { ok: false, code: err.code, message: err.message }
      return {
        ok: false,
        code: 'internal',
        message: err instanceof Error ? err.message : 'rule pack threw',
      }
    }
  }

  async deck(packId: string): Promise<readonly Card[]> {
    return getPack(packId).buildDeck()
  }
}
