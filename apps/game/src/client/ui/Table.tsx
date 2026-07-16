import { otherSide } from '@flipside/engine'
import { useRoom } from '../net/useRoom.js'
import { Card } from './Card.js'
import { Feed } from './Feed.js'

/**
 * The table view — read-only, built for a shared screen on the call. Deliberately *not* a player's
 * view: it shows only what is on the table (piles, turn order, hand counts) plus the dark faces
 * everyone can already see. It never reveals a hand's active faces, so it is safe to project.
 */
export function Table({ code }: { code: string }) {
  const room = useRoom({ code, role: 'spectator', nickname: 'Table', enabled: true })
  const table = room.table
  const nameOf = (id: string) => table?.players.find(p => p.id === id)?.name ?? '—'

  if (!table) {
    return (
      <main className="screen screen--center table-screen">
        <div className="panel">
          <h1 className="brand">Flipside</h1>
          <p className="muted">
            Room <strong>{code}</strong> — {room.status === 'open' ? 'waiting for the game to start…' : 'connecting…'}
          </p>
        </div>
      </main>
    )
  }

  const inactive = otherSide(table.side)

  return (
    <main className="table-screen">
      <header className="table-head">
        <span className="room-code">{code}</span>
        <span className={`side-badge side-badge--${table.side}`}>{table.side} side</span>
        <span className="dir">{table.direction === 1 ? '↻' : '↺'}</span>
        {table.activeColor && <span className="active-color" style={{ background: `var(--c-${table.activeColor})` }} />}
      </header>

      <section className="table-players">
        {table.players.map(p => (
          <div key={p.id} className={`table-player${p.id === table.turn ? ' table-player--turn' : ''}`}>
            <div className="table-player__head">
              <span className="seat-dot" data-seat={p.seat} />
              <span className="table-player__name">{p.name}</span>
              <span className="table-player__score">{p.score}</span>
              <span className="opponent__count">{p.handCount}</span>
              {p.saidUno && <span className="tag tag--uno">UNO</span>}
            </div>
            <div className="opponent__hand">
              {p.visible.map((c, i) => (
                <span key={c.key || i} className="mini-card" style={{ marginLeft: i === 0 ? 0 : -20 }}>
                  <Card face={c.face} side={inactive} width={40} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="table-center">
        <div className="pile">
          <div className="pile__label">Draw · {table.drawPile.count}</div>
          {table.drawPile.peek ? (
            <Card face={table.drawPile.peek.face} side={inactive} width={130} />
          ) : (
            <div className="pile__empty">empty</div>
          )}
        </div>
        <div className="pile">
          <div className="pile__label">Discard · {table.discard.count}</div>
          <Card face={table.discard.top.face} side={table.side} width={130} />
        </div>
      </section>

      <Feed feed={room.feed} nameOf={nameOf} />
    </main>
  )
}
