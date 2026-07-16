import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { assertCardConservation } from '@flipside/engine'
import type { GameState } from '@flipside/engine'
import { Client, autoMove, stubFor } from './helpers.js'

/** Create the room, seat two players, and return their live clients. */
async function seatTwo(code: string): Promise<{
  stub: ReturnType<typeof stubFor>
  a: Client
  b: Client
  hostId: string
}> {
  const stub = stubFor(code)
  await stub.createRoom(code)

  const a = await Client.connect(stub, code)
  a.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
  const welcomeA = await a.waitFor('welcome')
  await a.waitFor('roster')

  const b = await Client.connect(stub, code)
  b.send({ t: 'join', clientId: 'client-b', nickname: 'Bo' })
  await b.waitFor('welcome')
  await b.waitFor('roster')
  await a.waitFor('roster') // A learns B arrived

  return { stub, a, b, hostId: welcomeA.you }
}

async function startGame(a: Client, b: Client): Promise<void> {
  a.send({ t: 'start' })
  await a.waitFor('events')
  await b.waitFor('events')
}

function snapshotSeq(state: GameState): number {
  return state.seq
}

async function readState(stub: ReturnType<typeof stubFor>): Promise<GameState> {
  return runInDurableObject(stub, async (_instance, ctx) => {
    const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as
      | { state: string }
      | undefined
    if (!row) throw new Error('no snapshot')
    return JSON.parse(row.state) as GameState
  })
}

