import { otherSide } from '@flipside/engine'
import type { Direction, PlayerSummaryView, Side } from '@flipside/engine'
import { Card } from './Card.js'
import { TurnClock } from './TurnClock.js'
import type { ClockReading } from './TurnClock.js'
import { NextFlag, TurnOrder } from './TurnOrder.js'

/**
 * The seats, in turn order — yours among them, so you can see where you sit in the round and who
 * plays on you. Each opponent shows the face-down side of their hand — which, per the rules, is the
 * face *you* are not allowed to see of your own cards but *can* see of theirs. That asymmetry is the
 * whole inverted-information mechanic, rendered as a strip of small cards. Your own seat has no
 * strip, for the same reason: you are not allowed to see your own backs.
 *
 * Whoever the room is waiting on also wears the countdown, so "why has nothing happened for twenty
 * seconds" is answered on the tile of the person it is about. (Your own countdown sits beside "Your
 * turn" in the top bar.)
 */
export function Players({
  players,
  you,
  side,
  direction,
  turn,
  next,
  unoWindow,
  clock,
  bots,
  onCallout,
}: {
  players: PlayerSummaryView[]
  you: string
  side: Side
  direction: Direction
  turn: string | null
  /** The seat being played on — see `upNext`. */
  next: string | null
  unoWindow: string | null
  clock: ClockReading | null
  /** Seats played by the computer. Labelled, because "why is Byte so slow" deserves an answer. */
  bots: Set<string>
  onCallout: (targetId: string) => void
}) {
  const inactive = otherSide(side)
  const seatClass = (p: PlayerSummaryView) =>
    `seat${p.id === you ? ' seat--you' : ''}${p.id === turn ? ' seat--turn' : ''}${p.id === next ? ' seat--next' : ''}`

  return (
    <TurnOrder players={players} direction={direction} turn={turn} next={next} className="seats">
      {p =>
        p.id === you ? (
          <div className={seatClass(p)}>
            {p.id === next && <NextFlag />}
            <div className="seat__head">
              <span className="seat-dot" data-seat={p.seat} />
              <span className="seat__name">{p.name}</span>
            </div>
            <div className="seat__head">
              <span className="tag tag--you">you</span>
              {p.saidUno && <span className="tag tag--uno">UNO</span>}
              <span className="seat__count">{p.handCount}</span>
            </div>
          </div>
        ) : (
          <div className={seatClass(p)}>
            {p.id === next && <NextFlag />}
            <div className="seat__head">
              <span className="seat-dot" data-seat={p.seat} />
              <span className="seat__name">{p.name}</span>
              {bots.has(p.id) && (
                <span className="tag tag--bot" title="A computer player">
                  bot
                </span>
              )}
              <span className="seat__count">{p.handCount}</span>
              {clock?.timer.player === p.id && <TurnClock clock={clock} label={p.name} size={28} />}
              {p.saidUno && <span className="tag tag--uno">UNO</span>}
              {unoWindow === p.id && (
                <button
                  className="btn btn--tiny btn--warn"
                  title={`${p.name} is down to one card without saying UNO — catch them and they draw penalty cards`}
                  onClick={() => onCallout(p.id)}
                >
                  Call out!
                </button>
              )}
            </div>
            <div className="seat__hand">
              {p.visible.map((c, i) => (
                <span key={c.key || i} className="mini-card" style={{ marginLeft: i === 0 ? 0 : -18 }}>
                  <Card face={c.face} side={inactive} width={44} />
                </span>
              ))}
            </div>
          </div>
        )
      }
    </TurnOrder>
  )
}
