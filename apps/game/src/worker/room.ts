/**
 * `GameRoom` — one Durable Object per room, the authoritative home of a single game.
 *
 * The engine is a pure reducer; this object is everything around it that the engine is forbidden to
 * be: the clock, the entropy, the socket fan-out, and the persistence. It holds the whole
 * `GameState` in SQLite and **never** in a class field — the constructor re-runs every time the
 * object wakes from hibernation, so a cached field would be a stale-state bug waiting for the first
 * quiet moment in a game. Every handler re-reads the snapshot from storage.
 *
 * The flow for an accepted action is always the same four steps, and they are the reason this file
 * exists:
 *
 *   validate → `ruleHost.reduce()` → persist (snapshot + append-only log) → broadcast, redacted per
 *   recipient.
 *
 * Redaction is not optional: a player must never receive another player's active faces, and a
 * spectator must never receive anyone's hand. `view.ts` in the engine owns those rules; this object
 * only routes their output to the right sockets.
 *
 * ## Computer players
 *
 * A bot is a perfectly ordinary seat. The engine does not know it exists — to the reducer it is a
 * `Player` like any other — and its moves take the *same* path a human's do: build an action,
 * `reduce`, persist, broadcast. What this object adds is the two things a bot has no other way to
 * get: a body (an alarm that wakes the room when it is the bot's move) and a memory for its
 * coin-flips (`bots.rng`, threaded through `decideBot` so the bot is as replayable as the deal).
 *
 * The bot decides from `viewFor(state, botId)` — the identical redacted view the human at that seat
 * would receive. It therefore *cannot* cheat, and that is structural, not a promise.
 *
 * ## The clock
 *
 * Somebody's phone always dies mid-round, so every outstanding decision a *person* owes is on a
 * timer: the object stores a deadline, arms a storage alarm for it, ships the time remaining to
 * every screen, and — if the alarm beats the player to it — hands the engine a `timeout` action
 * that forfeits exactly that one decision. See `#updateClock` and `#forfeitIfExpired` below.
 *
 * ## Leaving
 *
 * Two things take a player out of a game for good (D18), and the room is where both are noticed:
 * the clock running out on them several times in a row — which the engine counts, and acts on
 * inside the same `timeout` action — and their last connection closing and *staying* closed. A
 * closed socket is all the room ever sees of a closed tab, and it is also all it sees of a reload
 * or a deploy, so the seat is held for a short grace period (`absences`, below) and the player is
 * dropped only if nobody has reclaimed it by the end. Before the deal the same thing simply takes
 * them off the roster.
 *
 * A Durable Object has exactly **one** alarm and these are three errands for it, so `#armAt` arms
 * it for whichever is due first and `alarm()` runs whatever is actually due on arrival. All three
 * are idempotent, because alarm delivery is at-least-once and a hibernated object can be woken
 * early.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  DEFAULT_OPTIONS,
  LocalRuleHost,
  UNOFLIP_PACK_ID,
  cardIdForKey,
  colorsFor,
  decideBot,
  playerToAct,
  redactEvents,
  seedRng,
  tableView,
  viewFor,
} from '@flipside/engine'
import type {
  Action,
  BotDifficulty,
  BotIntent,
  Color,
  GameEvent,
  GameState,
  PhaseName,
  RngState,
} from '@flipside/engine'
import {
  BOT_CLIENT_PREFIX,
  MAX_BOTS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  parseClientMessage,
} from '@flipside/protocol'
import type {
  ClientMessage,
  ConnectRole,
  LobbyPlayer,
  ServerMessage,
  TimerView,
} from '@flipside/protocol'
import type { Env } from './env.js'

const ruleHost = new LocalRuleHost()

/**
 * A recipient id that can never equal a real player id (those are `p_…`). Passing it to the
 * engine's redactor yields exactly the spectator's entitlement: public events only, no hands.
 */
const SPECTATOR_RECIPIENT = 'spectator'

/**
 * How long the room waits before playing a bot's move.
 *
 * This is a *feel* number, not a performance one. Bots resolve in microseconds, and a table where
 * three of them fire instantly the moment you play reads as a glitch rather than as opponents —
 * you never see which card went down. The pause also paces the client's event queue, which plays
 * the animations one broadcast at a time.
 */
const DEFAULT_BOT_DELAY_MS = 900

/**
 * The extra beat a bot waits when a human is one card down and has not said UNO.
 *
 * *"if you are caught before the next player begins their turn"* — so a bot catching you the instant
 * its turn arrives is exactly the rule, and also unplayable: nobody finds and taps the UNO button in
 * under a second. This is the grace period that makes the rule fair against a screen. Expressed as a
 * multiple of the base delay, so turning the pacing off for tests turns this off with it.
 */
const BOT_CALLOUT_GRACE = 3

/**
 * How long a seat is held after its player's last connection closes.
 *
 * Nobody is dropped *on* the close, because the close cannot say why it happened: a closed tab, a
 * reload, a phone walking through a dead spot and a deploy (which cuts every socket in the room at
 * once) all look identical from here. So a closed tab gets a moment's dwell in case it was an
 * accident: reopen the page inside it and the seat is still yours. A reload is back in a second or
 * two, and after a cut the client's first two reconnect attempts land at roughly 3 and 7 seconds —
 * both inside this — and rejoining cancels the hold. (Its third attempt, at about 12 seconds, does
 * not: raise this before lengthening the client's back-off.)
 *
 * It is deliberately shorter than the turn clock: if the absent player is the one everybody is
 * waiting on, the table should not wait *longer* for an empty chair than it would for a slow one.
 */
const DISCONNECT_GRACE_MS = 10_000

/** Names for computer players. Handed out in order; a room of ten will not run out. */
const BOT_NAMES = ['Byte', 'Circuit', 'Domino', 'Echo', 'Fable', 'Glitch', 'Hexa', 'Iris', 'Jinx']

/**
 * The move to make when a bot owed the table an action and every intent it offered was refused.
 * Always legal in the phase it names, and always ends the bot's obligation.
 */
