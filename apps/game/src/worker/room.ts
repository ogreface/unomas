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
 */

import { DurableObject } from 'cloudflare:workers'
import {
  LocalRuleHost,
  UNOFLIP_PACK_ID,
  cardIdForKey,
  colorsFor,
  decideBot,
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
  PlayerId,
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

/** Names for computer players. Handed out in order; a room of ten will not run out. */
const BOT_NAMES = ['Byte', 'Circuit', 'Domino', 'Echo', 'Fable', 'Glitch', 'Hexa', 'Iris', 'Jinx']

/**
 * Who the reducer is currently waiting on, or null if it is waiting on nobody (a finished round,
 * the lobby). This is the same question `view.ts` answers per player, asked of the whole table.
 */
function owesAction(state: GameState): PlayerId | null {
  switch (state.phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return state.players[state.turn]?.id ?? null
    case 'awaitingColorChoice':
      return state.phase.chooser
    case 'awaitingChallenge':
      return state.phase.challenger
    default:
      return null
  }
}

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
      -- Bots live beside the players table, not inside it, so a room created before computer
      -- players existed picks this up on its next wake with no column migration.
      CREATE TABLE IF NOT EXISTS bots (
        player_id TEXT PRIMARY KEY,
        difficulty TEXT NOT NULL,
        rng TEXT NOT NULL
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

    if (msg.t === 'resync') return this.#sendCurrent(ws, att)
    if (msg.t === 'start') return this.#onStart(ws, att)
    if (msg.t === 'addBot') return this.#onAddBot(ws, att, msg.difficulty)
    if (msg.t === 'removeBot') return this.#onRemoveBot(ws, att, msg.playerId)
    return this.#onAction(ws, att, msg)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#onSocketGone(ws)
    ws.close(code, reason)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#onSocketGone(ws)
  }

  /**
   * A socket dropped. Mark the player away only if this was their *last* connection — a player may
   * legitimately hold several (a phone and a laptop, or two tabs), and closing one must not evict
   * them from the game.
   */
  #onSocketGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null
    if (att?.role !== 'player') return
    if (this.#hasOtherSocketFor(ws, att.playerId)) return
    this.sql.exec('UPDATE players SET connected = 0 WHERE id = ?', att.playerId)
    this.#broadcastRoster()
  }

  #hasOtherSocketFor(exclude: WebSocket, playerId: string): boolean {
    for (const other of this.ctx.getWebSockets()) {
      if (other === exclude) continue
      const att = other.deserializeAttachment() as Attachment | null
      if (att?.playerId === playerId) return true
    }
    return false
  }

  // -------------------------------------------------------------------------------------------
  // Join / reconnect
  // -------------------------------------------------------------------------------------------

  #onJoin(ws: WebSocket, msg: Extract<ClientMessage, { t: 'join' }>): void {
    const room = this.#room()
    if (!room) {
      this.#send(ws, { t: 'error', code: 'not_found', message: 'no such room', fatal: true })
      ws.close(1008, 'no such room')
      return
    }

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
      this.#broadcast(next.state, next.events)
      await this.#scheduleBots(next.state)
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
    this.#broadcast(started.state, started.events)
    // The deal can hand the first turn straight to a bot, so this is not only a post-action concern.
    await this.#scheduleBots(started.state)
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
   * Wake the room when a bot has something to do.
   *
   * An **alarm**, never a `setTimeout`: a pending timer pins the object out of hibernation for the
   * whole delay and bills for it, and it does not survive eviction — which is exactly the window a
   * bot's move sits in. The alarm is stored, so an evicted room still comes back to take its turn.
   */
  async #scheduleBots(state: GameState): Promise<void> {
    const delay = this.#botWakeIn(state)
    if (delay === null) return
    await this.ctx.storage.setAlarm(Date.now() + delay)
  }

  /**
   * One bot move per alarm.
   *
   * Idempotent by construction: it re-derives everything from the stored snapshot, so a duplicate
   * delivery (alarms are at-least-once) simply finds nothing left to do and returns. Each accepted
   * move broadcasts, and the broadcast schedules the next alarm — so a table of bots plays itself
   * one legible step at a time rather than in a single burst.
   */
  override async alarm(): Promise<void> {
    const snap = this.#snapshot()
    if (!snap) return
    const state = snap.state

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
      if (await this.#applyBotIntent(state, bot.player_id, decision.intent)) return
    }

    // Nothing was accepted. If a bot still owes the table a move, the game is stuck — so take the
    // dullest legal action there is rather than leave the room waiting on a seat that cannot act.
    // This should never fire; if it does, the bug is in `decideBot` and the game still goes on.
    const owed = owesAction(state)
    if (owed && this.#botFor(owed)) {
      await this.#applyBotIntent(state, owed, fallbackIntent(state))
    }
  }

  async #applyBotIntent(state: GameState, playerId: string, intent: BotIntent): Promise<boolean> {
    const built = this.#toAction(state, playerId, intent)
    if (!built.ok) return false
    const result = await ruleHost.reduce(state, built.action)
    if (!result.ok) return false

    this.#persist(result.state, built.action)
    this.#broadcast(result.state, result.events)
    await this.#scheduleBots(result.state)
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

    const base = this.#botDelayMs()
    const owed = owesAction(state)
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
    this.#broadcast(result.state, result.events)
    await this.#scheduleBots(result.state)
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
  // Broadcast
  // -------------------------------------------------------------------------------------------

  /** Fan a reduction out to every socket, redacted for exactly what that recipient may see. */
  #broadcast(state: GameState, events: GameEvent[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null
      if (!att) continue
      try {
        if (att.role === 'spectator') {
          this.#send(ws, {
            t: 'tableEvents',
            events: redactEvents(state, events, SPECTATOR_RECIPIENT),
            table: tableView(state),
          })
        } else {
          this.#send(ws, {
            t: 'events',
            events: redactEvents(state, events, att.playerId),
            view: viewFor(state, att.playerId),
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
    if (att.role === 'spectator') {
      this.#send(ws, { t: 'tableSync', table: tableView(snap.state) })
    } else {
      this.#send(ws, { t: 'sync', view: viewFor(snap.state, att.playerId) })
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
