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
 * It is also the room's **clock**. Somebody's phone always dies mid-round, so every outstanding
 * decision is on a timer: the object stores a deadline, arms a storage alarm for it, ships the time
 * remaining to every screen, and — if the alarm beats the player to it — hands the engine a
 * `timeout` action that forfeits exactly that one decision. See `#armClock` and `alarm` below.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  DEFAULT_OPTIONS,
  LocalRuleHost,
  UNOFLIP_PACK_ID,
  cardIdForKey,
  playerToAct,
  redactEvents,
  tableView,
  viewFor,
} from '@flipside/engine'
import type { Action, GameEvent, GameState, PhaseName } from '@flipside/engine'
import {
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
      await this.#reassertClock()
      return this.#sendCurrent(ws, att)
    }
    if (msg.t === 'start') return this.#onStart(ws, att)
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
    await this.#reassertClock()

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
      await this.#armClock(next.state, { type: 'startRound' })
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
    await this.#armClock(started.state, { type: 'startRound' })
    this.#broadcast(started.state, started.events)
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
    await this.#armClock(result.state, built.action)
    this.#broadcast(result.state, result.events)
  }

  /** Turn a validated wire message into an engine action, resolving the card alias for `play`. */
  #toAction(
    state: GameState,
    playerId: string,
    msg: ClientMessage,
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
   * Put the outstanding decision on the clock, or take the clock away if there is no decision left.
   *
   * The engine names the debtor (`playerToAct`); this only decides *when* their time is up. Two
   * properties matter:
   *
   * - **A new decision gets a full window; an unrelated action does not extend the old one.** An
   *   opponent shouting UNO or calling someone out does not change whose decision it is, so those
   *   leave the running deadline exactly where it was — otherwise a table could keep a player's
   *   clock topped up indefinitely, or (worse) reset it every time anyone did anything.
   * - **The alarm is re-asserted, not re-created, for a clock that is already running.** Alarm
   *   delivery is at-least-once and the previous one may already have been consumed by a wake we
   *   judged stale, so `null` (a reconnect, a resync) means "make sure the current deadline still
   *   has an alarm behind it", never "start again".
   */
  async #armClock(state: GameState, action: Action | null): Promise<void> {
    const player = playerToAct(state)
    const duration = timeoutMs(state)

    if (player === null || duration === 0) return this.#clearClock()

    // `callUno` and `callout` are the only actions that can leave the same player owing the same
    // decision afterwards. Every other action begins a new one.
    const continuing = action === null || action.type === 'callUno' || action.type === 'callout'
    const running = this.#clock()
    if (continuing && running && running.player === player && running.phase === state.phase.t) {
      // A deadline already in the past is fine to pass to setAlarm: it simply fires at once.
      await this.ctx.storage.setAlarm(running.deadline)
      return
    }

    const deadline = Date.now() + duration
    this.sql.exec(
      'INSERT OR REPLACE INTO turn_clock (id, player, phase, duration, deadline) VALUES (0, ?, ?, ?, ?)',
      player,
      state.phase.t,
      duration,
      deadline,
    )
    await this.ctx.storage.setAlarm(deadline)
  }

  /** Re-arm whatever clock the stored game is owed, without shortening or extending it. */
  async #reassertClock(): Promise<void> {
    const snap = this.#snapshot()
    if (!snap) return
    await this.#armClock(snap.state, null)
  }

  async #clearClock(): Promise<void> {
    this.sql.exec('DELETE FROM turn_clock WHERE id = 0')
    await this.ctx.storage.deleteAlarm()
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
   * time really has passed.
   *
   * Alarms are delivered **at least once** and can wake a hibernated object early, so every exit
   * below is a no-op that leaves the game exactly as it was:
   *
   * - no clock, or no game → nothing to forfeit;
   * - the decision has moved on since the alarm was set (someone played, in the gap) → re-arm for
   *   whoever owes the new one;
   * - the deadline is still in the future → put the alarm back and wait it out.
   *
   * So a duplicate delivery cannot take two turns from anyone: the first one changes the phase, and
   * the second finds a clock that no longer matches it.
   */
  override async alarm(): Promise<void> {
    const clock = this.#clock()
    if (!clock) return

    const snap = this.#snapshot()
    if (!snap) return this.#clearClock()

    const owed = playerToAct(snap.state)
    if (owed === null) return this.#clearClock()
    if (owed !== clock.player || snap.state.phase.t !== clock.phase) {
      return this.#armClock(snap.state, null)
    }
    if (clock.deadline > Date.now()) {
      await this.ctx.storage.setAlarm(clock.deadline)
      return
    }

    const action: Action = { type: 'timeout', player: clock.player }
    const result = await ruleHost.reduce(snap.state, action)
    if (!result.ok) {
      // The engine refused the forfeit. Nothing here can fix that, and re-arming would spin on it
      // every 30 seconds, so drop the clock and let the next real action start a fresh one.
      return this.#clearClock()
    }

    this.#persist(result.state, action)
    await this.#armClock(result.state, action)
    this.#broadcast(result.state, result.events)
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

  #playerByClient(clientId: string): PlayerRow | null {
    const rows = this.sql
      .exec('SELECT id, client_id, name, seat, connected FROM players WHERE client_id = ?', clientId)
      .toArray() as unknown as PlayerRow[]
    return rows[0] ?? null
  }

  #lobbyPlayers(): LobbyPlayer[] {
    return this.#players().map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: p.connected === 1,
    }))
  }
}
