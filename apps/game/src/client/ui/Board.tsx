import { useCallback, useState } from 'react'
import { playerToActInView } from '@flipside/engine'
import type { CardView, Color, PlayerView } from '@flipside/engine'
import { SideBadge } from './SideBadge.js'
import type { RoomState } from '../net/useRoom.js'
import { turnLabel } from '../lib/turnLabel.js'
import { navigate } from '../App.js'
import { Piles } from './Piles.js'
import { Players } from './Players.js'
import { Hand } from './Hand.js'
import { ColorPicker } from './ColorPicker.js'
import { Feed } from './Feed.js'
import { GameLog, GameLogToggle } from './GameLog.js'
import { TurnClock, useTurnClock } from './TurnClock.js'
import type { ClockReading } from './TurnClock.js'
import { useSoundCues } from './useSoundCues.js'
import { playCues, setSoundMuted, soundMuted } from '../lib/sound.js'
import { upNext } from '../lib/turnOrder.js'

export function Board({ room }: { room: RoomState }) {
  const view = room.view!
  const [pendingWild, setPendingWild] = useState<CardView | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const closeLog = useCallback(() => setLogOpen(false), [])
  const toggleLog = useCallback(() => setLogOpen(open => !open), [])
  // One ticking clock per screen, read once and handed down — see `TurnClock.tsx`.
  const clock = useTurnClock(room.timer)
  useSoundCues(view, room.feed, clock)

  // Stable between views, so the game log (memoised) is not rebuilt on every tick of the clock.
  const players = view.players
  const nameOf = useCallback((id: string) => players.find(p => p.id === id)?.name ?? '—', [players])
  const me = view.players.find(p => p.id === view.you)
  const myTurn = view.turn === view.you
  // Who the table is waiting on. Usually the player at the turn, but not always: a wild draw leaves
  // the turn where it was while the *next* player decides whether to challenge. Everything that
  // points at a person — the label, the highlighted seat — follows this, so it agrees with the clock.
  const toAct = playerToActInView(view)
  // …and the seat after them: the one being played on, tagged in the strip and named in the top bar.
  const next = upNext(view)
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
    // `data-side` themes the felt, the accent and every card beneath it, so a flip repaints the
    // whole board rather than just swapping which four colours are legal.
    <main className="board" data-side={view.side}>
      <TopBar
        view={view}
        nameOf={nameOf}
        bots={room.bots}
        next={next}
        clock={clock}
        onLeave={() => navigate('/')}
        logOpen={logOpen}
        onToggleLog={toggleLog}
      />

      <Players
        players={view.players}
        you={view.you}
        side={view.side}
        direction={view.direction}
        toAct={toAct}
        next={next}
        unoWindow={view.unoWindow}
        clock={clock}
        bots={room.bots}
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

      {/* On a phone the top bar has no width left for the Log button, so it sits here instead —
          under the discard pile, in space the board is not using. See `.board-tools` in the CSS. */}
      <div className="board-tools">
        <GameLogToggle open={logOpen} onToggle={toggleLog} />
      </div>

      <Feed feed={room.feed} nameOf={nameOf} />
      {logOpen && <GameLog log={room.log} nameOf={nameOf} onClose={closeLog} />}

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
  bots,
  next,
  clock,
  onLeave,
  logOpen,
  onToggleLog,
}: {
  view: PlayerView
  nameOf: (id: string) => string
  /** Seats played by the computer: the label says they are thinking rather than looking like a stall. */
  bots: Set<string>
  /**
   * The seat being played on. Named here as well as tagged in the strip, because on a phone the
   * strip can't always show both ends of the turn at once — when play wraps round the end of the
   * row, the next seat is at the far end of it.
   */
  next: string | null
  clock: ClockReading | null
  onLeave: () => void
  logOpen: boolean
  onToggleLog: () => void
}) {
  // The label and the clock both belong to whoever owes the decision, which is not always the player
  // at the turn: a challenge is owed by somebody else while the turn sits still. A bot is never on
  // the clock — the room plays for it rather than waiting — so a thinking seat wears no ring.
  const onTheClock = clock ? clock.timer.player : null
  const clockLabel = onTheClock === view.you ? 'You' : onTheClock ? nameOf(onTheClock) : ''
  return (
    <header className="topbar">
      <button className="btn btn--ghost btn--tiny" onClick={onLeave}>
        ‹
      </button>
      <SideBadge side={view.side} />
      <span className="turn-status">
        <span className="turn-label">{turnLabel(view, bots)}</span>
        {next !== null && (
          <span className={`turn-next${next === view.you ? ' turn-next--you' : ''}`}>
            {next === view.you ? 'You’re next' : `Next: ${nameOf(next)}`}
          </span>
        )}
      </span>
      {clock && <TurnClock clock={clock} label={clockLabel} size={34} />}
      {view.activeColor && (
        <span className="active-color-tag" title="The colour in play right now">
          <span
            className="active-color"
            style={{ background: `var(--ink-${view.activeColor})`, color: `var(--ink-${view.activeColor})` }}
          />
          <span className="active-color-tag__name">{view.activeColor}</span>
        </span>
      )}
      <GameLogToggle open={logOpen} onToggle={onToggleLog} />
      <SoundToggle />
    </header>
  )
}

/** Sound on or off, remembered on this device. Turning it on plays the turn chime, so you know. */
function SoundToggle() {
  const [muted, setMuted] = useState(soundMuted)
  function toggle() {
    const next = !muted
    setMuted(next)
    void setSoundMuted(next).then(() => {
      if (!next) playCues(['yourTurn'])
    })
  }
  return (
    <button
      className="btn btn--ghost btn--tiny sound-toggle"
      aria-label="Mute sounds"
      aria-pressed={muted}
      title={muted ? 'Sounds are off' : 'Sounds are on'}
      onClick={toggle}
    >
      {muted ? '🔇' : '🔊'}
    </button>
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
