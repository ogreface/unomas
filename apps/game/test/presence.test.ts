/**
 * Leaving the table, server side (D18).
 *
 * What a drop *does* to a game is a rule and is tested with the engine
 * (`packages/engine/test/drop.test.ts`). This file is about the two ways the room decides that
 * somebody has gone, and both only exist in `workerd`:
 *
 * - **their last connection closed and stayed closed.** A closed socket cannot tell a closed tab
 *   from a reload, a dead spot on the train or a deploy, so the room gives it a short grace period
 *   — held in storage and sharing the room's one alarm — and drops the player only if nobody has
 *   reclaimed the seat by the end of it;
 * - **the clock ran out on them three times in a row**, which is the engine's rule, reached
 *   through the same alarm that forfeits a turn.
 */

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { GameState } from '@flipside/engine'
import { Client, owes, stubFor, takeTurn } from './helpers.js'
import type { RoomStub } from './helpers.js'

const NAMES = ['Ann', 'Bo', 'Cy', 'Dee']

/** Create a room and seat `n` people in it, in order. Everyone has seen everyone else arrive. */
async function seat(code: string, n: number): Promise<{ stub: RoomStub; clients: Client[]; ids: string[] }> {
  const stub = stubFor(code)
  await stub.createRoom(code)

  const clients: Client[] = []
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const c = await Client.connect(stub, code)
    c.send({ t: 'join', clientId: `client-${i}-xx`, nickname: NAMES[i] as string })
    ids.push((await c.waitFor('welcome')).you)
    for (const seated of [...clients, c]) await seated.waitFor('roster')
    clients.push(c)
  }
  return { stub, clients, ids }
}

/** …and deal. The first client is the host. */
async function seatAndStart(
  code: string,
  n: number,
): Promise<{ stub: RoomStub; clients: Client[]; ids: string[] }> {
  const table = await seat(code, n)
  table.clients[0]!.send({ t: 'start' })
  for (const c of table.clients) await c.waitFor('events')
  return table
}

async function rejoin(stub: RoomStub, code: string, index: number): Promise<Client> {
  const c = await Client.connect(stub, code)
  c.send({ t: 'join', clientId: `client-${index}-xx`, nickname: NAMES[index] as string })
  return c
}

interface Absence {
  player_id: string
  deadline: number
}

/** The grace periods the room is running, straight out of its SQLite. */
async function absences(stub: RoomStub): Promise<Absence[]> {
  return runInDurableObject(stub, (_instance, ctx) => {
    return ctx.storage.sql.exec('SELECT player_id, deadline FROM absences').toArray() as unknown as Absence[]
  })
}

/**
 * Close a client's socket and wait until the room has noticed. The close is delivered to the
 * Durable Object asynchronously, and nothing is broadcast for it mid-game, so the only honest
 * barrier is the room's own record of the absence.
 */
async function walkAway(stub: RoomStub, client: Client, playerId: string): Promise<void> {
  client.close()
  for (let i = 0; i < 400; i++) {
    if ((await absences(stub)).some(a => a.player_id === playerId)) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the room never noticed the socket closing')
}

/** Wind every running grace period back into the past, so the next alarm finds it spent. */
async function expireGrace(stub: RoomStub): Promise<void> {
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE absences SET deadline = ?', Date.now() - 1)
  })
}

async function expireClock(stub: RoomStub): Promise<void> {
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE turn_clock SET deadline = ? WHERE id = 0', Date.now() - 1)
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

interface ClockRow {
  player: string
  deadline: number
}

async function readClock(stub: RoomStub): Promise<ClockRow | null> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const rows = ctx.storage.sql
      .exec('SELECT player, deadline FROM turn_clock WHERE id = 0')
      .toArray() as unknown as ClockRow[]
    return rows[0] ?? null
  })
}

const scheduledAlarm = (stub: RoomStub): Promise<number | null> =>
  runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())

const hostOf = (stub: RoomStub): Promise<string | null> =>
  runInDurableObject(stub, (_instance, ctx) => {
    const row = ctx.storage.sql.exec('SELECT host FROM room WHERE id = 0').toArray()[0] as { host: string | null }
    return row.host
  })

const dropped = (state: GameState, id: string) => state.players.find(p => p.id === id)?.dropped ?? null

