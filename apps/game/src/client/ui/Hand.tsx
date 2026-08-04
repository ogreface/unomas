import type { CardView, Side } from '@flipside/engine'
import { Card } from './Card.js'

/**
 * Your hand, active faces toward you, fanned as an overlapping cascade. Legal plays are lifted and
 * tappable; everything else is dimmed. Which cards are legal is decided by the server (`legalPlays`)
 * — the client holds no rules.
 */
export function Hand({
  cards,
  side,
  legalPlays,
  canPlay,
  onPlay,
}: {
  cards: CardView[]
  side: Side
  legalPlays: string[]
  canPlay: boolean
  onPlay: (card: CardView) => void
}) {
  const legal = new Set(legalPlays)
  const overlap = cards.length > 7 ? -26 : -18

  return (
    <div className="hand" role="group" aria-label="Your hand">
      {cards.map((card, i) => {
        const playable = canPlay && legal.has(card.key)
        // Cards fan left-to-right, each stacking over the previous. Lifted (playable) cards jump a
        // whole band above so a dimmed neighbour never clips the raised card's face.
        const zIndex = (playable ? 100 : 0) + i
        return (
          <span
            key={card.key || i}
            className={`hand__slot${playable ? ' hand__slot--playable' : ''}`}
            style={{ marginLeft: i === 0 ? 0 : overlap, zIndex }}
          >
            <Card
              face={card.face}
              side={side}
              width={78}
              playable={playable}
              dimmed={canPlay && !playable}
              onClick={playable ? () => onPlay(card) : undefined}
            />
          </span>
        )
      })}
      {cards.length === 0 && <div className="muted">No cards.</div>}
    </div>
  )
}
