import type { EventView } from '@flipside/engine'
import type { GameLog, LogBatch } from '@flipside/protocol'

/**
 * Fold a snapshot's game log into the one this screen already holds.
 *
 * The room sends only the actions after `after` — the `lastSeq` this screen joined with — so keep
 * everything up to there and take the rest from the room. Anything local past `after` is dropped
 * rather than kept, because the room's copy includes it: that is what stops a batch heard live
 * while the snapshot was on its way from appearing twice. `after` of 0 is the whole game.
 *
 * A snapshot without a log (a server older than this client, mid-deploy) changes nothing.
 */
export function mergeSnapshotLog(local: LogBatch[], log: GameLog | undefined): LogBatch[] {
  if (!log) return local
  if (log.after === 0) return log.batches
  return [...local.filter(batch => batch.seq <= log.after), ...log.batches]
}

/** Add one action's events, as heard live. */
export function appendToLog(local: LogBatch[], seq: number, events: EventView[]): LogBatch[] {
  if (events.length === 0) return local
  const last = local[local.length - 1]
  if (last && last.seq >= seq) return local
  return [...local, { seq, events }]
}
