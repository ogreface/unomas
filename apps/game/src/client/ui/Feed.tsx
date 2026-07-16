import type { EventView } from '@flipside/engine'
import type { FeedEvent } from '../net/useRoom.js'

/**
 * The event → callout layer. The server sends an ordered `EventView[]` per action; we already fold
 * the resulting view into state immediately, and here we surface the *narration* — the human-legible
 * "what just happened" — as a short stack of self-fading toasts. Flip gets a louder banner, because
 * the whole-pile inversion is exactly the moment a real player needs told what the new card is.
 */
export function Feed({ feed, nameOf }: { feed: FeedEvent[]; nameOf: (id: string) => string }) {
  const visible = feed.filter(f => describe(f.event, nameOf) !== null).slice(-4)
  const newest = feed[feed.length - 1]?.event
  const flipping = newest?.t === 'flipped'

  return (
    <>
      {flipping && <div className="flip-banner">FLIP — now the {newest.side} side</div>}
      <div className="feed" aria-live="polite">
        {visible.map(f => (
          <div key={f.id} className={`toast toast--${f.event.t}`}>
            {describe(f.event, nameOf)}
          </div>
        ))}
      </div>
    </>
  )
}

/** A one-line narration for an event, or null for the ones too mechanical to show. */
export function describe(event: EventView, nameOf: (id: string) => string): string | null {
  switch (event.t) {
    case 'roundStarted':
      return `Round ${event.round} — ${nameOf(event.starter)} leads`
    case 'cardPlayed':
      return `${nameOf(event.player)} played ${faceLabel(event)}`
    case 'cardsDrawn':
      return `${nameOf(event.player)} drew ${event.count}`
    case 'passed':
      return `${nameOf(event.player)} passed`
    case 'flipped':
      return `Flipped to the ${event.side} side`
    case 'colorChosen':
      return `${nameOf(event.player)} chose ${event.color}`
    case 'directionChanged':
      return 'Play reversed'
    case 'skipped':
      return `${nameOf(event.player)} was skipped`
    case 'skippedEveryone':
      return `${nameOf(event.by)} skipped everyone`
    case 'unoCalled':
      return `${nameOf(event.player)} called UNO!`
    case 'unoPenalty':
      return `${nameOf(event.player)} was caught — +${event.cards}`
    case 'calloutFailed':
      return `${nameOf(event.player)} called out ${nameOf(event.target)} — safe`
    case 'challengeOpened':
      return `${nameOf(event.challenger)} may challenge`
    case 'challenged':
      return `${nameOf(event.challenger)} challenged ${nameOf(event.accused)} — ${event.guilty ? 'guilty' : 'innocent'}`
    case 'drawAccepted':
      return `${nameOf(event.player)} took the cards`
    case 'reshuffled':
      return `Reshuffled ${event.count} cards`
    case 'pilesExhausted':
      return 'Both piles are exhausted'
    case 'roundEnded':
      return `${nameOf(event.winner)} won the round (+${event.points})`
    case 'gameEnded':
      return `${nameOf(event.winner)} wins the game!`
    default:
      return null
  }
}

function faceLabel(event: Extract<EventView, { t: 'cardPlayed' }>): string {
  const face = event.face
  if (face.kind === 'number') return `${face.color} ${face.value}`
  if (face.color === null) return face.kind === 'wild' ? 'a Wild' : `a ${face.kind}`
  return `${face.color} ${face.kind}`
}