describe('GameRoom — closing the tab in the lobby', () => {
  it('shows the player as away at once, and takes them off the roster when the grace period ends', async () => {
    const { stub, clients, ids } = await seat('LBY1', 3)
    const [a, b, c] = clients as [Client, Client, Client]

    b.close()
    const away = await a.waitFor('roster')
    expect(away.players.find(p => p.id === ids[1])?.connected).toBe(false)
    expect(away.players).toHaveLength(3) // not gone yet: a reload looks exactly like this
    await c.waitFor('roster')

    await expireGrace(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const roster = await a.waitFor('roster')
    expect(roster.players.map(p => p.id)).toEqual([ids[0], ids[2]])
    // The gap is closed, so the next person to join is not handed a seat somebody already has.
    expect(roster.players.map(p => p.seat)).toEqual([0, 1])
    expect(await absences(stub)).toEqual([])
  })

  it('gives them ten seconds, on the room’s alarm', async () => {
    const { stub, clients, ids } = await seat('LBY2', 2)

    await walkAway(stub, clients[1]!, ids[1]!)

    const [absence] = await absences(stub)
    expect(absence!.deadline).toBeGreaterThan(Date.now() + 8_000)
    expect(absence!.deadline).toBeLessThanOrEqual(Date.now() + 10_000)
    expect(await scheduledAlarm(stub)).toBe(absence!.deadline)
  })

  it('does nothing if the alarm comes round early', async () => {
    const { stub, clients, ids } = await seat('LBY3', 2)
    await walkAway(stub, clients[1]!, ids[1]!)
    const [absence] = await absences(stub)

    expect(await runDurableObjectAlarm(stub)).toBe(true) // fires now, well short of the deadline

    clients[0]!.send({ t: 'resync', lastSeq: 0 })
    let roster = await clients[0]!.waitFor('roster')
    while (roster.players.find(p => p.id === ids[1])?.connected) roster = await clients[0]!.waitFor('roster')
    expect(roster.players).toHaveLength(2)
    // …and the room has put its alarm back for the real deadline.
    expect(await scheduledAlarm(stub)).toBe(absence!.deadline)
  })

  it('keeps the seat of a player who is back before the grace period ends — a reload, not a goodbye', async () => {
    const { stub, clients, ids } = await seat('LBY4', 2)
    await walkAway(stub, clients[1]!, ids[1]!)

    const back = await rejoin(stub, 'LBY4', 1)
    const welcome = await back.waitFor('welcome')
    expect(welcome.you).toBe(ids[1])
    expect(await absences(stub)).toEqual([])

    // The alarm set for the old deadline still comes round, and finds nothing to do.
    await runDurableObjectAlarm(stub)
    back.send({ t: 'resync', lastSeq: 0 })
    let roster = await back.waitFor('roster')
    while (!roster.players.find(p => p.id === ids[1])?.connected) roster = await back.waitFor('roster')
    expect(roster.players).toHaveLength(2)
  })

  it('hands the room to the next person when the host is the one who leaves', async () => {
    const { stub, clients, ids } = await seat('LBY5', 3)
    const [a, b, c] = clients as [Client, Client, Client]

    await walkAway(stub, a, ids[0]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    let roster = await b.waitFor('roster')
    while (roster.players.length === 3) roster = await b.waitFor('roster')
    expect(roster.host).toBe(ids[1])

    // And the new host really can start the game.
    b.send({ t: 'start' })
    const started = await b.waitFor('events')
    await c.waitFor('events')
    expect(started.view.players.map(p => p.id)).toEqual([ids[1], ids[2]])
  })

  it('leaves the room without a host when the last person goes, for whoever arrives next', async () => {
    const { stub, clients, ids } = await seat('LBY6', 1)
    await walkAway(stub, clients[0]!, ids[0]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)
    expect(await hostOf(stub)).toBeNull()

    const next = await Client.connect(stub, 'LBY6')
    next.send({ t: 'join', clientId: 'client-new-xx', nickname: 'Eve' })
    const welcome = await next.waitFor('welcome')
    const roster = await next.waitFor('roster')

    expect(roster.players.map(p => p.name)).toEqual(['Eve'])
    expect(roster.host).toBe(welcome.you)
  })

  it('does not treat closing one of two tabs as leaving', async () => {
    const { stub, clients } = await seat('LBY7', 2)
    const second = await rejoin(stub, 'LBY7', 1)
    await second.waitFor('welcome')

    second.close()
    // The surviving tab still round-trips, which also proves the close has been processed.
    clients[1]!.send({ t: 'resync', lastSeq: 0 })
    await clients[1]!.waitFor('roster')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await absences(stub)).toEqual([])
  })

  it('does not treat the projected table view closing as anybody leaving', async () => {
    const { stub, clients } = await seat('LBY8', 2)
    const screen = await Client.connect(stub, 'LBY8')
    // The projector usually runs in a player's own browser, so it carries that player's clientId.
    screen.send({ t: 'join', clientId: 'client-1-xx', nickname: 'Table', role: 'spectator' })
    await screen.waitFor('welcome')

    screen.close()
    clients[0]!.send({ t: 'resync', lastSeq: 0 })
    await clients[0]!.waitFor('roster')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await absences(stub)).toEqual([])
  })
})