function fallbackIntent(state: GameState): BotIntent {
  switch (state.phase.t) {
    case 'awaitingDrawnCardChoice':
      return { t: 'pass' }
    case 'awaitingColorChoice':
      return { t: 'chooseColor', color: colorsFor(state.side)[0] as Color }
    case 'awaitingChallenge':
      return { t: 'acceptDraw' }
    default:
      return { t: 'draw' }
  }
}

/** A bot's stored RNG. A row we cannot read is reseeded from itself rather than crashing the room. */
function parseRng(raw: string): RngState {
  try {
    const parsed = JSON.parse(raw) as Partial<RngState> | null
    if (typeof parsed?.hi === 'number' && typeof parsed?.lo === 'number') {
      return { hi: parsed.hi, lo: parsed.lo }
    }
  } catch {
    // fall through to a fresh seed
  }
  return seedRng(raw)
}

/** Per-socket identity, small enough to live in the ≤16 KiB WebSocket attachment. Never game state. */
interface Attachment {
  playerId: string
  seat: number
  role: ConnectRole
  clientId: string
}

interface RoomRow {
  code: string
  seed: string
  pack_id: string
  host: string | null
  started: number
  created_at: number
}

interface PlayerRow {
  id: string
  client_id: string
  name: string
  seat: number
  connected: number
}

/** The armed turn clock: one row, or none when nobody is on the clock. */
interface ClockRow {
  player: string
  phase: PhaseName
  duration: number
  /** Epoch ms. Persisted rather than held in a field, because the object hibernates between moves. */
  deadline: number
}

/**
 * How long the room gives a player per decision. It is a rule option (so a house game can lengthen
 * it, or switch it off with 0), read defensively: a snapshot written before the clock existed has no
 * value for it, and that should mean "the default", not "no clock".
 */
function timeoutMs(state: GameState): number {
  const ms = state.options.turnTimeoutMs
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_OPTIONS.turnTimeoutMs
  return Math.max(0, ms)
}

/** The bot-only half of a seat. A `players` row exists alongside every one of these. */
interface BotRow {
  player_id: string
  difficulty: BotDifficulty
  /** `RngState`, JSON. The bot's private entropy, advanced and stored on every decision. */
  rng: string
}

