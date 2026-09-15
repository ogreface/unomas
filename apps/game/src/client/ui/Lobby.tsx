import { useState } from 'react'
import { MAX_BOTS, MAX_PLAYERS, MIN_PLAYERS } from '@flipside/protocol'
import type { BotDifficulty } from '@flipside/engine'
import type { RoomState } from '../net/useRoom.js'

const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  easy: 'Easy',
  normal: 'Normal',
}

export function Lobby({ room, onLeave }: { room: RoomState; onLeave: () => void }) {
  const [difficulty, setDifficulty] = useState<BotDifficulty>('normal')
  const players = room.roster?.players ?? []
  // No `welcome` yet means the server has not told us who we are, so we cannot know whether we are
  // the host. Saying "waiting for the host" there is a lie the host themself would read — the state
  // is "still joining", and it must look different from a lobby we are genuinely sitting in.
  const joined = room.you !== null
  const isHost = joined && room.you === room.host
  const canStart = isHost && players.length >= MIN_PLAYERS
  const botCount = players.filter(p => p.bot !== null).length
  const canAddBot = isHost && players.length < MAX_PLAYERS && botCount < MAX_BOTS
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
            <li key={p.id} className={p.bot === null && !p.connected ? 'roster--away' : ''}>
              <span className="seat-dot" data-seat={p.seat} />
              <span className="roster-name">{p.name}</span>
              {p.bot !== null && <span className="tag tag--bot">{DIFFICULTY_LABEL[p.bot]} bot</span>}
              {p.id === room.host && <span className="tag">host</span>}
              {p.id === room.you && <span className="tag tag--you">you</span>}
              {/* A bot has no socket, so "away" would be permanently and misleadingly true. */}
              {p.bot === null && !p.connected && <span className="tag tag--away">away</span>}
              {isHost && p.bot !== null && (
                <button
                  className="btn btn--ghost btn--tiny"
                  title={`Remove ${p.name}`}
                  aria-label={`Remove ${p.name}`}
                  onClick={() => room.send({ t: 'removeBot', playerId: p.id })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
          {players.length === 0 && <li className="muted">Waiting for players…</li>}
        </ul>

        {!joined ? (
          <p className="muted center">Joining…</p>
        ) : isHost ? (
          <>
            {/*
              A computer player fills a seat like anyone else, so this is equally "play on your own"
              and "round the table out to five" — the host adds one either way.
            */}
            <div className="add-bot">
              <button className="btn" disabled={!canAddBot} onClick={() => room.send({ t: 'addBot', difficulty })}>
                + Add computer player
              </button>
              <label className="add-bot__level">
                <span className="visually-hidden">Difficulty</span>
                <select value={difficulty} onChange={e => setDifficulty(e.target.value as BotDifficulty)}>
                  <option value="easy">Easy</option>
                  <option value="normal">Normal</option>
                </select>
              </label>
            </div>

            <button className="btn btn--primary btn--block" disabled={!canStart} onClick={() => room.send({ t: 'start' })}>
              {canStart ? 'Start game' : `Need ${MIN_PLAYERS}+ players`}
            </button>
          </>
        ) : (
          <p className="muted center">Waiting for the host to start…</p>
        )}

        {room.error && <p className="error-text">{room.error.message}</p>}
      </div>
    </main>
  )
}
