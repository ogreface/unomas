import { otherSide } from '@flipside/engine'
import type { CardView, Color, Side } from '@flipside/engine'
import { Card } from './Card.js'

/**
 * The two piles. The draw pile is the quietly-radical one: it is placed active-side-down, so its
 * top card shows the whole table its *inactive* face — the peek everyone can see and almost no
 * digital version models. We render exactly that face.
 */
export function Piles({
  side,
  activeColor,
  discardTop,
  discardCount,
  drawCount,
  drawPeek,
  canDraw,
  onDraw,
}: {
  side: Side
  activeColor: Color | null
  discardTop: CardView
  discardCount: number
  drawCount: number
  drawPeek: CardView | null
  canDraw: boolean
  onDraw: () => void
}) {
  const inactive = otherSide(side)
  return (
    <div className="piles">
      <div className="pile">
        <div className="pile__label">Draw · {drawCount}</div>
        <button
          className={`pile__stack${canDraw ? ' pile__stack--live' : ''}`}
          disabled={!canDraw}
          onClick={onDraw}
          aria-label="Draw a card"
        >
          {drawPeek ? (
            <Card face={drawPeek.face} side={inactive} width={96} />
          ) : (
            <div className="pile__empty">empty</div>
          )}
        </button>
      </div>

      <div className="pile">
        <div className="pile__label">
          Discard · {discardCount}
          {activeColor && (
            <span className="active-color-tag" title="The colour you must match to play">
              <span className="active-color" style={{ background: `var(--c-${activeColor})` }} />
              play {activeColor}
            </span>
          )}
        </div>
        <div className="pile__stack">
          <Card face={discardTop.face} side={side} width={96} />
        </div>
      </div>
    </div>
  )
}