export class GameRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.#ensureSchema()
    // Heartbeats keep the socket alive without waking the object out of hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  #ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        code TEXT NOT NULL,
        seed TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        host TEXT,
        started INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        client_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        seat INTEGER NOT NULL,
        connected INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS actions (
        seq INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        seq INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_clock (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        player TEXT NOT NULL,
        phase TEXT NOT NULL,
        duration INTEGER NOT NULL,
        deadline INTEGER NOT NULL
      );
      -- Bots live beside the players table, not inside it, so a room created before computer
      -- players existed picks this up on its next wake with no column migration.
      CREATE TABLE IF NOT EXISTS bots (
        player_id TEXT PRIMARY KEY,
        difficulty TEXT NOT NULL,
        rng TEXT NOT NULL
      );
      -- Seats being held for players whose last connection has closed, and until when. One row per
      -- absent player; rejoining deletes it. Stored for the same reason the turn clock is: the
      -- object hibernates, and can be evicted, long before a grace period is up.
      CREATE TABLE IF NOT EXISTS absences (
        player_id TEXT PRIMARY KEY,
        deadline INTEGER NOT NULL
      );
    `)
  }

  // -------------------------------------------------------------------------------------------
  // RPC — called by the Worker
  // -------------------------------------------------------------------------------------------

  /**
   * Claim a code for this object. Called by `/api/room`. Idempotent-ish: if this object already
   * hosts a room the caller is told `created: false` and should mint a different code.
   */
  async createRoom(code: string): Promise<{ created: boolean }> {
    if (this.#room()) return { created: false }
    this.sql.exec(
      'INSERT INTO room (id, code, seed, pack_id, started, created_at) VALUES (0, ?, ?, ?, 0, ?)',
      code,
      crypto.randomUUID(),
      UNOFLIP_PACK_ID,
      Date.now(),
    )
    return { created: true }
  }

  // -------------------------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }

    // Accept the socket even if the room does not exist. `join` then rejects a bad code with a
    // *fatal* error the client can show and stop on — a 404 at the upgrade would instead just make
    // the client's reconnecting socket retry forever with nothing to display.
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
    const parsed = parseClientMessage(raw)
    if (!parsed.ok) {
      this.#send(ws, { t: 'error', code: 'bad_message', message: parsed.error, fatal: false })
      return
    }
    const msg = parsed.msg

    if (msg.t === 'join') return this.#onJoin(ws, msg)

    const att = ws.deserializeAttachment() as Attachment | null
    if (!att) {
      this.#send(ws, { t: 'error', code: 'bad_message', message: 'send join first', fatal: true })
      ws.close(1008, 'join first')
      return
    }

    if (msg.t === 'resync') {
      await this.#reassertAlarm()
      return this.#sendCurrent(ws, att)
    }
    if (msg.t === 'start') return this.#onStart(ws, att)
    if (msg.t === 'addBot') return this.#onAddBot(ws, att, msg.difficulty)
    if (msg.t === 'removeBot') return this.#onRemoveBot(ws, att, msg.playerId)
    return this.#onAction(ws, att, msg)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.#onSocketGone(ws)
    ws.close(code, reason)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#onSocketGone(ws)
  }

  /**
   * A socket dropped. Mark the player away — and start holding their seat — only if this was their
   * *last* connection: a player may legitimately hold several (a phone and a laptop, or two tabs),
   * and closing one of them is not leaving. Nor is a spectator's socket anybody's seat at all.
   */
  async #onSocketGone(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null
    if (att?.role !== 'player') return
    if (this.#hasSocketFor(att.playerId, ws)) return
    this.sql.exec('UPDATE players SET connected = 0 WHERE id = ?', att.playerId)
    await this.#holdSeat(att.playerId)
    this.#broadcastRoster()
  }

  /** Does this player have a live connection — other than `except`, if one is on its way out? */
  #hasSocketFor(playerId: string, except?: WebSocket): boolean {
    for (const other of this.ctx.getWebSockets()) {
      if (other === except) continue
      const att = other.deserializeAttachment() as Attachment | null
      if (att?.playerId === playerId) return true
    }
    return false
  }

  // -------------------------------------------------------------------------------------------
  // Join / reconnect
  // -------------------------------------------------------------------------------------------

  async #onJoin(ws: WebSocket, msg: Extract<ClientMessage, { t: 'join' }>): Promise<void> {
    const room = this.#room()
    if (!room) {
      this.#send(ws, { t: 'error', code: 'not_found', message: 'no such room', fatal: true })
      ws.close(1008, 'no such room')
      return
    }

    // Before answering with a snapshot: make sure the running deadline still has an alarm behind it,
    // so the countdown this socket is about to be handed is one that will actually fire. A room that
    // was mid-turn across a deploy is exactly the case this covers.
    await this.#reassertAlarm()

    // The projected table view joins as a spectator, and it usually runs in the same browser as one
    // of the players — so it carries that player's clientId. Honour the requested role *first*:
    // otherwise the reconnect lookup below would mistake the spectator for the player, hand it a
    // player view, and never send the tableSync the table screen waits for.
    if (msg.role === 'spectator') {
      const att: Attachment = {
        playerId: `${SPECTATOR_RECIPIENT}:${crypto.randomUUID()}`,
        seat: -1,
        role: 'spectator',
        clientId: msg.clientId,
      }
      ws.serializeAttachment(att)
      this.#sendWelcome(ws, att)
      this.#sendCurrent(ws, att)
      return
    }

    // `bot:` ids belong to computer players. The wire schema already refuses them, so reaching
    // here means the schema and this object disagree — fail closed rather than fall through to the
    // INSERT below, which would hit the client_id uniqueness constraint and take the socket down.
    if (msg.clientId.startsWith(BOT_CLIENT_PREFIX)) {
      this.#send(ws, { t: 'error', code: 'bad_message', message: 'that client id is reserved', fatal: true })
      ws.close(1008, 'reserved client id')
      return
    }

    // A returning player is recognised by their persisted clientId and handed back their seat —
    // this is the whole reconnect story, and every deploy exercises it.
    const existing = this.#playerByClient(msg.clientId)
    if (existing) {
      const att: Attachment = {
        playerId: existing.id,
        seat: existing.seat,
        role: 'player',
        clientId: msg.clientId,
      }
      ws.serializeAttachment(att)
      this.sql.exec('UPDATE players SET connected = 1, name = ? WHERE id = ?', msg.nickname, existing.id)
      // They are back, so the seat is no longer being held against a deadline. (The alarm armed for
      // that deadline still comes round; it finds nothing due and re-arms for whatever is.)
      this.sql.exec('DELETE FROM absences WHERE player_id = ?', existing.id)
      // Note: we do *not* close the player's other sockets. A player may hold several at once
      // (multiple devices/tabs); each is a valid mirror and all receive the same broadcasts.
      this.#sendWelcome(ws, att)
      this.#sendCurrent(ws, att)
      this.#broadcastRoster()
      return
    }

    if (room.started) {
      this.#send(ws, {
        t: 'error',
        code: 'not_found',
        message: 'the game has already started; join as a spectator',
        fatal: true,
      })
      ws.close(1008, 'already started')
      return
    }

    const players = this.#players()
    if (players.length >= MAX_PLAYERS) {
      this.#send(ws, { t: 'error', code: 'room_full', message: 'this room is full', fatal: true })
      ws.close(1008, 'room full')
      return
    }

    const seat = players.length
    const playerId = `p_${crypto.randomUUID()}`
    this.sql.exec(
      'INSERT INTO players (id, client_id, name, seat, connected) VALUES (?, ?, ?, ?, 1)',
      playerId,
      msg.clientId,
      msg.nickname,
      seat,
    )
    if (!room.host) this.sql.exec('UPDATE room SET host = ? WHERE id = 0', playerId)

    const att: Attachment = { playerId, seat, role: 'player', clientId: msg.clientId }
    ws.serializeAttachment(att)
    this.#sendWelcome(ws, att)
    this.#broadcastRoster()
  }

  // -------------------------------------------------------------------------------------------
  // Start / actions
  // -------------------------------------------------------------------------------------------

  async #onStart(ws: WebSocket, att: Attachment): Promise<void> {
    const room = this.#room()
    if (!room) return
    if (att.playerId !== room.host) {
      this.#send(ws, { t: 'error', code: 'not_host', message: 'only the host can start', fatal: false })
      return
    }

    // `start` does double duty: it opens the very first round, and — once a round is over — it
    // deals the next one. Both go through `startRound`; the only difference is whether we first
    // have to build the game from the seated players.
    if (room.started) {
      const snap = this.#snapshot()
      if (!snap || snap.state.phase.t !== 'roundOver') {
        this.#send(ws, { t: 'error', code: 'wrong_phase', message: 'a round is already in progress', fatal: false })
        return
      }
      const next = await ruleHost.reduce(snap.state, { type: 'startRound' })
      if (!next.ok) {
        this.#send(ws, { t: 'error', code: next.code, message: next.message, fatal: false })
        return
      }
      this.#persist(next.state, { type: 'startRound' })
      await this.#rearm(next.state, { type: 'startRound' })
      this.#broadcast(next.state, next.events)
      return
    }

    const players = this.#players()
    if (players.length < MIN_PLAYERS) {
      this.#send(ws, {
        t: 'error',
        code: 'not_enough_players',
        message: `need at least ${MIN_PLAYERS} players`,
        fatal: false,
      })
      return
    }

    const initial = await ruleHost.createGame({
      packId: room.pack_id,
      players: players.map(p => ({ id: p.id, name: p.name })),
      seed: room.seed,
    })
    const started = await ruleHost.reduce(initial, { type: 'startRound' })
    if (!started.ok) {
      this.#send(ws, { t: 'error', code: started.code, message: started.message, fatal: false })
      return
    }

    this.sql.exec('UPDATE room SET started = 1 WHERE id = 0')
    this.#persist(started.state, { type: 'startRound' })
    // The deal can hand the first turn straight to a bot, or start a human's clock, so arming is
    // not only a post-action concern.
    await this.#rearm(started.state, { type: 'startRound' })
    this.#broadcast(started.state, started.events)
  }

  // -------------------------------------------------------------------------------------------
  // Computer players
  // -------------------------------------------------------------------------------------------

  /**
   * Seat a bot. Host-only and lobby-only, because `createGame` fixes the seat list when the first
   * round is dealt — there is no such thing as joining a game in progress, for a person or a bot.
   */
  #onAddBot(ws: WebSocket, att: Attachment, difficulty: BotDifficulty): void {
    const room = this.#room()
    if (!room) return
    if (att.playerId !== room.host) {
      this.#send(ws, { t: 'error', code: 'not_host', message: 'only the host can add players', fatal: false })
      return
    }
    if (room.started) {
      this.#send(ws, {
        t: 'error',
        code: 'wrong_phase',
        message: 'computer players have to be added before the game starts',
        fatal: false,
      })
      return
    }

    const players = this.#players()
    if (players.length >= MAX_PLAYERS) {
      this.#send(ws, { t: 'error', code: 'room_full', message: 'this room is full', fatal: false })
      return
    }
    if (this.#bots().length >= MAX_BOTS) {
      this.#send(ws, {
        t: 'error',
        code: 'room_full',
        message: 'that is as many computer players as a room can hold',
        fatal: false,
      })
      return
    }

    const playerId = `p_${crypto.randomUUID()}`
    const taken = players.map(p => p.name)
    const name = BOT_NAMES.find(n => !taken.includes(n)) ?? `Bot ${players.length + 1}`

    this.sql.exec(
      'INSERT INTO players (id, client_id, name, seat, connected) VALUES (?, ?, ?, ?, 1)',
      playerId,
      // A reserved namespace: the wire schema refuses this prefix from a browser, and
      // `#playerByClient` skips bot rows regardless.
      `${BOT_CLIENT_PREFIX}${playerId}`,
      name,
      players.length,
    )
    this.sql.exec(
      'INSERT INTO bots (player_id, difficulty, rng) VALUES (?, ?, ?)',
      playerId,
      difficulty,
      JSON.stringify(seedRng(crypto.randomUUID())),
    )
    this.#broadcastRoster()
  }

  /** Free a bot's seat and close the gap, so seats stay `0..n-1` for the next player to join. */
  #onRemoveBot(ws: WebSocket, att: Attachment, playerId: string): void {
    const room = this.#room()
    if (!room) return
    if (att.playerId !== room.host) {
      this.#send(ws, { t: 'error', code: 'not_host', message: 'only the host can remove players', fatal: false })
      return
    }
    if (room.started) {
      this.#send(ws, { t: 'error', code: 'wrong_phase', message: 'the game has already started', fatal: false })
      return
    }
    if (!this.#botFor(playerId)) {
      // Deliberately not "kick a human": that is a different feature with different consent.
      this.#send(ws, { t: 'error', code: 'bad_message', message: 'that seat is not a computer player', fatal: false })
      return
    }

    this.sql.exec('DELETE FROM bots WHERE player_id = ?', playerId)
    this.sql.exec('DELETE FROM players WHERE id = ?', playerId)
    this.#reseat()
    this.#broadcastRoster()
  }

  /**
   * Renumber seats to close a gap. `#onJoin` allocates `seat = players.length`, so a hole left by a
   * removed bot would otherwise hand two players the same seat number.
   */
  #reseat(): void {
    const players = this.#players()
    const moved: Record<string, number> = {}
    players.forEach((p, index) => {
      if (p.seat === index) return
      this.sql.exec('UPDATE players SET seat = ? WHERE id = ?', index, p.id)
      moved[p.id] = index
    })
    if (Object.keys(moved).length === 0) return

    // Attachments carry a copy of the seat; leave them stale and a reconnecting client would be
    // told a seat that no longer exists.
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (!att) continue
      const seat = moved[att.playerId]
      if (seat === undefined) continue
      ws.serializeAttachment({ ...att, seat })
    }
  }

  // -------------------------------------------------------------------------------------------
  // The bot driver
  // -------------------------------------------------------------------------------------------

  /**
   * Arm the room's one alarm for whichever of its two errands is due first: a bot's next move, or
   * a player's deadline running out.
   *
   * An **alarm**, never a `setTimeout`: a pending timer pins the object out of hibernation for the
   * whole delay and bills for it, and it does not survive eviction — which is exactly the window a
   * bot's move sits in. The alarm is stored, so an evicted room still comes back to take its turn.
   *
   * A Durable Object gets exactly one alarm, so the two deadlines share a slot and `alarm()`
   * re-derives what is actually due on arrival rather than trusting why it was set.
   */
  async #rearm(state: GameState, action: Action | null): Promise<void> {
    await this.#armAt(this.#updateClock(state, action), this.#botWakeAt(state))
  }

  /**
   * The earliest of the times given, or no alarm at all if the room is waiting on nothing.
   *
   * Every arming of the alarm comes through here, which makes it the one place the third errand —
   * a seat being held for somebody who has disconnected — has to be weighed in. Callers name the
   * deadlines that come from the *game*; the ones that come from the sockets are added for them.
   */
  async #armAt(...times: (number | null)[]): Promise<void> {
    const due = [...times, this.#nextAbsenceAt()].filter((t): t is number => t !== null)
    if (due.length === 0) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    // A time already in the past is fine to arm for: it simply fires at once.
    await this.ctx.storage.setAlarm(Math.min(...due))
  }

  /** When a bot next wants to move, or null if no bot has anything to do. */
  #botWakeAt(state: GameState): number | null {
    const delay = this.#botWakeIn(state)
    return delay === null ? null : Date.now() + delay
  }

  /**
   * One bot move per alarm, or false if no bot had anything to do.
   *
   * Idempotent by construction: it re-derives everything from the stored snapshot, so a duplicate
   * delivery (alarms are at-least-once) simply finds nothing left to do and returns. Each accepted
   * move broadcasts and re-arms — so a table of bots plays itself one legible step at a time
   * rather than in a single burst.
   */
  async #takeBotTurn(state: GameState): Promise<boolean> {
    if (!this.#anyoneHome(state)) return false

    for (const bot of this.#bots()) {
      if (!state.players.some(p => p.id === bot.player_id)) continue

      let decision
      try {
        decision = decideBot(viewFor(state, bot.player_id), parseRng(bot.rng), bot.difficulty)
      } catch {
        continue // a bot that cannot even form an opinion must not take the room down
      }
      // The roll is spent whether or not it produced a move. Persisting it is what stops a bot that
      // declined a callout from re-rolling the same decision on every future wake.
      this.sql.exec(
        'UPDATE bots SET rng = ? WHERE player_id = ?',
        JSON.stringify(decision.rng),
        bot.player_id,
      )
      if (!decision.intent) continue
      if (await this.#applyBotIntent(state, bot.player_id, decision.intent)) return true
    }

    // Nothing was accepted. If a bot still owes the table a move, the game is stuck — so take the
    // dullest legal action there is rather than leave the room waiting on a seat that cannot act.
    // This should never fire; if it does, the bug is in `decideBot` and the game still goes on.
    const owed = playerToAct(state)
    if (owed && this.#botFor(owed)) {
      return this.#applyBotIntent(state, owed, fallbackIntent(state))
    }
    return false
  }

  async #applyBotIntent(state: GameState, playerId: string, intent: BotIntent): Promise<boolean> {
    const built = this.#toAction(state, playerId, intent)
    if (!built.ok) return false
    const result = await ruleHost.reduce(state, built.action)
    if (!result.ok) return false

    this.#persist(result.state, built.action)
    await this.#rearm(result.state, built.action)
    this.#broadcast(result.state, result.events)
    return true
  }

  /**
   * How long to wait before waking for a bot, or null if no bot has anything to do.
   *
   * The "might" is deliberate — this is a cheap, RNG-free *over*-approximation, and that is the
   * right side to err on: a false positive costs one wake that finds nothing and schedules nothing,
   * while a false negative stalls the room forever. Note it is not only about whose turn it is: an
   * open UNO window is a decision for every bot at the table.
   */
  #botWakeIn(state: GameState): number | null {
    const bots = new Set(this.#bots().map(b => b.player_id))
    if (bots.size === 0) return null
    if (!this.#anyoneHome(state)) return null

    const base = this.#botDelayMs()
    const owed = playerToAct(state)
    const botOwesTheTurn = owed !== null && bots.has(owed)

    let calloutOpen = false
    let humanIsExposed = false
    if (state.unoWindow !== null) {
      const owner = state.players.find(p => p.id === state.unoWindow)
      if (owner && !owner.saidUno && owner.hand.length === 1) {
        // The owner may rescue itself; anyone else may catch it.
        calloutOpen =
          bots.has(owner.id) || state.players.some(p => p.id !== owner.id && bots.has(p.id))
        humanIsExposed = calloutOpen && !bots.has(owner.id)
      }
    }

    if (!botOwesTheTurn && !calloutOpen) return null
    // Hold the whole turn back, not just the callout: a bot that plays first and pounces second
    // would give the same non-existent reaction window by another route.
    return humanIsExposed ? base * BOT_CALLOUT_GRACE : base
  }

  /**
   * Is any *person* still playing this game?
   *
   * When the last of them has been dropped the computer players stop where they are. To the engine
   * two bots are a perfectly good two-player game, and left to it they would play on to 500 points
   * one alarm at a time, for an audience of nobody, keeping the object awake for all of it.
   */
  #anyoneHome(state: GameState): boolean {
    const bots = new Set(this.#bots().map(b => b.player_id))
    return state.players.some(p => !p.dropped && !bots.has(p.id))
  }

  #botDelayMs(): number {
    const raw = Number(this.env.BOT_DELAY_MS)
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BOT_DELAY_MS
  }

  async #onAction(ws: WebSocket, att: Attachment, msg: ClientMessage): Promise<void> {
    const snap = this.#snapshot()
    if (!snap) {
      this.#send(ws, { t: 'error', code: 'wrong_phase', message: 'the game has not started', fatal: false })
      return
    }

    const built = this.#toAction(snap.state, att.playerId, msg)
    if (!built.ok) {
      this.#send(ws, { t: 'error', code: built.code, message: built.message, fatal: false })
      return
    }

    const result = await ruleHost.reduce(snap.state, built.action)
    if (!result.ok) {
      this.#send(ws, { t: 'error', code: result.code, message: result.message, fatal: false })
      return
    }

    this.#persist(result.state, built.action)
    // Arm before broadcasting: the frames carry the time remaining, so the clock has to be the new
    // one by the time they are built.
    await this.#rearm(result.state, built.action)
    this.#broadcast(result.state, result.events)
  }

  /**
   * Turn a validated wire message into an engine action, resolving the card alias for `play`.
   *
   * It takes a bot's intent too, and that is the point: a `BotIntent` is structurally the same
   * shape as the game half of `ClientMessage`, so a computer player's move is built, validated and
   * reduced by literally the same code as yours.
   */
  #toAction(
    state: GameState,
    playerId: string,
    msg: ClientMessage | BotIntent,
  ): { ok: true; action: Action } | { ok: false; code: 'unknown_card' | 'bad_message'; message: string } {
    switch (msg.t) {
      case 'play': {
        const card = cardIdForKey(state, msg.key)
        if (!card) return { ok: false, code: 'unknown_card', message: 'no such card in this round' }
        return {
          ok: true,
          action: { type: 'play', player: playerId, card, declaredColor: msg.declaredColor },
        }
      }
      case 'draw':
        return { ok: true, action: { type: 'draw', player: playerId } }
      case 'pass':
        return { ok: true, action: { type: 'pass', player: playerId } }
      case 'chooseColor':
        return { ok: true, action: { type: 'chooseColor', player: playerId, color: msg.color } }
      case 'challenge':
        return { ok: true, action: { type: 'challenge', player: playerId } }
      case 'acceptDraw':
        return { ok: true, action: { type: 'acceptDraw', player: playerId } }
      case 'callUno':
        return { ok: true, action: { type: 'callUno', player: playerId } }
      case 'callout':
        return { ok: true, action: { type: 'callout', player: playerId, target: msg.target } }
      default:
        return { ok: false, code: 'bad_message', message: 'not a game action' }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The turn clock
  // -------------------------------------------------------------------------------------------

  /**
   * Put the outstanding decision on the clock, or take the clock away if there is no decision left,
   * and answer with the deadline the room should wake at (null when nobody is on the clock).
   * Arming is `#rearm`'s job, because the alarm is shared with the bot driver.
   *
   * The engine names the debtor (`playerToAct`); this only decides *when* their time is up. Three
   * properties matter:
   *
   * - **A new decision gets a full window; an unrelated action does not extend the old one.** An
   *   opponent shouting UNO or calling someone out does not change whose decision it is, and nor
   *   does somebody else being dropped from the game, so those leave the running deadline exactly
   *   where it was — otherwise a table could keep a player's clock topped up indefinitely, or
   *   (worse) reset it every time anyone did anything.
   * - **A running clock is kept, not restarted.** `null` (a reconnect, a resync, a stale wake)
   *   means "the current deadline still stands", never "start again".
   * - **A bot is never on the clock.** Its seat is *driven* — the alarm that matters there is the
   *   one that makes its move, and forfeiting would narrate a player who has wandered off when in
   *   fact the room is about to play for them. The clock exists for the phone that died.
   */
  #updateClock(state: GameState, action: Action | null): number | null {
    const player = playerToAct(state)
    const duration = timeoutMs(state)

    if (player === null || duration === 0 || this.#botFor(player)) {
      this.#clearClock()
      return null
    }

    // `callUno`, `callout` and a `drop` of somebody else are the only actions that can leave the
    // same player owing the same decision afterwards. Every other action begins a new one. (A drop
    // of the player who *was* on the clock moves the decision to somebody else, and the comparison
    // below gives them a window of their own.)
    const continuing =
      action === null || action.type === 'callUno' || action.type === 'callout' || action.type === 'drop'
    const running = this.#clock()
    if (continuing && running && running.player === player && running.phase === state.phase.t) {
      return running.deadline
    }

    const deadline = Date.now() + duration
    this.sql.exec(
      'INSERT OR REPLACE INTO turn_clock (id, player, phase, duration, deadline) VALUES (0, ?, ?, ?, ?)',
      player,
      state.phase.t,
      duration,
      deadline,
    )
    return deadline
  }

  /**
   * Re-arm the room's alarm from stored state, without shortening or extending a running clock.
   * A room that was mid-turn across a deploy, or is being resynced by a returning phone, is exactly
   * the case this covers: the countdown that socket is about to be handed has to be one that will
   * actually fire.
   */
  async #reassertAlarm(): Promise<void> {
    const snap = this.#snapshot()
    if (!snap) return
    await this.#rearm(snap.state, null)
  }

  /** Take the clock away. The alarm itself belongs to `#armAt`, which the bot driver shares. */
  #clearClock(): void {
    this.sql.exec('DELETE FROM turn_clock WHERE id = 0')
  }

  #clock(): ClockRow | null {
    const rows = this.sql
      .exec('SELECT player, phase, duration, deadline FROM turn_clock WHERE id = 0')
      .toArray() as unknown as ClockRow[]
    return rows[0] ?? null
  }

  /**
   * The countdown as it goes on the wire. A **duration**, not a deadline: the room's phones do not
   * agree on what time it is, and each client anchors this against its own monotonic clock the
   * instant the frame arrives. Every screen therefore shows the same number.
   */
  #timerView(): TimerView | null {
    const clock = this.#clock()
    if (!clock) return null
    return {
      player: clock.player,
      phase: clock.phase,
      durationMs: clock.duration,
      remainingMs: Math.max(0, clock.deadline - Date.now()),
    }
  }

  /**
   * The clock ran out. Forfeit the one outstanding decision on the absent player's behalf — the
   * engine decides what that costs them (`doTimeout` in `reduce.ts`); this only establishes that the
   * time really has passed. Answers whether it acted, so the shared `alarm()` knows whether the
   * wake is spent.
   *
   * Alarms are delivered **at least once** and can wake a hibernated object early, so every `false`
   * below leaves the game exactly as it was and hands the wake back to `alarm()` to re-arm:
   *
   * - no clock → nobody is on one (the lobby, a bot's turn, `turnTimeoutMs: 0`);
   * - the deadline is still in the future → an early wake, or a wake meant for a bot;
   * - the decision has moved on since the alarm was set (someone played, in the gap) → the new one
   *   gets its own window; the old one is nobody's debt now.
   *
   * So a duplicate delivery cannot take two turns from anyone: the first one changes the phase, and
   * the second finds a clock that no longer matches it.
   */
  async #forfeitIfExpired(state: GameState): Promise<boolean> {
    const clock = this.#clock()
    if (!clock || clock.deadline > Date.now()) return false

    const owed = playerToAct(state)
    if (owed === null || owed !== clock.player || state.phase.t !== clock.phase) return false

    const action: Action = { type: 'timeout', player: clock.player }
    const result = await ruleHost.reduce(state, action)
    if (!result.ok) {
      // The engine refused the forfeit. Nothing here can fix that, and a fresh window would spin on
      // the same refusal every 30 seconds, so drop the clock and let the next real action start
      // one. The bot driver still needs its wake.
      this.#clearClock()
      await this.#armAt(this.#botWakeAt(state))
      return true
    }

    this.#persist(result.state, action)
    await this.#rearm(result.state, action)
    this.#broadcast(result.state, result.events)
    // One timeout too many drops the player (D18), and the player may have been the host.
    this.#handOffHost(result.state)
    return true
  }

  // -------------------------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------------------------

  /**
   * Start holding a seat for a player whose last connection has just closed, and make sure the
   * room wakes when the hold runs out.
   *
   * The alarm is only ever brought *forward* here. Whatever it was already armed for — a bot's
   * move, a turn's deadline — is still due, and `alarm()` re-arms for the rest once it has dealt
   * with whichever comes first.
   */
  async #holdSeat(playerId: string): Promise<void> {
    if (!this.#isStillIn(playerId)) return

    const deadline = Date.now() + DISCONNECT_GRACE_MS
    this.sql.exec('INSERT OR REPLACE INTO absences (player_id, deadline) VALUES (?, ?)', playerId, deadline)
    const armed = await this.ctx.storage.getAlarm()
    if (armed === null || armed > deadline) await this.ctx.storage.setAlarm(deadline)
  }

  /** Is there anything left to drop this player from? Not once they are out, or the game is over. */
  #isStillIn(playerId: string): boolean {
    const snap = this.#snapshot()
    if (!snap) return this.#players().some(p => p.id === playerId)
    if (snap.state.phase.t === 'gameOver') return false
    return snap.state.players.some(p => p.id === playerId && !p.dropped)
  }

  #nextAbsenceAt(): number | null {
    const row = this.sql.exec('SELECT MIN(deadline) AS at FROM absences').toArray()[0] as
      | { at: number | null }
      | undefined
    return row?.at ?? null
  }

  /**
   * Stop holding the seat of everybody whose grace period has run out, and say whether that
   * changed anything.
   *
   * Idempotent like the alarm's other errands: the row is deleted before the drop, an early wake
   * finds no row past its deadline, and a duplicate one finds no row at all.
   */
  async #dropTheAbsent(): Promise<boolean> {
    const due = this.sql
      .exec('SELECT player_id FROM absences WHERE deadline <= ? ORDER BY deadline', Date.now())
      .toArray() as unknown as Array<{ player_id: string }>

    let acted = false
    for (const { player_id: playerId } of due) {
      this.sql.exec('DELETE FROM absences WHERE player_id = ?', playerId)
      // Rejoining deletes the row, so this should never be true. But a drop cannot be taken back,
      // and "they are connected right now" is the one fact that makes it unarguably wrong.
      if (this.#hasSocketFor(playerId)) continue
      if (await this.#drop(playerId)) acted = true
    }
    return acted
  }

  /** Take an absent player out: off the roster before the deal, out of the game after it. */
  async #drop(playerId: string): Promise<boolean> {
    const snap = this.#snapshot()
    if (!snap) return this.#leaveLobby(playerId)

    const action: Action = { type: 'drop', player: playerId, reason: 'disconnected' }
    const result = await ruleHost.reduce(snap.state, action)
    // Refused means there was nothing to drop them from: they are already out, or it is all over.
    if (!result.ok) return false

    this.#persist(result.state, action)
    await this.#rearm(result.state, action)
    this.#broadcast(result.state, result.events)
    this.#handOffHost(result.state)
    return true
  }

  /**
   * Before the deal there is no game to be dropped from, only a seat to give back — so the next
   * person to join can have it, and so the host does not deal a hand to an empty chair.
   */
  #leaveLobby(playerId: string): boolean {
    const room = this.#room()
    if (!room || room.started) return false

    this.sql.exec('DELETE FROM players WHERE id = ?', playerId)
    this.#reseat()
    if (room.host === playerId) {
      // The longest-seated person still here inherits the room. If nobody is, it has no host, and
      // `#onJoin` gives it to whoever walks in next.
      const bots = new Set(this.#bots().map(b => b.player_id))
      const heir = this.#players().find(p => !bots.has(p.id))
      this.sql.exec('UPDATE room SET host = ? WHERE id = 0', heir?.id ?? null)
    }
    this.#broadcastRoster()
    return true
  }

  /**
   * Make sure the host is somebody who is still in the game, and tell every screen if that means a
   * new one. Between rounds the whole table waits on the host to deal; if the host has been
   * dropped and nobody inherits the job, that wait never ends.
   */
  #handOffHost(state: GameState): void {
    const room = this.#room()
    if (!room) return
    if (state.players.some(p => p.id === room.host && !p.dropped)) return

    const bots = new Set(this.#bots().map(b => b.player_id))
    const heir = state.players.find(p => !p.dropped && !bots.has(p.id))
    if (!heir) return // nobody is left to hand it to

    this.sql.exec('UPDATE room SET host = ? WHERE id = 0', heir.id)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()) this.#send(ws, { t: 'host', host: heir.id })
    }
  }

  // -------------------------------------------------------------------------------------------
  // The alarm
  // -------------------------------------------------------------------------------------------

  /**
   * The room's one alarm, doing its three jobs: giving up the seat of a player who disconnected and
   * never came back, forfeiting a decision whose time is up, and playing a bot's move.
   *
   * Which of them is due is re-derived from storage rather than remembered, because the deadlines
   * share the single alarm slot a Durable Object gets — a wake set for a bot can arrive to find a
   * player's clock expired, and the other way round — and because delivery is at-least-once and a
   * hibernated object can be woken early.
   *
   * Every path ends with the alarm re-armed from the state it leaves behind, so the room can never
   * lose its alarm and stall; and every path is a no-op when nothing is actually due, so a
   * duplicate delivery costs nothing.
   */
  override async alarm(): Promise<void> {
    // The absent first: dropping a player can change whose turn it is and who is on the clock, so
    // everything below has to be read from the state that leaves behind.
    const dropped = await this.#dropTheAbsent()

    const snap = this.#snapshot()
    if (!snap) {
      // No game yet — the lobby has no clock to keep, and nothing to wake for but a held seat.
      this.#clearClock()
      await this.#armAt()
      return
    }
    if (dropped) {
      // Each drop was a move in its own right: reduced, broadcast, and the clock set for whoever
      // owes the next decision. The wake is spent; leave the alarm right and go back to sleep.
      await this.#rearm(snap.state, null)
      return
    }

    // The clock first: it is the deadline that *expires*, while a bot's wake only slips.
    if (await this.#forfeitIfExpired(snap.state)) return
    if (await this.#takeBotTurn(snap.state)) return

    // Nothing came of the wake: it was early, or a duplicate, or every bot declined. Put the clock
    // back — but *not* a fresh bot wake. `#takeBotTurn` has just established that no bot will move
    // until something else changes, and re-arming for one anyway would busy-loop: a bot that
    // declines to call out a missed UNO would be asked again every 900ms for as long as the window
    // stays open. The next real action, or the clock, wakes the room instead.
    await this.#armAt(this.#updateClock(snap.state, null))
  }

  // -------------------------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------------------------

  /** Fan a reduction out to every socket, redacted for exactly what that recipient may see. */
  #broadcast(state: GameState, events: GameEvent[]): void {
    const timer = this.#timerView()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (!att) continue
      try {
        if (att.role === 'spectator') {
          this.#send(ws, {
            t: 'tableEvents',
            events: redactEvents(state, events, SPECTATOR_RECIPIENT),
            table: tableView(state),
            timer,
          })
        } else {
          this.#send(ws, {
            t: 'events',
            events: redactEvents(state, events, att.playerId),
            view: viewFor(state, att.playerId),
            timer,
          })
        }
      } catch {
        // A socket whose player is not in this state (e.g. mid-teardown) simply gets nothing.
      }
    }
  }

  #broadcastRoster(): void {
    const room = this.#room()
    if (!room || room.started) return // once the game starts, roster lives inside the view
    const players = this.#lobbyPlayers()
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (att?.role !== 'player') continue
      this.#send(ws, { t: 'roster', players, host: room.host ?? '', started: false })
    }
  }

  // -------------------------------------------------------------------------------------------
  // Per-socket sends
  // -------------------------------------------------------------------------------------------

  #sendWelcome(ws: WebSocket, att: Attachment): void {
    const room = this.#room()
    if (!room) return
    this.#send(ws, {
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      you: att.playerId,
      seat: att.seat,
      code: room.code,
      role: att.role,
      host: room.host ?? '',
      bots: this.#bots().map(b => b.player_id),
    })
  }

  /** Bring one socket fully up to date: the in-game snapshot if there is one, else the lobby roster. */
  #sendCurrent(ws: WebSocket, att: Attachment): void {
    const snap = this.#snapshot()
    if (!snap) {
      const room = this.#room()
      if (att.role === 'player' && room) {
        this.#send(ws, { t: 'roster', players: this.#lobbyPlayers(), host: room.host ?? '', started: false })
      } else if (att.role === 'spectator') {
        // Nothing to project yet; the first real snapshot will arrive as tableEvents.
      }
      return
    }
    const timer = this.#timerView()
    if (att.role === 'spectator') {
      this.#send(ws, { t: 'tableSync', table: tableView(snap.state), timer })
    } else {
      this.#send(ws, { t: 'sync', view: viewFor(snap.state, att.playerId), timer })
    }
  }

  #send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // Socket already closing; drop the frame.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Storage helpers — always read fresh; never cache game state in a field
  // -------------------------------------------------------------------------------------------

  #persist(state: GameState, action: Action): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO snapshot (id, seq, state) VALUES (0, ?, ?)',
      state.seq,
      JSON.stringify(state),
    )
    this.sql.exec(
      'INSERT OR IGNORE INTO actions (seq, action, ts) VALUES (?, ?, ?)',
      state.seq,
      JSON.stringify(action),
      Date.now(),
    )
  }

  #snapshot(): { seq: number; state: GameState } | null {
    const rows = this.sql.exec('SELECT seq, state FROM snapshot WHERE id = 0').toArray() as Array<{
      seq: number
      state: string
    }>
    const row = rows[0]
    if (!row) return null
    return { seq: row.seq, state: JSON.parse(row.state) as GameState }
  }

  #room(): RoomRow | null {
    const rows = this.sql.exec('SELECT code, seed, pack_id, host, started, created_at FROM room WHERE id = 0').toArray() as unknown as RoomRow[]
    return rows[0] ?? null
  }

  #players(): PlayerRow[] {
    return this.sql.exec('SELECT id, client_id, name, seat, connected FROM players ORDER BY seat').toArray() as unknown as PlayerRow[]
  }

  /**
   * The seat a returning browser owns. Bot seats are excluded on purpose: their `client_id` is
   * `bot:<id>`, and without this a client that guessed one could claim a computer player's hand.
   */
  #playerByClient(clientId: string): PlayerRow | null {
    const rows = this.sql
      .exec(
        `SELECT id, client_id, name, seat, connected FROM players
         WHERE client_id = ? AND id NOT IN (SELECT player_id FROM bots)`,
        clientId,
      )
      .toArray() as unknown as PlayerRow[]
    return rows[0] ?? null
  }

  #bots(): BotRow[] {
    return this.sql
      .exec(
        `SELECT b.player_id, b.difficulty, b.rng FROM bots b
         JOIN players p ON p.id = b.player_id ORDER BY p.seat`,
      )
      .toArray() as unknown as BotRow[]
  }

  #botFor(playerId: string): BotRow | null {
    const rows = this.sql
      .exec('SELECT player_id, difficulty, rng FROM bots WHERE player_id = ?', playerId)
      .toArray() as unknown as BotRow[]
    return rows[0] ?? null
  }

  #lobbyPlayers(): LobbyPlayer[] {
    const difficulty: Record<string, BotDifficulty> = {}
    for (const bot of this.#bots()) difficulty[bot.player_id] = bot.difficulty
    return this.#players().map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: p.connected === 1,
      bot: difficulty[p.id] ?? null,
    }))
  }
}