describe('GameRoom — routing & lobby', () => {
  it('404s a websocket for a room that was never created', async () => {
    const stub = stubFor('GHOST')
    const res = await stub.fetch('https://room/ws/GHOST', { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(404)
    expect(res.webSocket).toBeFalsy()
  })

  it('seats joining players and broadcasts the roster', async () => {
    const { a, b, hostId } = await seatTwo('LOB1')

    const welcomeSeatB = b.latestView // still null pre-game
    expect(welcomeSeatB).toBeNull()

    // A's most recent roster should list both players, with the first joiner as host.
    a.send({ t: 'resync', lastSeq: 0 })
    const roster = await a.waitFor('roster')
    expect(roster.players.map(p => p.name).sort()).toEqual(['Ann', 'Bo'])
    expect(roster.host).toBe(hostId)
    expect(roster.started).toBe(false)
  })

  it('rejects a duplicate createRoom on the same object', async () => {
    const stub = stubFor('DUP1')
    expect((await stub.createRoom('DUP1')).created).toBe(true)
    expect((await stub.createRoom('DUP1')).created).toBe(false)
  })
})

describe('GameRoom — starting', () => {
  it('lets only the host start, and deals a full round', async () => {
    const { a, b } = await seatTwo('STRT')

    // Non-host cannot start.
    b.send({ t: 'start' })
    const err = await b.waitFor('error')
    expect(err.code).toBe('not_host')

    // Host starts; both players receive the round and a private 7-card hand.
    a.send({ t: 'start' })
    const evA = await a.waitFor('events')
    const evB = await b.waitFor('events')
    expect(evA.events.some(e => e.t === 'roundStarted')).toBe(true)
    // Each hand starts at the dealt 7; an opening Draw card can push the starter above that.
    expect(evA.view.hand.length).toBeGreaterThanOrEqual(7)
    expect(evB.view.hand.length).toBeGreaterThanOrEqual(7)

    // The inverted-information channel: A must not see A's own back faces, but must see all of B's.
    const me = evA.view.players.find(p => p.id === evA.view.you)
    const opp = evA.view.players.find(p => p.id !== evA.view.you)
    expect(me?.visible).toHaveLength(0)
    expect(opp?.visible).toHaveLength(opp?.handCount ?? -1)
  })

  it('refuses to start with fewer than two players', async () => {
    const stub = stubFor('SOLO')
    await stub.createRoom('SOLO')
    const a = await Client.connect(stub, 'SOLO')
    a.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    await a.waitFor('welcome')
    await a.waitFor('roster')

    a.send({ t: 'start' })
    const err = await a.waitFor('error')
    expect(err.code).toBe('not_enough_players')
  })
})

describe('GameRoom — actions', () => {
  it('reduces a legal action, advances the sequence, and conserves the deck', async () => {
    const { stub, a, b } = await seatTwo('ACT1')
    await startGame(a, b)

    const before = snapshotSeq(await readState(stub))
    for (let i = 0; i < 6; i++) {
      const moved = await autoMove([a, b])
      if (!moved) break
    }
    const after = await readState(stub)
    expect(snapshotSeq(after)).toBeGreaterThan(before)
    // The invariant that catches almost every engine/wire bug.
    assertCardConservation(after)
  })

  it('rejects an action from a player whose turn it is not', async () => {
    const { a, b } = await seatTwo('TURN')
    await startGame(a, b)

    // Whichever client does NOT owe the current action tries to draw. The reducer rejects it — as
    // `not_your_turn` when it is simply not their turn, or `wrong_phase` when the table is waiting on
    // someone else's colour choice or drawn-card decision. Either way, a non-actor cannot act.
    const idle = [a, b].find(c => c.latestView && c.latestView.turn !== c.latestView.you)
    expect(idle).toBeDefined()
    idle!.send({ t: 'draw' })
    const err = await idle!.waitFor('error')
    expect(['not_your_turn', 'wrong_phase']).toContain(err.code)
  })

  it('rejects a play referencing a card key that is not in this round', async () => {
    const { a, b } = await seatTwo('BADK')
    await startGame(a, b)
    const actor = [a, b].find(c => c.latestView && c.latestView.turn === c.latestView.you)
    actor!.send({ t: 'play', key: 'not-a-real-key' })
    const err = await actor!.waitFor('error')
    expect(err.code).toBe('unknown_card')
  })
})

describe('GameRoom — durability', () => {
  it('a game in progress survives Durable Object eviction', async () => {
    const { stub, a, b } = await seatTwo('EVCT')
    await startGame(a, b)
    await autoMove([a, b])

    const seqBefore = snapshotSeq(await readState(stub))

    // Tear down the live instance. Hibernatable sockets are preserved by default.
    await evictDurableObject(stub)

    // The reconstructed object must recover the exact same state from storage.
    a.send({ t: 'resync', lastSeq: 0 })
    const sync = await a.waitFor('sync')
    expect(sync.view.seq).toBe(seqBefore)

    // …and play must continue seamlessly across the eviction boundary.
    const moved = await autoMove([a, b])
    expect(moved).toBe(true)
    expect(snapshotSeq(await readState(stub))).toBeGreaterThan(seqBefore)
  })

  it('a reconnecting player reclaims their seat and full private view', async () => {
    const { stub, a, b } = await seatTwo('RCON')
    await startGame(a, b)
    await autoMove([a, b])

    const youBefore = a.latestView?.you
    // The authoritative hand for A lives in the server snapshot, not A's (possibly stale) client
    // view — B may have just forced A to draw, and A's broadcast may not have landed yet.
    const state = await readState(stub)
    const handBefore = state.players.find(p => p.id === youBefore)?.hand.length ?? -1
    a.close()

    const a2 = await Client.connect(stub, 'RCON')
    a2.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    const welcome = await a2.waitFor('welcome')
    expect(welcome.seat).toBe(0)
    expect(welcome.you).toBe(youBefore)

    const sync = await a2.waitFor('sync')
    expect(sync.view.hand).toHaveLength(handBefore)
    expect(sync.view.you).toBe(youBefore)
  })
})

describe('GameRoom — spectators', () => {
  it('a spectator sees the table but never a hand', async () => {
    const { stub, a, b } = await seatTwo('SPEC')
    await startGame(a, b)

    const s = await Client.connect(stub, 'SPEC')
    s.send({ t: 'join', clientId: 'client-s', nickname: 'Screen', role: 'spectator' })
    await s.waitFor('welcome')
    const tableSync = await s.waitFor('tableSync')

    // The projector sees every hand's *count* and its public back faces, but no active faces.
    expect(tableSync.table.players).toHaveLength(2)
    for (const p of tableSync.table.players) {
      expect(p.handCount).toBeGreaterThanOrEqual(7) // dealt 7; an opening Draw can add more
      expect(p.visible).toHaveLength(p.handCount) // inactive faces — public information
    }
  })
})
