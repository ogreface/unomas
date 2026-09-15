import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CARDS_BY_ID, assertCardConservation } from '@flipside/engine'
import { BOT_CLIENT_PREFIX } from '@flipside/protocol'
import type { GameState } from '@flipside/engine'
import { Client, autoMove, owes, stubFor, takeTurn } from './helpers.js'

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
  it('rejects join for a room that was never created, fatally', async () => {
    const stub = stubFor('GHOST')
    const c = await Client.connect(stub, 'GHOST')
    c.send({ t: 'join', clientId: 'client-x', nickname: 'Nobody' })
    const err = await c.waitFor('error')
    expect(err.code).toBe('not_found')
    expect(err.fatal).toBe(true)
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

describe('GameRoom — multiple connections', () => {
  it('lets one player hold two sockets at once without dropping either', async () => {
    const { stub, a } = await seatTwo('MULT')

    // A second socket for the same clientId — e.g. a second tab or a second device.
    const a2 = await Client.connect(stub, 'MULT')
    a2.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    await a2.waitFor('welcome')

    // The original socket is not evicted; it still round-trips, and Ann stays connected.
    a.send({ t: 'resync', lastSeq: 0 })
    const roster = await a.waitFor('roster')
    expect(roster.players.find(p => p.name === 'Ann')?.connected).toBe(true)

    // Closing one of Ann's sockets leaves her connected through the other.
    a2.close()
    a.send({ t: 'resync', lastSeq: 0 })
    const roster2 = await a.waitFor('roster')
    expect(roster2.players.find(p => p.name === 'Ann')?.connected).toBe(true)
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

  it('serves the table view even when the spectator shares a seated player’s clientId', async () => {
    // The projected table view usually runs in the same browser as a player, so it carries that
    // player's clientId. The role, not the clientId, must decide: it gets tableSync, not a hand.
    const { stub, a, b } = await seatTwo('SPEC2')
    await startGame(a, b)

    const s = await Client.connect(stub, 'SPEC2')
    s.send({ t: 'join', clientId: 'client-a', nickname: 'Table', role: 'spectator' })
    const welcome = await s.waitFor('welcome')
    expect(welcome.role).toBe('spectator')
    const tableSync = await s.waitFor('tableSync')
    expect(tableSync.table.players).toHaveLength(2)
  })
})

describe('GameRoom — computer players', () => {
  /**
   * Run the one bot move the room currently owes, and wait for its broadcast to reach `watcher`.
   *
   * Alarms are driven explicitly rather than waited on: `runDurableObjectAlarm` runs whatever is
   * scheduled *now*, which makes the test deterministic and, better, turns "the DO scheduled an
   * alarm at all" into the assertion. Returns false when nothing was scheduled.
   */
  async function runBotMove(stub: ReturnType<typeof stubFor>, watcher: Client): Promise<boolean> {
    const before = snapshotSeq(await readState(stub))
    if (!(await runDurableObjectAlarm(stub))) return false
    // A bot may wake, decline a coin-flip and do nothing at all; only a move broadcasts.
    if (snapshotSeq(await readState(stub)) === before) return false
    await watcher.waitFor('events')
    return true
  }

  /** Create a room with one human host, and return the host's client. */
  async function seatOne(code: string): Promise<{ stub: ReturnType<typeof stubFor>; a: Client }> {
    const stub = stubFor(code)
    await stub.createRoom(code)
    const a = await Client.connect(stub, code)
    a.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    await a.waitFor('welcome')
    await a.waitFor('roster')
    return { stub, a }
  }

  it('lets the host seat a computer player, and shows it on the roster', async () => {
    const { a } = await seatOne('BOT1')

    a.send({ t: 'addBot', difficulty: 'easy' })
    const roster = await a.waitFor('roster')

    expect(roster.players).toHaveLength(2)
    const bot = roster.players.find(p => p.id !== roster.host)
    expect(bot?.bot).toBe('easy')
    expect(bot?.seat).toBe(1)
    // The human is still a human.
    expect(roster.players.find(p => p.id === roster.host)?.bot).toBeNull()
  })

  it('tells a reconnecting client which seats are computers', async () => {
    const { stub, a } = await seatOne('BOT2')
    a.send({ t: 'addBot', difficulty: 'normal' })
    const roster = await a.waitFor('roster')
    const botId = roster.players.find(p => p.bot !== null)?.id

    const a2 = await Client.connect(stub, 'BOT2')
    a2.send({ t: 'join', clientId: 'client-a', nickname: 'Ann' })
    const welcome = await a2.waitFor('welcome')
    expect(welcome.bots).toEqual([botId])
  })

  it('refuses a bot from anyone but the host', async () => {
    const { b } = await seatTwo('BOT3')
    b.send({ t: 'addBot' })
    const err = await b.waitFor('error')
    expect(err.code).toBe('not_host')
  })

  it('refuses a bot once the game has started', async () => {
    const { a, b } = await seatTwo('BOT4')
    await startGame(a, b)
    a.send({ t: 'addBot' })
    const err = await a.waitFor('error')
    expect(err.code).toBe('wrong_phase')
  })

  it('removes a bot and closes the gap in the seating', async () => {
    const { a } = await seatOne('BOT5')
    a.send({ t: 'addBot' })
    const withOne = await a.waitFor('roster')
    a.send({ t: 'addBot' })
    const withTwo = await a.waitFor('roster')
    expect(withTwo.players.map(p => p.seat)).toEqual([0, 1, 2])

    // Remove the middle seat; the last player must slide down into it.
    const middle = withOne.players.find(p => p.bot !== null)!
    a.send({ t: 'removeBot', playerId: middle.id })
    const after = await a.waitFor('roster')
    expect(after.players).toHaveLength(2)
    expect(after.players.map(p => p.seat)).toEqual([0, 1])
    expect(after.players.some(p => p.id === middle.id)).toBe(false)
  })

  it('refuses to "remove" a human through the bot door', async () => {
    // Removing a bot and kicking a person are different features with different consent, so
    // `removeBot` must refuse a human's id rather than quietly evicting them.
    const { a } = await seatTwo('BOT6')
    a.send({ t: 'resync', lastSeq: 0 })
    const roster = await a.waitFor('roster')
    const human = roster.players.find(p => p.id !== roster.host)!
    expect(human.bot).toBeNull()

    a.send({ t: 'removeBot', playerId: human.id })
    const err = await a.waitFor('error')
    expect(err.code).toBe('bad_message')

    a.send({ t: 'resync', lastSeq: 0 })
    expect((await a.waitFor('roster')).players).toHaveLength(2)
  })

  it('will not hand a bot’s seat to a browser that claims its clientId', async () => {
    const { stub, a } = await seatOne('BOT7')
    a.send({ t: 'addBot' })
    const roster = await a.waitFor('roster')
    const botId = roster.players.find(p => p.bot !== null)!.id

    // Player ids are on the roster, and a bot's client_id is derived from one — so the id is
    // effectively public. Claiming it must be refused outright, not seated and not honoured.
    const impostor = await Client.connect(stub, 'BOT7')
    impostor.send({ t: 'join', clientId: `${BOT_CLIENT_PREFIX}${botId}`, nickname: 'Sneak' })
    const err = await impostor.waitFor('error')
    expect(err.code).toBe('bad_message')

    // …and the room is untouched: still one human and one bot.
    a.send({ t: 'resync', lastSeq: 0 })
    expect((await a.waitFor('roster')).players).toHaveLength(2)
  })

  it('one human and one bot play a whole round to completion', async () => {
    const { stub, a } = await seatOne('BOT8')
    a.send({ t: 'addBot', difficulty: 'normal' })
    await a.waitFor('roster')

    a.send({ t: 'start' })
    await a.waitFor('events')

    // Drive only the human. Every other move on the table is the room's own alarm handler deciding
    // from the bot's redacted view — `runDurableObjectAlarm` returning true is itself the assertion
    // that the DO scheduled one.
    let botMoves = 0
    for (let i = 0; i < 600; i++) {
      const view = a.latestView
      if (!view || view.phase.t === 'roundOver' || view.phase.t === 'gameOver') break
      if (owes(view) === view.you) {
        takeTurn(a, view)
        await a.waitFor('events')
      } else {
        if (!(await runBotMove(stub, a))) break
        botMoves++
      }
    }

    expect(a.latestView?.phase.t).toBe('roundOver')
    expect(botMoves).toBeGreaterThan(0)
    expect(a.errors).toEqual([])
    assertCardConservation(await readState(stub))
  })


  it('a bot catches a human who drops to one card without saying UNO', async () => {
    const { stub, a } = await seatOne('BOTA')
    a.send({ t: 'addBot', difficulty: 'normal' })
    await a.waitFor('roster')
    a.send({ t: 'start' })
    const started = await a.waitFor('events')
    const you = started.view.you

    // Rig the deal so the human holds exactly two inert number cards of the active colour: playing
    // one leaves them on a single card, with no UNO called and the window wide open.
    await runInDurableObject(stub, async (_instance, ctx) => {
      const row = ctx.storage.sql.exec('SELECT state FROM snapshot WHERE id = 0').toArray()[0] as {
        state: string
      }
      const state = JSON.parse(row.state) as GameState

      const faceOf = (id: string, side: GameState['side']) => CARDS_BY_ID.get(id)![side]
      const pool = [...state.players.flatMap(p => p.hand), ...state.drawPile]
      const numbers = pool.filter(id => faceOf(id, state.side).kind === 'number')
      const anchor = numbers[0]!
      const color = faceOf(anchor, state.side).color
      const sameColor = numbers.filter(
        id => id !== anchor && faceOf(id, state.side).color === color,
      )
      const humanHand = sameColor.slice(0, 2)
      const botHand = numbers.filter(id => id !== anchor && !humanHand.includes(id)).slice(0, 3)
      const placed = new Set([anchor, ...humanHand, ...botHand])

      state.discardPile = [...state.discardPile, anchor]
      state.drawPile = pool.filter(id => !placed.has(id))
      for (const p of state.players) {
        p.hand = p.id === you ? [...humanHand] : [...botHand]
        p.saidUno = false
      }
      state.turn = state.players.findIndex(p => p.id === you)
      state.phase = { t: 'awaitingPlay' }
      state.declaredColor = null
      state.unoWindow = null

      assertCardConservation(state)
      ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO snapshot (id, seq, state) VALUES (0, ?, ?)',
        state.seq,
        JSON.stringify(state),
      )
    })

    a.send({ t: 'resync', lastSeq: 0 })
    const sync = await a.waitFor('sync')
    expect(sync.view.hand).toHaveLength(2)
    expect(sync.view.legalPlays.length).toBeGreaterThan(0)

    // Play, and say nothing.
    a.send({ t: 'play', key: sync.view.legalPlays[0]! })
    await a.waitFor('events')

    // The bot is not on turn when the window opens. Catching a missed UNO is its own reason to wake
    // the room, and an alarm being there to run is exactly the claim under test.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const caught = await a.waitFor('events')
    expect(caught.events.some(e => e.t === 'unoPenalty' && e.player === you)).toBe(true)
    // One card left, plus the two-card penalty for being caught.
    expect(a.latestView?.hand).toHaveLength(3)
  })

  it('a bot takes its turn after the room has been evicted mid-game', async () => {
    const { stub, a } = await seatOne('BOT9')
    a.send({ t: 'addBot', difficulty: 'normal' })
    await a.waitFor('roster')
    a.send({ t: 'start' })
    await a.waitFor('events')

    // Play until the table is waiting on the bot rather than on the human.
    for (let i = 0; i < 200; i++) {
      const view = a.latestView
      if (!view) throw new Error('no view')
      if (view.phase.t === 'roundOver' || view.phase.t === 'gameOver') return
      if (owes(view) !== view.you) break
      takeTurn(a, view)
      await a.waitFor('events')
    }

    const seqBefore = snapshotSeq(await readState(stub))

    // Throw the object away mid-move. The bot's turn lives in *storage* — that is the whole reason
    // it is an alarm and not a `setTimeout`, which would have been lost with the instance.
    await evictDurableObject(stub)

    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(snapshotSeq(await readState(stub))).toBeGreaterThan(seqBefore)
  })
})
