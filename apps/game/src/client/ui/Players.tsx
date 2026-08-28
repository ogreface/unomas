import { otherSide } from '@flipside/engine'
import type { PlayerSummaryView, Side } from '@flipside/engine'
import { Card } from './Card.js'

/**
 * The opponents. Each shows the face-down side of their hand — which, per the rules, is the face
 * *you* are not allowed to see of your own cards but *can* see of theirs. That asymmetry is the
 * whole inverted-information mechanic, rendered as a strip of small cards.
 */
export function Players({
  players,
  you,
  side,
  turn,
  unoWindow,
  onCallout,
}: {
  players: PlayerSummaryView[]
  you: string
  side: Side
  turn: string | null
  unoWindow: string | null
  onCallout: (targetId: string) => void
}) {
  const opponents = players.filter(p => p.id !== you)
  const inactive = otherSide(side)

  return (
    <div className="opponents">
      {opponents.map(p => (
        <div key={p.id} className={`opponent${p.id === turn ? ' opponent--turn' : ''}`}>
          <div className="opponent__head">
            <span className="seat-dot" data-seat={p.seat} />
            <span className="opponent__name">{p.name}</span>
            <span className="opponent__count">{p.handCount}</span>
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
          <div className="opponent__hand">
            {p.visible.map((c, i) => (
              <span key={c.key || i} className="mini-card" style={{ marginLeft: i === 0 ? 0 : -18 }}>
                <Card face={c.face} side={inactive} width={44} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
