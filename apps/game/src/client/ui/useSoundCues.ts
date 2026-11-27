import { useEffect, useRef } from 'react'
import type { PlayerView } from '@flipside/engine'
import { clockCues, gameCues } from '../lib/cues.js'
import type { ClockMemory } from '../lib/cues.js'
import { playCues } from '../lib/sound.js'
import type { FeedEvent } from '../net/useRoom.js'
import type { ClockReading } from './TurnClock.js'

/**
 * Play the board's sounds. All of the deciding is in `lib/cues.ts`; this only feeds it each new view,
 * each event it has not heard yet, and each reading of the clock, and remembers what it fed it last.
 *
 * Mounted with the board, so the first view it sees has nothing before it — which is exactly the
 * first deal, when "you lead" deserves the turn chime.
 */
export function useSoundCues(view: PlayerView, feed: readonly FeedEvent[], clock: ClockReading | null): void {
  const prevView = useRef<PlayerView | null>(null)
  const heardUpTo = useRef(-1)

  useEffect(() => {
    // Feed ids are monotonic, so "after the last one heard" survives the feed's rolling window.
    const fresh = feed.filter(f => f.id > heardUpTo.current).map(f => f.event)
    heardUpTo.current = feed[feed.length - 1]?.id ?? heardUpTo.current
    const prev = prevView.current
    prevView.current = view
    playCues(gameCues(prev, view, fresh))
  }, [view, feed])

  const memory = useRef<ClockMemory | null>(null)
  // Keyed on the readings themselves, not the clock object: it is rebuilt five times a second.
  const player = clock?.timer.player ?? null
  const phase = clock?.timer.phase ?? null
  const seconds = clock?.seconds ?? null

  useEffect(() => {
    const sample = player !== null && phase !== null && seconds !== null ? { player, phase, seconds } : null
    const out = clockCues(memory.current, sample, view.you)
    memory.current = out.memory
    playCues(out.cues)
  }, [player, phase, seconds, view.you])
}