describe('GameRoom — closing the tab mid-game', () => {
  it('drops the player when the grace period ends, and tells everyone still there', async () => {
    const { stub, clients, ids } = await seatAndStart('GON1', 3)
    const [a, b, c] = clients as [Client, Client, Client]

    await walkAway(stub, b, ids[1]!)
    expect(dropped(await readState(stub), ids[1]!)).toBeNull() // still in it, for now

    await expireGrace(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    for (const client of [a, c]) {
      const msg = await client.waitFor('events')
      expect(msg.events.find(e => e.t === 'playerDropped')).toMatchObject({
        player: ids[1],
        reason: 'disconnected',
      })
      expect(msg.view.players.find(p => p.id === ids[1])).toMatchObject({
        dropped: 'disconnected',
        handCount: 0,
      })
    }

    const state = await readState(stub)
    expect(dropped(state, ids[1]!)).toBe('disconnected')
    expect(state.phase.t).not.toBe('gameOver') // two are left, so they play on
    expect(owes(a.latestView!)).not.toBe(ids[1])
    expect(await absences(stub)).toEqual([])
  })

  it('gives the game to the last player left', async () => {
    const { stub, clients, ids } = await seatAndStart('GON2', 2)
    const [a, b] = clients as [Client, Client]

    await walkAway(stub, b, ids[1]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    const msg = await a.waitFor('events')
    expect(msg.events.map(e => e.t)).toEqual(expect.arrayContaining(['playerDropped', 'gameEnded']))
    expect(msg.view.phase).toEqual({ t: 'gameOver', winner: ids[0] })
    // Nothing left to wait for: no clock, and no alarm.
    expect(msg.timer).toBeNull()
    expect(await readClock(stub)).toBeNull()
    expect(await scheduledAlarm(stub)).toBeNull()
  })

  it('keeps a player who reconnects inside the grace period — every deploy does exactly this', async () => {
    const { stub, clients, ids } = await seatAndStart('GON3', 2)
    await walkAway(stub, clients[1]!, ids[1]!)

    const back = await rejoin(stub, 'GON3', 1)
    await back.waitFor('welcome')
    const sync = await back.waitFor('sync')
    expect(await absences(stub)).toEqual([])

    await runDurableObjectAlarm(stub) // the old deadline's alarm, now with nothing to do

    const state = await readState(stub)
    expect(dropped(state, ids[1]!)).toBeNull()
    expect(state.phase.t).not.toBe('gameOver')
    expect(sync.view.hand.length).toBeGreaterThan(0)
  })

  it('runs the grace period on the same alarm as the turn clock, whichever is due first', async () => {
    const { stub, clients, ids } = await seatAndStart('GON4', 3)
    const clock = await readClock(stub)
    expect(await scheduledAlarm(stub)).toBe(clock!.deadline)

    await walkAway(stub, clients[2]!, ids[2]!)

    const [absence] = await absences(stub)
    expect(absence!.deadline).toBeLessThan(clock!.deadline)
    expect(await scheduledAlarm(stub)).toBe(absence!.deadline)
  })

  it('an early wake drops nobody, and leaves both deadlines standing', async () => {
    const { stub, clients, ids } = await seatAndStart('GON5', 3)
    const clock = await readClock(stub)
    await walkAway(stub, clients[2]!, ids[2]!)
    const [absence] = await absences(stub)
    const before = await readState(stub)

    await runDurableObjectAlarm(stub)

    expect((await readState(stub)).seq).toBe(before.seq)
    expect(await absences(stub)).toEqual([absence])
    expect((await readClock(stub))?.deadline).toBe(clock!.deadline)
    expect(await scheduledAlarm(stub)).toBe(absence!.deadline)
  })

  it('does not touch the clock of a player who is still deciding when somebody else is dropped', async () => {
    const { stub, clients, ids } = await seatAndStart('GON6', 3)
    const clock = await readClock(stub)
    const bystander = ids.findIndex(id => id !== clock!.player)

    await walkAway(stub, clients[bystander]!, ids[bystander]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    expect(dropped(await readState(stub), ids[bystander]!)).toBe('disconnected')
    // Same player, same decision, same deadline: somebody leaving is not a reason to start
    // their thirty seconds again.
    expect(await readClock(stub)).toEqual(clock)
    expect(await scheduledAlarm(stub)).toBe(clock!.deadline)
  })

  it('passes the turn — and a fresh clock — to the next player when the one on the clock is dropped', async () => {
    const { stub, clients, ids } = await seatAndStart('GON7', 3)
    const clock = await readClock(stub)
    const onTheClock = ids.indexOf(clock!.player)
    const watcher = clients[(onTheClock + 1) % 3]!

    await walkAway(stub, clients[onTheClock]!, clock!.player)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    const msg = await watcher.waitFor('events')
    expect(owes(msg.view)).not.toBe(clock!.player)
    expect(msg.timer?.player).toBe(owes(msg.view))
    expect(msg.timer?.remainingMs).toBeGreaterThan(25_000)
    const next = await readClock(stub)
    expect(next?.player).toBe(owes(msg.view))
  })

  it('never drops a player who is connected, whatever the record of absences says', async () => {
    const { stub, clients, ids } = await seatAndStart('GONC', 3)
    // A hold with no closed socket behind it should not be possible. A drop cannot be undone,
    // though, so the room checks the one thing that would make it plainly wrong.
    await runInDurableObject(stub, async (_instance, ctx) => {
      ctx.storage.sql.exec('INSERT INTO absences (player_id, deadline) VALUES (?, ?)', ids[1], Date.now() - 1)
      await ctx.storage.setAlarm(Date.now())
    })

    await runDurableObjectAlarm(stub)

    expect(dropped(await readState(stub), ids[1]!)).toBeNull()
    expect(await absences(stub)).toEqual([])
    clients[1]!.send({ t: 'resync', lastSeq: 0 })
    expect((await clients[1]!.waitFor('sync')).view.hand.length).toBeGreaterThan(0)
  })

  it('survives eviction: the grace period is in storage, not in the instance', async () => {
    const { stub, clients, ids } = await seatAndStart('GON8', 3)
    await walkAway(stub, clients[1]!, ids[1]!)
    const [absence] = await absences(stub)

    await evictDurableObject(stub)

    expect(await absences(stub)).toEqual([absence])
    await expireGrace(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(dropped(await readState(stub), ids[1]!)).toBe('disconnected')
  })

  it('lets a dropped player back in to watch, but not to play', async () => {
    const { stub, clients, ids } = await seatAndStart('GON9', 3)
    await walkAway(stub, clients[1]!, ids[1]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    const back = await rejoin(stub, 'GON9', 1)
    const welcome = await back.waitFor('welcome')
    const sync = await back.waitFor('sync')

    // Their own seat, so the client knows which player on the board is "you" — and that it is out.
    expect(welcome.you).toBe(ids[1])
    expect(sync.view.players.find(p => p.id === ids[1])?.dropped).toBe('disconnected')
    expect(sync.view.hand).toEqual([])

    back.send({ t: 'draw' })
    const error = await back.waitFor('error')
    expect(error.code).toBe('not_in_game')
    expect(error.fatal).toBe(false)

    // Coming back to watch, and leaving again, is not a second departure.
    back.close()
    clients[0]!.send({ t: 'resync', lastSeq: 0 })
    await clients[0]!.waitFor('sync')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await absences(stub)).toEqual([])
  })

  it('hands the deal to the next player when the host is dropped, and tells every screen', async () => {
    const { stub, clients, ids } = await seatAndStart('GONA', 3)
    const [a, b, c] = clients as [Client, Client, Client]

    await walkAway(stub, a, ids[0]!)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    for (const client of [b, c]) expect((await client.waitFor('host')).host).toBe(ids[1])
    expect(await hostOf(stub)).toBe(ids[1])

    // Between rounds the table waits on the host to deal — which is why there has to be one.
    await runInDurableObject(stub, (_instance, ctx) => {
      const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as { state: string }
      const state = JSON.parse(row.state) as GameState
      state.phase = { t: 'roundOver', winner: ids[1]!, points: 10 }
      ctx.storage.sql.exec('UPDATE snapshot SET state = ? WHERE id = 0', JSON.stringify(state))
    })
    c.send({ t: 'start' })
    expect((await c.waitFor('error')).code).toBe('not_host')
    b.send({ t: 'start' })
    let dealt = await b.waitFor('events')
    while (!dealt.events.some(e => e.t === 'roundStarted')) dealt = await b.waitFor('events')
    expect(dealt.view.hand.length).toBeGreaterThanOrEqual(7)

    // And a client that reconnects later is told the same thing in its welcome.
    const again = await rejoin(stub, 'GONA', 2)
    expect((await again.waitFor('welcome')).host).toBe(ids[1])
  })

  it('does not leave computer players playing on in a room with nobody in it', async () => {
    const stub = stubFor('GONB')
    await stub.createRoom('GONB')
    const a = await Client.connect(stub, 'GONB')
    a.send({ t: 'join', clientId: 'client-0-xx', nickname: 'Ann' })
    const me = (await a.waitFor('welcome')).you
    await a.waitFor('roster')
    a.send({ t: 'addBot', difficulty: 'normal' })
    await a.waitFor('roster')
    a.send({ t: 'addBot', difficulty: 'normal' })
    await a.waitFor('roster')
    a.send({ t: 'start' })
    await a.waitFor('events')

    await walkAway(stub, a, me)
    await expireGrace(stub)
    await runDurableObjectAlarm(stub)

    const state = await readState(stub)
    expect(dropped(state, me)).toBe('disconnected')
    // Two bots are still "in" the game as far as the rules go, so it is not over —
    expect(state.phase.t).not.toBe('gameOver')
    // — but nobody is there to watch it, and the room does not book itself another wake.
    expect(await scheduledAlarm(stub)).toBeNull()

    // Even a stray wake does not set them going again.
    await runInDurableObject(stub, async instance => {
      await instance.alarm?.()
    })
    expect((await readState(stub)).seq).toBe(state.seq)
    expect(await scheduledAlarm(stub)).toBeNull()
  })
})

describe('GameRoom — three timeouts in a row', () => {
  /**
   * Let the clock run out on `victim` `times` times, with everybody else playing their own turns
   * in between. Returns the last batch of events the watching client was sent for a timeout.
   */
  async function runOutTheClock(
    stub: RoomStub,
    clients: Client[],
    ids: string[],
    victim: string,
    times: number,
  ) {
    const watcher = clients[ids.findIndex(id => id !== victim)]!
    let last = null
    for (let struck = 0, guard = 0; struck < times; guard++) {
      if (guard > 200) throw new Error('the victim never came back on the clock')
      const state = await readState(stub)
      const clock = await readClock(stub)
      if (!clock) throw new Error(`nobody is on the clock in phase "${state.phase.t}"`)

      if (clock.player === victim) {
        await expireClock(stub)
        expect(await runDurableObjectAlarm(stub)).toBe(true)
        struck++
      } else {
        const actor = clients[ids.indexOf(clock.player)]!
        // Draw rather than play, so nobody goes out and ends the round under the test.
        const view = actor.latestView!
        if (view.phase.t === 'awaitingPlay') actor.send({ t: 'draw' })
        else if (view.phase.t === 'awaitingDrawnCardChoice') actor.send({ t: 'pass' })
        else takeTurn(actor, view)
      }
      // One broadcast per accepted action, to every socket still open.
      const batch = await Promise.all(clients.map(c => c.waitFor('events')))
      if (clock.player === victim) last = batch[clients.indexOf(watcher)]!
    }
    return last!
  }

  it('counts the strikes out loud, then drops the player on the third', async () => {
    const { stub, clients, ids } = await seatAndStart('STR1', 3)
    const victim = (await readClock(stub))!.player

    const first = await runOutTheClock(stub, clients, ids, victim, 1)
    expect(first.events.find(e => e.t === 'timedOut')).toMatchObject({ player: victim, strikes: 1, limit: 3 })
    const second = await runOutTheClock(stub, clients, ids, victim, 1)
    expect(second.events.find(e => e.t === 'timedOut')).toMatchObject({ strikes: 2 })
    expect(dropped(await readState(stub), victim)).toBeNull()

    const third = await runOutTheClock(stub, clients, ids, victim, 1)

    expect(third.events.find(e => e.t === 'timedOut')).toMatchObject({ strikes: 3 })
    expect(third.events.find(e => e.t === 'playerDropped')).toMatchObject({
      player: victim,
      reason: 'timeouts',
    })
    const state = await readState(stub)
    expect(dropped(state, victim)).toBe('timeouts')
    expect(state.phase.t).not.toBe('gameOver')
    // The table moves straight on: the next player is on a fresh clock.
    const clock = await readClock(stub)
    expect(clock?.player).not.toBe(victim)
    expect(clock!.deadline).toBeGreaterThan(Date.now() + 25_000)
  })

  it('a move of their own in between wipes the count', async () => {
    const { stub, clients, ids } = await seatAndStart('STR2', 3)
    const victim = (await readClock(stub))!.player
    const victimClient = clients[ids.indexOf(victim)]!

    await runOutTheClock(stub, clients, ids, victim, 2)

    // They come back for one turn…
    for (let guard = 0; (await readClock(stub))?.player !== victim; guard++) {
      if (guard > 50) throw new Error('the victim never came back on the clock')
      const actor = clients[ids.indexOf((await readClock(stub))!.player)]!
      actor.send(actor.latestView!.phase.t === 'awaitingDrawnCardChoice' ? { t: 'pass' } : { t: 'draw' })
      await Promise.all(clients.map(c => c.waitFor('events')))
    }
    victimClient.send({ t: 'draw' })
    await Promise.all(clients.map(c => c.waitFor('events')))
    if (victimClient.latestView!.phase.t === 'awaitingDrawnCardChoice' && owes(victimClient.latestView!) === victim) {
      victimClient.send({ t: 'pass' })
      await Promise.all(clients.map(c => c.waitFor('events')))
    }

    // …and the next timeout is strike one again, not strike three.
    const after = await runOutTheClock(stub, clients, ids, victim, 1)
    expect(after.events.find(e => e.t === 'timedOut')).toMatchObject({ player: victim, strikes: 1 })
    expect(dropped(await readState(stub), victim)).toBeNull()
  })

  it('passes the deal on when the player struck out was the host', async () => {
    const { stub, clients, ids } = await seatAndStart('STR3', 3)
    const [, b, c] = clients as [Client, Client, Client]

    // Put the host on the clock, whoever the deal happened to start with.
    await runInDurableObject(stub, (_instance, ctx) => {
      const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as { state: string }
      const state = JSON.parse(row.state) as GameState
      state.players[0]!.timeouts = 2
      ctx.storage.sql.exec('UPDATE snapshot SET state = ? WHERE id = 0', JSON.stringify(state))
    })
    await runOutTheClock(stub, clients, ids, ids[0]!, 1)

    expect(dropped(await readState(stub), ids[0]!)).toBe('timeouts')
    for (const client of [b, c]) expect((await client.waitFor('host')).host).toBe(ids[1])
    expect(await hostOf(stub)).toBe(ids[1])
  })

  it('ends a two-player game in the other player’s favour', async () => {
    const { stub, clients, ids } = await seatAndStart('STR4', 2)
    const victim = (await readClock(stub))!.player
    const other = ids.find(id => id !== victim)!

    const last = await runOutTheClock(stub, clients, ids, victim, 3)

    expect(last.events.map(e => e.t)).toEqual(expect.arrayContaining(['playerDropped', 'gameEnded']))
    expect(last.view.phase).toEqual({ t: 'gameOver', winner: other })
    expect(await scheduledAlarm(stub)).toBeNull()
  })
})
