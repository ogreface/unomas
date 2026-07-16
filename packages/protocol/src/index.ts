/**
 * `@flipside/protocol` — the wire contract between the browser and the `GameRoom` Durable Object.
 *
 * Two directions, two different postures:
 *
 * - **Client → Server** messages are **fully validated with zod**. This is untrusted input arriving
 *   at the authoritative server; every field is checked before it reaches the reducer. A malformed
 *   or hostile message is rejected at the boundary, never inside the engine.
 * - **Server → Client** messages are **typed against the engine's own view types** (`PlayerView`,
 *   `TableView`, `EventView`) and *not* re-validated on the wire. They are produced by our own
 *   trusted engine, so mirroring the entire nested view shape in zod would buy nothing but a second
 *   copy of the same types to keep in sync. The envelope is a discriminated union; the payloads are
 *   the engine types verbatim.
 *
 * The wire speaks **card key aliases**, never deck ids — a `play` names a card by the opaque `key`
 * it was given in the player's view. That is what makes the inverted-information mechanic hold: a
 * client that scraped `deck.ts` still cannot map a key to a card. See `engine/view.ts`.
 */

import { z } from 'zod'
import { LIGHT_COLORS, DARK_COLORS } from '@flipside/engine'
import type {
  Color,
  EventView,
  PlayerId,
  PlayerView,
  RuleErrorCode,
  TableView,
} from '@flipside/engine'

/** Bumped when the wire shape changes incompatibly. The DO refuses a client on a different major. */
export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------------------------
// Room codes & identity
// ---------------------------------------------------------------------------------------------

/**
 * Room codes are 4 characters from an unambiguous alphabet (no `0/O`, `1/I/L`), uppercased. Short
 * enough to read aloud on a call, which is the entire delivery mechanism.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 4
export const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`)

/**
 * Normalize a user-typed code: trim and uppercase, then validate. Returns null if it isn't a
 * well-formed code. The alphabet deliberately excludes look-alikes (`0/O`, `1/I/L`), so we do *not*
 * try to "fix" those — remapping a typo could silently point the player at a different real room.
 */
export function normalizeCode(raw: string): string | null {
  const up = raw.trim().toUpperCase()
  return ROOM_CODE_RE.test(up) ? up : null
}

export const MAX_NICKNAME_LENGTH = 24
export const MAX_PLAYERS = 10
export const MIN_PLAYERS = 2

// ---------------------------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------------------------

/** The 8 colours, sourced from the engine so there is a single point of truth. */
const ALL_COLORS = [...LIGHT_COLORS, ...DARK_COLORS] as [Color, ...Color[]]
export const ColorSchema = z.enum(ALL_COLORS)

const Nickname = z
  .string()
  .trim()
  .min(1, 'nickname required')
  .max(MAX_NICKNAME_LENGTH, 'nickname too long')

/** A client-generated stable id, persisted in the browser, used to reclaim a seat on reconnect. */
const ClientId = z.string().min(8).max(64)

/** An opaque per-round card alias, as handed to the player in their view. */
const CardKey = z.string().min(1).max(64)

const PlayerIdSchema = z.string().min(1).max(64)

export type ConnectRole = 'player' | 'spectator'
export const RoleSchema = z.enum(['player', 'spectator'])

// ---------------------------------------------------------------------------------------------
// Client → Server (validated)
// ---------------------------------------------------------------------------------------------

/**
 * `join` is always the first message on a fresh socket. `clientId` lets the DO recognise a
 * returning player and hand them back their seat instead of a new one — the reconnect story every
 * deploy forces on us.
 */
export const JoinSchema = z.object({
  t: z.literal('join'),
  clientId: ClientId,
  nickname: Nickname,
  role: RoleSchema.default('player'),
  /** Last sequence number the client has already applied; the DO replays from here. 0 = fresh. */
  lastSeq: z.number().int().nonnegative().default(0),
})

