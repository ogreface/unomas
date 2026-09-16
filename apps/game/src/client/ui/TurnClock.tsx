import { useEffect, useState } from 'react'
import {
  fractionLeft,
  isUrgent,
  monotonicNow,
  secondsLeft,
} from '../lib/turnClock.js'
import type { AnchoredTimer } from '../lib/turnClock.js'

/**
 * The turn clock on screen.
 *
 * Everyone sees the same countdown — that is the point of it. A player who has wandered off is a
 * problem for the whole table, so the ring appears on the top bar, on the opponent who owes the
 * move, and on the projected table view, all reading the one timer the server sent.
 *
 * The ticking lives in a single hook per screen rather than one interval per ring: the seconds are
 * computed once and handed down, so five opponents do not mean five timers drifting apart.
 */

/** How often the ring redraws. Fast enough that the sweep looks continuous, slow enough to be free. */
const TICK_MS = 200

export interface ClockReading {
  timer: AnchoredTimer
  seconds: number
  fraction: number
  urgent: boolean
}

/** Read the countdown, re-rendering as it runs. Null when nobody is on the clock. */
export function useTurnClock(timer: AnchoredTimer | null): ClockReading | null {
  const [now, setNow] = useState(() => monotonicNow())

  useEffect(() => {
    if (!timer) return
    setNow(monotonicNow())
    const id = setInterval(() => setNow(monotonicNow()), TICK_MS)
    return () => clearInterval(id)
  }, [timer])

  if (!timer) return null
  return {
    timer,
    seconds: secondsLeft(timer, now),
    fraction: fractionLeft(timer, now),
    urgent: isUrgent(timer, now),
  }
}

/**
 * A countdown ring. An SVG circle whose stroke is the time left, with the seconds in the middle —
 * legible at 28px on a phone beside a player's name and at 72px across a room on the projector.
 *
 * `role="timer"` with no live region is deliberate: a screen reader announcing every tick would make
 * the game unplayable, and the whole label is on the element for anyone who goes looking.
 */
export function TurnClock({
  clock,
  size = 34,
  label,
}: {
  clock: ClockReading
  size?: number
  /** Who is being timed, for the accessible label. */
  label: string
}) {
  const stroke = Math.max(2, Math.round(size / 12))
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r

  return (
    <span
      className={`turn-clock${clock.urgent ? ' turn-clock--urgent' : ''}`}
      style={{ width: size, height: size }}
      role="timer"
      aria-label={`${label}: ${clock.seconds} second${clock.seconds === 1 ? '' : 's'} left to move`}
      title={`${label} has ${clock.seconds}s to move`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="turn-clock__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="turn-clock__sweep"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          // Drawn from 12 o'clock, unwinding clockwise as the time goes.
          strokeDashoffset={circumference * (1 - clock.fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="turn-clock__num" style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}>
        {clock.seconds}
      </span>
    </span>
  )
}
