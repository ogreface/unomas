import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessageInput, ConnectRole, LobbyPlayer, ServerMessage } from '@flipside/protocol'
import type { EventView, PlayerView, TableView } from '@flipside/engine'
import { connect, type ConnStatus, type Connection } from './connection.js'

export interface RosterState {
  players: LobbyPlayer[]
  host: string
}

/** An event tagged with a monotonic id, so the animation/feed layer can key and expire them. */
export interface FeedEvent {
  id: number
  event: EventView
}

export interface RoomState {
  status: ConnStatus
  you: string | null
  seat: number
  host: string | null
  code: string
  view: PlayerView | null
  table: TableView | null
  roster: RosterState | null
  /** The most recent rejected action, cleared as the player acts again. */
  error: { code: string; message: string } | null
  /** Rolling window of recent events for callouts/animations. */
  feed: FeedEvent[]
  send: (msg: ClientMessageInput) => void
}

const FEED_LIMIT = 8

/**
 * Owns one room connection and turns the server's message stream into React state. Nothing here
 * decides rules — it only mirrors what the authoritative `GameRoom` sends. `enabled` gates the
 * connection so a player can be prompted for a nickname before we ever open the socket.
 */
export function useRoom(opts: {
  code: string
  role: ConnectRole
  nickname: string
  enabled: boolean
}): RoomState {
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [you, setYou] = useState<string | null>(null)
  const [seat, setSeat] = useState<number>(-1)
  const [host, setHost] = useState<string | null>(null)
  const [view, setView] = useState<PlayerView | null>(null)
  const [table, setTable] = useState<TableView | null>(null)
  const [roster, setRoster] = useState<RosterState | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [feed, setFeed] = useState<FeedEvent[]>([])

  const connRef = useRef<Connection | null>(null)
  const lastSeqRef = useRef(0)
  const feedIdRef = useRef(0)

  const pushEvents = useCallback((events: EventView[]) => {
    if (events.length === 0) return
    setFeed(prev => {
      const next = [...prev]
      for (const event of events) next.push({ id: feedIdRef.current++, event })
      return next.slice(-FEED_LIMIT)
    })
  }, [])

  const onMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.t) {
        case 'welcome':
          setYou(msg.you)
          setSeat(msg.seat)
          setHost(msg.host)
          break
        case 'roster':
          setRoster({ players: msg.players, host: msg.host })
          setHost(msg.host)
          break
        case 'sync':
          setView(msg.view)
          setRoster(null)
          lastSeqRef.current = msg.view.seq
          break
        case 'events':
          setView(msg.view)
          setRoster(null)
          lastSeqRef.current = msg.view.seq
          setError(null)
          pushEvents(msg.events)
          break
        case 'tableSync':
          setTable(msg.table)
          lastSeqRef.current = msg.table.seq
          break
        case 'tableEvents':
          setTable(msg.table)
          lastSeqRef.current = msg.table.seq
          pushEvents(msg.events)
          break
        case 'error':
          setError({ code: msg.code, message: msg.message })
          break
      }
    },
    [pushEvents],
  )

  useEffect(() => {
    if (!opts.enabled) return
    const conn = connect({
      code: opts.code,
      role: opts.role,
      nickname: opts.nickname,
      onMessage,
      onStatus: setStatus,
      lastSeq: () => lastSeqRef.current,
    })
    connRef.current = conn
    return () => {
      conn.close()
      connRef.current = null
    }
    // Reconnect only if the identity of the connection changes, not on every nickname keystroke.
  }, [opts.enabled, opts.code, opts.role, opts.nickname, onMessage])

  const send = useCallback((msg: ClientMessageInput) => {
    connRef.current?.send(msg)
  }, [])

  return { status, you, seat, host, code: opts.code, view, table, roster, error, feed, send }
}