export const StartSchema = z.object({ t: z.literal('start') })
export const PlaySchema = z.object({
  t: z.literal('play'),
  key: CardKey,
  declaredColor: ColorSchema.optional(),
})
export const DrawSchema = z.object({ t: z.literal('draw') })
export const PassSchema = z.object({ t: z.literal('pass') })
export const ChooseColorSchema = z.object({ t: z.literal('chooseColor'), color: ColorSchema })
export const ChallengeSchema = z.object({ t: z.literal('challenge') })
export const AcceptDrawSchema = z.object({ t: z.literal('acceptDraw') })
export const CallUnoSchema = z.object({ t: z.literal('callUno') })
export const CalloutSchema = z.object({ t: z.literal('callout'), target: PlayerIdSchema })
/** Ask the DO to resend the authoritative snapshot; a self-heal if the client thinks it drifted. */
export const ResyncSchema = z.object({
  t: z.literal('resync'),
  lastSeq: z.number().int().nonnegative().default(0),
})

export const ClientMessageSchema = z.discriminatedUnion('t', [
  JoinSchema,
  StartSchema,
  PlaySchema,
  DrawSchema,
  PassSchema,
  ChooseColorSchema,
  ChallengeSchema,
  AcceptDrawSchema,
  CallUnoSchema,
  CalloutSchema,
  ResyncSchema,
])

/** The **parsed** message the server acts on — `.default()`s applied, so `role`/`lastSeq` are set. */
export type ClientMessage = z.infer<typeof ClientMessageSchema>
/** The message a **sender** constructs — fields with defaults are optional before parsing. */
export type ClientMessageInput = z.input<typeof ClientMessageSchema>
export type JoinMessage = z.infer<typeof JoinSchema>

/** Parse an inbound frame. Returns a discriminated result; never throws on bad input. */
export function parseClientMessage(
  raw: unknown,
): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let data = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'not JSON' }
    }
  }
  const parsed = ClientMessageSchema.safeParse(data)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid message' }
  return { ok: true, msg: parsed.data }
}

// ---------------------------------------------------------------------------------------------
// Server → Client (typed, not re-validated — produced by our own engine)
// ---------------------------------------------------------------------------------------------

/** A player in the pre-game lobby, before there is a `PlayerView` to render. */
export interface LobbyPlayer {
  id: PlayerId
  name: string
  seat: number
  connected: boolean
}

/** Identity + room facts, sent once when a socket is accepted. */
export interface WelcomeMessage {
  t: 'welcome'
  protocol: number
  you: PlayerId
  seat: number
  code: string
  role: ConnectRole
  /** The seat that owns "start the game". */
  host: PlayerId
}

/** Full authoritative snapshot for a player (join, resync, or after a deploy). */
export interface SyncMessage {
  t: 'sync'
  view: PlayerView
}

/** Animation script + resulting authoritative snapshot, for a player. One per accepted action. */
export interface EventsMessage {
  t: 'events'
  events: EventView[]
  view: PlayerView
}

/** The read-only projector snapshot, for a spectator (`/r/:code/table`). */
export interface TableSyncMessage {
  t: 'tableSync'
  table: TableView
}

/** Animation script + resulting table snapshot, for a spectator. */
export interface TableEventsMessage {
  t: 'tableEvents'
  events: EventView[]
  table: TableView
}

/** The lobby roster changed (someone joined, left, or reconnected) before the game began. */
export interface RosterMessage {
  t: 'roster'
  players: LobbyPlayer[]
  host: PlayerId
  started: boolean
}

/** A rejected action, or a connection-level problem. `code` is the engine's when it has one. */
export interface ErrorMessage {
  t: 'error'
  code: RuleErrorCode | 'bad_message' | 'room_full' | 'not_host' | 'protocol_mismatch' | 'not_found'
  message: string
  /** True for problems that close the socket, false for a rejected-but-recoverable action. */
  fatal: boolean
}

export type ServerMessage =
  | WelcomeMessage
  | SyncMessage
  | EventsMessage
  | TableSyncMessage
  | TableEventsMessage
  | RosterMessage
  | ErrorMessage

export type ServerMessageType = ServerMessage['t']

/** Encode a server message for the wire. Kept in one place so both sides agree on the framing. */
export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg)
}

/** Decode a server frame on the client. Trusted source, so this is a typed cast, not validation. */
export function decodeServer(raw: string): ServerMessage {
  return JSON.parse(raw) as ServerMessage
}
