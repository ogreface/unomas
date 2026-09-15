import { useLayoutEffect, useRef, useState } from 'react'
import type { CardView, Side } from '@flipside/engine'
import { Card } from './Card.js'

/** Card width in the fan. The hand is the one place cards are drawn small enough to overlap. */
const CARD_W = 78
/**
 * The narrowest a covered card may be squeezed to. A card's corner pip sits ~10px in from its left
 * edge, so 26px leaves the pip plus a slice of the body colour — which is the whole job of the fan:
 * every card in the hand readable at a glance without tapping through them.
 */
const MIN_STEP = 26

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
  const railRef = useRef<HTMLDivElement>(null)
  const [railW, setRailW] = useState(0)

  // The rail's own width, not the window's: the hand has to fit whatever box it is given.
  useLayoutEffect(() => {
    const el = railRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box) setRailW(box.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /*
   * How far each card advances past the one beneath it. The fan closes up as the hand grows so that
   * a normal hand always fits on screen — a fixed overlap did not: seven cards at the old -18 came
   * to 438px, wider than the phone it was dealt on, so the last card of an opening hand hung off
   * the right edge. Past MIN_STEP the fan stops closing and the rail scrolls instead, because a
   * card squeezed below its corner pip has stopped being worth showing at all.
   */
  const measured = railW > CARD_W
  const step = measured
    ? Math.min(CARD_W, Math.max(MIN_STEP, (railW - CARD_W) / Math.max(1, cards.length - 1)))
    : CARD_W + (cards.length > 7 ? -26 : -18)
  const overlap = step - CARD_W

  return (
    <div className="hand" role="group" aria-label="Your hand" ref={railRef}>
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
              width={CARD_W}
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
