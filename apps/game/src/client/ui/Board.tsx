import { useState } from 'react'
import type { CardView, Color, PlayerView } from '@flipside/engine'
import type { RoomState } from '../net/useRoom.js'
import { navigate } from '../App.js'
import { Piles } from './Piles.js'
import { Players } from './Players.js'
import { Hand } from './Hand.js'
import { ColorPicker } from './ColorPicker.js'
import { Feed } from './Feed.js'

export function Board({ room }: { room: RoomState }) {
  const view = room.view!
  const [pendingWild, setPendingWild] = useState<CardView | null>(null)

  const nameOf = (id: string) => view.players.find(p => p.id === id)?.name ?? '—'
  const me = view.players.find(p => p.id === view.you)
  const myTurn = view.turn === view.you
  const phase = view.phase

  const canPlay = (phase.t === 'awaitingPlay' || phase.t === 'awaitingDrawnCardChoice') && myTurn
  const canDraw = phase.t === 'awaitingPlay' && myTurn
  const canPass = phase.t === 'awaitingDrawnCardChoice' && myTurn
  // "UNO!" is a declaration you make as you go down to your last card: pre-emptively on your turn
  // while holding two, or — if you forgot — as a rescue while your one-card window is still open,
  // before an opponent calls you out. Once you've said it, stop nagging.
  const saidUno = me?.saidUno ?? false
  const unoRescue = view.unoWindow === view.you && me?.handCount === 1 && !saidUno
  const canCallUno = (myTurn && me?.handCount === 2 && !saidUno) || unoRescue

  function play(card: CardView, color?: Color) {
    setPendingWild(null)
    room.send({ t: 'play', key: card.key, ...(color ? { declaredColor: color } : {}) })
  }

  function onPlay(card: CardView) {
    if (card.face.color === null) setPendingWild(card)
    else play(card)
  }

  return (
    <main className="board">
      <TopBar view={view} nameOf={nameOf} myTurn={myTurn} onLeave={() => navigate('/')} />

      <Players
        players={view.players}
        you={view.you}
        side={view.side}
        turn={view.turn}
        unoWindow={view.unoWindow}
        onCallout={id => room.send({ t: 'callout', target: id })}
      />

      <Piles
        side={view.side}
        activeColor={view.activeColor}
        discardTop={view.discard.top}
        discardCount={view.discard.count}
        drawCount={view.drawPile.count}
        drawPeek={view.drawPile.peek}
        canDraw={canDraw}
        onDraw={() => room.send({ t: 'draw' })}
      />

      <Feed feed={room.feed} nameOf={nameOf} />

      <div className="action-bar">
        {phase.t === 'awaitingChallenge' && phase.challenger === view.you && (
          <>
            <div className="prompt">Challenge {nameOf(phase.accused)}’s wild draw?</div>
            <button className="btn btn--warn" onClick={() => room.send({ t: 'challenge' })}>
              Challenge
            </button>
            <button className="btn" onClick={() => room.send({ t: 'acceptDraw' })}>
              Take the cards
            </button>
          </>
        )}
        {canPass && (
          <button className="btn" onClick={() => room.send({ t: 'pass' })}>
            Pass
          </button>
        )}
        {canCallUno && (
          <>
            {unoRescue && (
              <div className="prompt prompt--warn">
                One card left — say UNO before an opponent catches you!
              </div>
            )}
            <button
              className="btn btn--uno"
              title="Declare UNO as you drop to your last card. Forget, and an opponent can catch you out for a penalty."
              onClick={() => room.send({ t: 'callUno' })}
            >
              UNO!
            </button>
          </>
        )}
      </div>

      <Hand
        cards={view.hand}
        side={view.side}
        legalPlays={view.legalPlays}
        canPlay={canPlay}
        onPlay={onPlay}
      />

      {pendingWild && (
        <Overlay onClose={() => setPendingWild(null)}>
          <ColorPicker side={view.side} onPick={color => play(pendingWild, color)} />
        </Overlay>
      )}

      {phase.t === 'awaitingColorChoice' && phase.chooser === view.you && (
        <Overlay>
          <ColorPicker
            side={view.side}
            title="A wild is showing — choose the colour"
            onPick={color => room.send({ t: 'chooseColor', color })}
          />
        </Overlay>
      )}

      {phase.t === 'roundOver' && <RoundOverlay room={room} view={view} nameOf={nameOf} />}
      {phase.t === 'gameOver' && (
        <Overlay>
          <div className="endgame">
            <h2>{nameOf(phase.winner)} wins! 🎉</h2>
            <ScoreTable view={view} nameOf={nameOf} />
            <button className="btn btn--primary" onClick={() => navigate('/')}>
              New game
            </button>
          </div>
        </Overlay>
      )}

      {room.error && <div className="toast toast--error action-error">{room.error.message}</div>}
    </main>
  )
}

function TopBar({
  view,
  nameOf,
  myTurn,
  onLeave,
}: {
  view: PlayerView
  nameOf: (id: string) => string
  myTurn: boolean
  onLeave: () => void
}) {
  const turnLabel =
    view.turn === null ? '—' : myTurn ? 'Your turn' : `${nameOf(view.turn)}’s turn`
  return (
    <header className="topbar">
      <button className="btn btn--ghost btn--tiny" onClick={onLeave}>
        ‹
      </button>
      <span className={`side-badge side-badge--${view.side}`}>{view.side}</span>
      <span className="turn-label">{turnLabel}</span>
      <span className="dir">{view.direction === 1 ? '↻' : '↺'}</span>
      {view.activeColor && (
        <span className="active-color-tag" title="The colour in play right now">
          <span className="active-color" style={{ background: `var(--c-${view.activeColor})` }} />
          {view.activeColor}
        </span>
      )}
    </header>
  )
}

function RoundOverlay({
  room,
  view,
  nameOf,
}: {
  room: RoomState
  view: PlayerView
  nameOf: (id: string) => string
}) {
  const phase = view.phase
  if (phase.t !== 'roundOver') return null
  const isHost = room.you !== null && room.you === room.host
  return (
    <Overlay>
      <div className="endgame">
        <h2>{nameOf(phase.winner)} won the round</h2>
        <p className="muted">+{phase.points} points</p>
        <ScoreTable view={view} nameOf={nameOf} />
        {isHost ? (
          <button className="btn btn--primary" onClick={() => room.send({ t: 'start' })}>
            Deal next round
          </button>
        ) : (
          <p className="muted">Waiting for the host to deal the next round…</p>
        )}
      </div>
    </Overlay>
  )
}

function ScoreTable({ view, nameOf }: { view: PlayerView; nameOf: (id: string) => string }) {
  const rows = [...view.players].sort((a, b) => b.score - a.score)
  return (
    <table className="scores">
      <tbody>
        {rows.map(p => (
          <tr key={p.id}>
            <td>{nameOf(p.id)}</td>
            <td className="score-num">{p.score}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay__panel" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
