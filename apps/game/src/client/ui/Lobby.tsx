import { MIN_PLAYERS } from '@flipside/protocol'
import type { RoomState } from '../net/useRoom.js'

export function Lobby({ room, onLeave }: { room: RoomState; onLeave: () => void }) {
  const players = room.roster?.players ?? []
  const isHost = room.you !== null && room.you === room.host
  const canStart = isHost && players.length >= MIN_PLAYERS
  const tableUrl = `${location.origin}/r/${room.code}/table`

  return (
    <main className="screen screen--center">
      <div className="panel panel--wide">
        <div className="lobby-head">
          <div>
            <div className="muted">Room code</div>
            <div className="room-code">{room.code}</div>
          </div>
          <button className="btn btn--ghost" onClick={onLeave}>
            Leave
          </button>
        </div>

        <p className="muted">Share the code, or open the table view on a shared screen:</p>
        <a className="table-link" href={tableUrl} target="_blank" rel="noreferrer">
          {tableUrl}
        </a>

        <ul className="roster">
          {players.map(p => (
            <li key={p.id} className={p.connected ? '' : 'roster--away'}>
              <span className="seat-dot" data-seat={p.seat} />
              <span className="roster-name">{p.name}</span>
              {p.id === room.host && <span className="tag">host</span>}
              {p.id === room.you && <span className="tag tag--you">you</span>}
              {!p.connected && <span className="tag tag--away">away</span>}
            </li>
          ))}
          {players.length === 0 && <li className="muted">Waiting for players…</li>}
        </ul>

        {isHost ? (
          <button className="btn btn--primary btn--block" disabled={!canStart} onClick={() => room.send({ t: 'start' })}>
            {canStart ? 'Start game' : `Need ${MIN_PLAYERS}+ players`}
          </button>
        ) : (
          <p className="muted center">Waiting for the host to start…</p>
        )}

        {room.error && <p className="error-text">{room.error.message}</p>}
      </div>
    </main>
  )
}
