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
import { assertCardConservation, decideBot, seedRng, viewFor } from '@flipside/engine'
import type { GameState } from '@flipside/engine'
import { Client, autoMove, owes, stubFor, takeTurn } from './helpers.js'
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

/** One human host plus one computer player, mid-game. `BOT_DELAY_MS` is ten minutes under test. */
async function seatHumanAndBot(code: string): Promise<{ stub: RoomStub; a: Client; botId: string }> {
  const stub = stubFor(code)
  await stub.createRoom(code)

  const a = await Client.connect(stub, code)
  a.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
  await a.waitFor('welcome')
  await a.waitFor('roster')

  a.send({ t: 'addBot', difficulty: 'normal' })
  const roster = await a.waitFor('roster')
  const botId = roster.players.find(p => p.bot !== null)?.id
  if (!botId) throw new Error('no bot was seated')

  a.send({ t: 'start' })
  await a.waitFor('events')
  return { stub, a, botId }
}

const scheduledAlarm = (stub: RoomStub): Promise<number | null> =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())

/** Two humans and a bot, mid-game. Returns the host's client, the other human's, and the bot's id. */
async function seatTwoHumansAndBot(
  code: string,
): Promise<{ stub: RoomStub; a: Client; b: Client; annId: string; botId: string }> {
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

  a.send({ t: 'addBot', difficulty: 'normal' })
  const roster = await a.waitFor('roster')
  await b.waitFor('roster')
  const botId = roster.players.find(p => p.bot !== null)?.id
  if (!botId) throw new Error('no bot was seated')

  a.send({ t: 'start' })
  const started = await a.waitFor('events')
  await b.waitFor('events')
  return { stub, a, b, annId: started.view.you, botId }
}

/**
 * Rig that table into the one shape where both of the alarm's errands are pending at once: Ann is
 * down to her last card and never said UNO — a callout the bot may want — while Bo owes the
 * decision and so is the one on the clock. Rigged rather than played out, because what is under
 * test is the single alarm slot, not how a table gets here. Returns Bo's player id.
 */
async function rigMissedUno(
  stub: RoomStub,
  annId: string,
  botId: string,
  turnTimeoutMs?: number,
): Promise<string> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as {
      state: string
    }
    const state = JSON.parse(row.state) as GameState
    const ann = state.players.find(p => p.id === annId)!
    const bo = state.players.find(p => p.id !== annId && p.id !== botId)!

    // The cards Ann is no longer holding go to the bottom of the draw pile, so the round still has
    // every card it was dealt.
    state.drawPile = [...state.drawPile, ...ann.hand.slice(1)]
    ann.hand = ann.hand.slice(0, 1)
    ann.saidUno = false
    state.unoWindow = ann.id
    state.turn = state.players.indexOf(bo)
    state.phase = { t: 'awaitingPlay' }
    if (turnTimeoutMs !== undefined) state.options = { ...state.options, turnTimeoutMs }

    assertCardConservation(state)
    ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO snapshot (id, seq, state) VALUES (0, ?, ?)',
      state.seq,
      JSON.stringify(state),
    )
    return bo.id
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

/**
 * A Durable Object gets exactly one alarm, and this room has two things to do with it: play a
 * bot's move, and forfeit a decision whose time is up. These are the tests for them sharing it.
 */
