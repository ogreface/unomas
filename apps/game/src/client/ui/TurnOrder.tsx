import { Fragment, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Direction } from '@flipside/engine'
import { liveGap, revealScroll } from '../lib/turnOrder.js'

/**
 * Every seat at the table — yours included — in seat order, with the direction of play drawn
 * between them. Seat order rather than "starting from you" so that every screen in the room,
 * the projected table included, lists the players identically: on a call, "Bo, you're after Ann"
 * has to be true on everyone's phone.
 *
 * The chevrons point the way play is going and flip when it reverses. The one between the seat the
 * table is waiting on and the next seat is lit, so "who are they playing on" is answered by an
 * arrow rather than by counting. Play wraps around the ends of the row, so the row has a chevron at
 * each end too: when the play crosses from the last seat to the first, both of those light.
 *
 * On a phone the row is wider than the screen, so whenever the turn moves the strip scrolls just
 * far enough to show who is playing and who they are playing on.
 */
export function TurnOrder<P extends { id: string }>({
  players,
  direction,
  toAct,
  next,
  className,
  children,
}: {
  /** In seat order. */
  players: readonly P[]
  direction: Direction
  /** Who the table is waiting on (`playerToActInView`) — the seat the play is coming from. */
  toAct: string | null
  /** The seat being played on, or null between rounds (when no arrow is lit). */
  next: string | null
  className: string
  children: (player: P) => ReactNode
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  const slots = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    const strip = stripRef.current
    const at = toAct === null ? undefined : slots.current.get(toAct)
    if (!strip || !at) return
    const after = next === null ? undefined : slots.current.get(next)
    const span = (el: HTMLElement) => ({ left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth })
    const left = revealScroll(
      { scrollLeft: strip.scrollLeft, width: strip.clientWidth },
      span(at),
      after ? span(after) : null,
    )
    // Smoothness comes from the stylesheet's `scroll-behavior`, which reduced-motion turns off.
    if (left !== strip.scrollLeft) strip.scrollTo({ left })
  }, [toAct, next, players.length])

  const gap = next === null ? null : liveGap(players, toAct, direction)
  const n = players.length
  // Gap 0 is the wrap-around, which is drawn at both ends of the row.
  const lit = (k: number) => gap !== null && (k === gap || (gap === 0 && k === n))

  return (
    <div
      ref={stripRef}
      className={`order ${className}`}
      data-dir={direction === 1 ? 'up' : 'down'}
      role="list"
      aria-label={`Turn order — play goes ${direction === 1 ? 'left to right' : 'right to left'}`}
    >
      <Chevron end lit={lit(0)} />
      {players.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && <Chevron lit={lit(i)} />}
          <div
            role="listitem"
            aria-current={p.id === toAct ? 'step' : undefined}
            className="order__slot"
            ref={el => {
              if (el) slots.current.set(p.id, el)
              else slots.current.delete(p.id)
            }}
          >
            {children(p)}
          </div>
        </Fragment>
      ))}
      <Chevron end lit={lit(n)} />
    </div>
  )
}

function Chevron({ lit, end }: { lit: boolean; end?: boolean }) {
  return (
    <span className={`chevron${end ? ' chevron--end' : ''}${lit ? ' chevron--lit' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 10 16" width="10" height="16">
        <path
          d="M2.5 2.5 L7.5 8 L2.5 13.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/** The tag on the seat being played on. */
export function NextFlag() {
  return <span className="next-flag">next</span>
}
