import { describe, expect, it } from 'vitest'
import type { EventView } from '@flipside/engine'
import type { LogBatch } from '@flipside/protocol'
import { appendToLog, mergeSnapshotLog } from './gameLog.js'

const passed = (player: string): EventView => ({ t: 'passed', player })
const batch = (seq: number, player = `p${seq}`): LogBatch => ({ seq, events: [passed(player)] })

describe('mergeSnapshotLog', () => {
  it('replaces the whole log when the room sends the whole game', () => {
    const local = [batch(1, 'stale'), batch(2, 'stale')]
    const merged = mergeSnapshotLog(local, { after: 0, batches: [batch(1), batch(2), batch(3)] })
    expect(merged).toEqual([batch(1), batch(2), batch(3)])
  })

  it('keeps what this screen already had and adds only what it missed', () => {
    const local = [batch(1), batch(2)]
    const merged = mergeSnapshotLog(local, { after: 2, batches: [batch(3), batch(4)] })
    expect(merged).toEqual([batch(1), batch(2), batch(3), batch(4)])
  })

  it('never doubles a batch that arrived live while the snapshot was on its way', () => {
    // The screen asked from 2, then heard 3 live; the snapshot it gets back carries 3 again.
    const local = [batch(1), batch(2), batch(3)]
    const merged = mergeSnapshotLog(local, { after: 2, batches: [batch(3), batch(4)] })
    expect(merged).toEqual([batch(1), batch(2), batch(3), batch(4)])
  })

  it('keeps the log it has when a snapshot arrives without one', () => {
    const local = [batch(1), batch(2)]
    expect(mergeSnapshotLog(local, undefined)).toBe(local)
  })
})

describe('appendToLog', () => {
  it('adds one action’s events as a batch', () => {
    expect(appendToLog([batch(1)], 2, [passed('p2')])).toEqual([batch(1), batch(2)])
  })

  it('ignores an action that produced nothing to narrate', () => {
    const local = [batch(1)]
    expect(appendToLog(local, 2, [])).toBe(local)
  })

  it('ignores a batch the log already holds', () => {
    const local = [batch(1), batch(2)]
    expect(appendToLog(local, 2, [passed('p2')])).toBe(local)
  })
})
