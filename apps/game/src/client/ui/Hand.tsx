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
  const overlap = cards.length > 7 ? -34 : -18

  return (
    <div className="hand" role="group" aria-label="Your hand">
      {cards.map((card, i) => {
        const playable = canPlay && legal.has(card.key)
        return (
          <span
            key={card.key || i}
            className={`hand__slot${playable ? ' hand__slot--playable' : ''}`}
            style={{ marginLeft: i === 0 ? 0 : overlap }}
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
