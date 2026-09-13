/**
 * The turn clock, server side.
 *
 * The engine's half (what a forfeited decision costs) is tested in
 * `packages/engine/test/timeout.test.ts`. This file is about the parts only `workerd` can tell us:
 * that the deadline is stored rather than held in a field, that the alarm survives the object being
 * evicted mid-turn, that an at-least-once duplicate delivery cannot take two turns from a player,
 * and that every screen — player and projector — is told how long is left.
 */

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { GameState } from '@flipside/engine'
import { Client, autoMove, owes, stubFor } from './helpers.js'
import type { RoomStub } from './helpers.js'

async function seatTwoAndStart(code: string): Promise<{ stub: RoomStub; a: Client; b: Client }> {
  const stub = stubFor(code)
  await stub.createRoom(code)

  const a = await Client.connect(stub, code)
  a.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
  await a.waitFor('welcome')
  await a.waitFor('roster')

  const b = await Client.connect(stub, code)
  b.send({ t: 'join', clientId: 'client-b', nickname: 'Bo' })
  await b.waitFor('welcome')
  await b.waitFor('roster')
  await a.waitFor('roster')

  a.send({ t: 'start' })
  await a.waitFor('events')
  await b.waitFor('events')
  return { stub, a, b }
}

interface ClockRow {
  player: string
  phase: string
  duration: number
  deadline: number
}

/** Read the stored clock straight out of the room's SQLite — it must not live in a class field. */
async function readClock(stub: RoomStub): Promise<ClockRow | null> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const rows = ctx.storage.sql
      .exec('SELECT player, phase, duration, deadline FROM turn_clock WHERE id = 0')
      .toArray() as unknown as ClockRow[]
    return rows[0] ?? null
  })
}

async function readState(stub: RoomStub): Promise<GameState> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as
      | { state: string }
      | undefined
    if (!row) throw new Error('no snapshot')
    return JSON.parse(row.state) as GameState
  })
}

/**
 * Deliver an alarm by hand, the way an at-least-once duplicate or an early wake arrives — as opposed
 * to `runDurableObjectAlarm`, which only fires an alarm that is actually scheduled and due.
 */
async function deliverAlarm(stub: RoomStub): Promise<void> {
  await runInDurableObject(stub, async instance => {
    if (!instance.alarm) throw new Error('the room has no alarm handler')
    await instance.alarm()
  })
}

/** Wind the stored deadline back into the past, so the next alarm delivery is genuinely overdue. */
async function expireClock(stub: RoomStub): Promise<void> {
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE turn_clock SET deadline = ? WHERE id = 0', Date.now() - 1)
  })
}