describe('GameRoom — the clock and the bot driver share one alarm', () => {
  it('leaves a bot off the clock, and wakes to play for it instead', async () => {
    const { stub, a, botId } = await seatHumanAndBot('CLKB1')

    // Hand the table to the bot. A wild leaves the human owing a colour choice next, so this is a
    // short loop rather than a single move.
    for (let i = 0; i < 8 && owes(a.latestView!) === a.latestView!.you; i++) {
      takeTurn(a, a.latestView!)
      await a.waitFor('events')
    }
    expect(owes(a.latestView!)).toBe(botId)

    // Nobody is on the clock: a bot's seat is *driven*, so forfeiting it would punish a player who
    // has not gone anywhere — the room is about to move for it.
    expect(await readClock(stub)).toBeNull()
    // But the room has not gone quiet on a seat that owes a move: the bot's own wake is armed.
    expect(await scheduledAlarm(stub)).not.toBeNull()

    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const events = await a.waitFor('events')
    // The wake played the bot's turn; it did not forfeit it.
    expect(events.events.some(e => e.t === 'timedOut')).toBe(false)
  })

  it('still runs a human’s clock at a table with a bot, and forfeits on time', async () => {
    const { stub, a } = await seatHumanAndBot('CLKB2')

    // The deal can hand the first turn to either seat; get the human on the clock.
    for (let i = 0; i < 8 && owes(a.latestView!) !== a.latestView!.you; i++) {
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      await a.waitFor('events')
    }
    const me = a.latestView!.you
    const clock = await readClock(stub)
    expect(clock?.player).toBe(me)

    // The sooner errand wins the slot: the human's 30 seconds, not the bot's pacing delay, which
    // the test environment pushes ten minutes out.
    expect(await scheduledAlarm(stub)).toBe(clock?.deadline)

    await expireClock(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const events = await a.waitFor('events')
    expect(events.events.find(e => e.t === 'timedOut')).toMatchObject({ player: me })

    // …and the room still has an alarm, so the table carries on rather than stalling on the seat
    // the forfeit handed the turn to.
    expect(await scheduledAlarm(stub)).not.toBeNull()
  })
  it('arms the sooner of its two errands when both are waiting', async () => {
    // Under test the bot's pacing delay is ten minutes (thirty, with the callout grace), so a
    // human's thirty seconds is the sooner errand by a mile.
    const { stub, b, annId, botId } = await seatTwoHumansAndBot('CLKB3')
    const boId = await rigMissedUno(stub, annId, botId)

    // A resync re-arms from stored state, which is where the two errands get weighed against
    // each other.
    b.send({ t: 'resync', lastSeq: 0 })
    await b.waitFor('sync')

    const clock = await readClock(stub)
    expect(clock?.player).toBe(boId)
    expect(await scheduledAlarm(stub)).toBe(clock?.deadline)
    // Belt and braces on what that number *is*: the human's window, not the bot's half-hour.
    expect(clock!.deadline).toBeLessThan(Date.now() + 60_000)
  })

  it('does not re-arm for a bot that has just declined to act', async () => {
    // A wake the bot does nothing with must leave the room asleep, not book another one. Otherwise
    // a bot that declines to call out a missed UNO is asked again every pacing delay for as long as
    // the window stays open — a busy loop that bills for hibernation it never gets. The clock is
    // switched off here so that the only thing that could arm the alarm is the bot.
    const { stub, b, annId, botId } = await seatTwoHumansAndBot('CLKB4')
    await rigMissedUno(stub, annId, botId, 0)

    // Pin the bot's coin-flip to a decline. `normal` is 90% vigilant, so waiting for the 1-in-10 to
    // come up on its own would be a flaky test.
    await runInDurableObject(stub, (_instance, ctx) => {
      const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as {
        state: string
      }
      const state = JSON.parse(row.state) as GameState
      const view = viewFor(state, botId)
      let rng = seedRng('uno-decline')
      let declines = false
      for (let i = 0; i < 500 && !declines; i++) {
        const decision = decideBot(view, rng, 'normal')
        if (decision.intent === null) declines = true
        else rng = decision.rng
      }
      expect(declines).toBe(true)
      ctx.storage.sql.exec('UPDATE bots SET rng = ? WHERE player_id = ?', JSON.stringify(rng), botId)
    })

    b.send({ t: 'resync', lastSeq: 0 })
    await b.waitFor('sync')
    expect(await readClock(stub)).toBeNull() // the clock is off, so the bot is the only errand
    const before = (await readState(stub)).seq

    await deliverAlarm(stub)

    expect((await readState(stub)).seq).toBe(before) // it really did decline
    expect(await scheduledAlarm(stub)).toBeNull()
  })
})