describe('GameRoom — the turn clock', () => {
  it('starts a 30-second clock on the player who owes the first play, and says so to everyone', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK1')

    const clock = await readClock(stub)
    expect(clock).not.toBeNull()
    expect(clock?.duration).toBe(30_000)
    expect(clock?.player).toBe(owes(a.latestView!))

    // Both players are told the same countdown — the *whole table* can see it, not just whoever is
    // on the clock.
    for (const c of [a, b]) {
      c.send({ t: 'resync', lastSeq: 0 })
      const sync = await c.waitFor('sync')
      expect(sync.timer?.player).toBe(clock?.player)
      expect(sync.timer?.durationMs).toBe(30_000)
      expect(sync.timer?.remainingMs).toBeGreaterThan(25_000)
      expect(sync.timer?.remainingMs).toBeLessThanOrEqual(30_000)
      expect(sync.timer?.phase).toBe(sync.view.phase.t)
    }
  })

  it('projects the countdown to a spectator screen too', async () => {
    const { stub } = await seatTwoAndStart('CLK2')

    const s = await Client.connect(stub, 'CLK2')
    s.send({ t: 'join', clientId: 'client-spec', nickname: 'Screen', role: 'spectator' })
    await s.waitFor('welcome')
    const tableSync = await s.waitFor('tableSync')

    expect(tableSync.timer).not.toBeNull()
    expect(tableSync.timer?.durationMs).toBe(30_000)
    expect(tableSync.timer?.player).toBe(tableSync.table.turn)
  })

  it('restarts the window on the next decision, and does not let an old one carry over', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK3')

    const first = await readClock(stub)
    await expireClock(stub) // pretend the first player dithered for the full 30s
    await autoMove([a, b]) // …but acted just in time

    const second = await readClock(stub)
    expect(second).not.toBeNull()
    // A fresh decision, a fresh 30 seconds — the successor is not handed the remains of the old clock.
    expect(second?.deadline).toBeGreaterThan(first?.deadline ?? 0)
    expect(second?.deadline).toBeGreaterThan(Date.now() + 25_000)
  })

  it('forfeits the turn when the alarm fires, and tells every client why', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK4')

    const clock = await readClock(stub)
    const victim = clock!.player
    const before = await readState(stub)
    const handBefore = before.players.find(p => p.id === victim)?.hand.length ?? -1

    await expireClock(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    // Both players receive the forfeit as an ordinary batch of events — so the animation pipeline,
    // the feed and the score all see a completely normal turn.
    for (const c of [a, b]) {
      const events = await c.waitFor('events')
      const timedOut = events.events.find(e => e.t === 'timedOut')
      expect(timedOut).toBeDefined()
      expect(timedOut).toMatchObject({ player: victim, phase: 'awaitingPlay' })
      expect(events.events.some(e => e.t === 'passed')).toBe(true)
    }

    const after = await readState(stub)
    // They drew exactly one card and lost the turn: a forfeit, not a played card.
    expect(after.players.find(p => p.id === victim)?.hand.length).toBe(handBefore + 1)
    expect(after.discardPile.length).toBe(before.discardPile.length)
    expect(after.players[after.turn]?.id).not.toBe(victim)

    // …and the clock has moved on to whoever owes the next decision.
    const next = await readClock(stub)
    expect(next?.player).not.toBe(victim)
  })

  it('is idempotent: a duplicate alarm delivery cannot take a second turn', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK5')

    await expireClock(stub)
    await runDurableObjectAlarm(stub)
    await a.waitFor('events')
    await b.waitFor('events')
    const afterFirst = await readState(stub)

    // Alarm delivery is at-least-once. A redelivery finds a clock that no longer matches the phase
    // it was armed for, so it re-arms rather than forfeiting again.
    await deliverAlarm(stub)

    const afterSecond = await readState(stub)
    expect(afterSecond.seq).toBe(afterFirst.seq)
    expect(afterSecond.players.map(p => p.hand.length)).toEqual(afterFirst.players.map(p => p.hand.length))
  })

  it('an early alarm wake does not forfeit anything — it puts the alarm back', async () => {
    const { stub } = await seatTwoAndStart('CLK6')
    const before = await readState(stub)
    const clock = await readClock(stub)

    // The deadline is still ~30s out; firing now is the "woke early" case.
    await deliverAlarm(stub)

    expect((await readState(stub)).seq).toBe(before.seq)
    expect((await readClock(stub))?.deadline).toBe(clock?.deadline)
    const scheduled = await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())
    expect(scheduled).toBe(clock?.deadline)
  })

  it('survives eviction mid-turn: the deadline is in storage, not in the instance', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK7')
    const clock = await readClock(stub)

    await evictDurableObject(stub)

    expect((await readClock(stub))?.deadline).toBe(clock?.deadline)

    // And the reconstructed object still forfeits on time.
    await expireClock(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const events = await a.waitFor('events')
    await b.waitFor('events')
    expect(events.events.some(e => e.t === 'timedOut')).toBe(true)
  })

  it('stops the clock between rounds, where the table waits on the host rather than on a turn', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLK8')

    // Play the round out. `autoMove` returns false exactly when nobody owes an action any more.
    for (let i = 0; i < 400; i++) {
      if (!(await autoMove([a, b]))) break
    }

    const state = await readState(stub)
    expect(['roundOver', 'gameOver']).toContain(state.phase.t)
    expect(await readClock(stub)).toBeNull()
    expect(await runInDurableObject(stub, (_i, ctx) => ctx.storage.getAlarm())).toBeNull()

    a.send({ t: 'resync', lastSeq: 0 })
    expect((await a.waitFor('sync')).timer).toBeNull()
  })

  it('keeps a running clock across a reconnect instead of granting a fresh window', async () => {
    const { stub, a } = await seatTwoAndStart('CLK9')
    const clock = await readClock(stub)

    a.close()
    const a2 = await Client.connect(stub, 'CLK9')
    a2.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    await a2.waitFor('welcome')
    const sync = await a2.waitFor('sync')

    expect((await readClock(stub))?.deadline).toBe(clock?.deadline)
    expect(sync.timer?.player).toBe(clock?.player)
    // The reconnecting player sees the time that is actually left, not a reset 30 seconds.
    expect(sync.timer?.remainingMs).toBeLessThanOrEqual(clock!.deadline - Date.now() + 50)
  })

  it('an unrelated action — an opponent calling UNO — does not touch the running deadline', async () => {
    const { stub, a, b } = await seatTwoAndStart('CLKA')

    const clock = await readClock(stub)
    const idle = [a, b].find(c => c.latestView && owes(c.latestView) !== c.latestView.you)
    expect(idle).toBeDefined()

    // A `callUno` from a player holding more than two cards is rejected, which is fine: what matters
    // is that a message from someone who is *not* on the clock cannot move the deadline either way.
    idle!.send({ t: 'callUno' })
    await idle!.next()

    expect((await readClock(stub))?.deadline).toBe(clock?.deadline)
  })
})
