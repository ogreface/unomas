/**
 * The countdown, client side.
 *
 * The server sends how much time is **left**, not when the deadline is, and this module is why: a
 * phone's clock can be minutes off, so a shared epoch deadline would render as a different number on
 * every device in the room. Anchoring a duration against the local clock at the moment the frame
 * lands makes every screen agree to within one round-trip, with no clock-sync handshake anywhere.
 *
 * All of this is deliberately pure and free of React, because the arithmetic is the part that is
 * worth testing: "how many seconds does a player see" is exactly the kind of thing that ends up off
 * by one, and off by one at zero is the difference between "1s" and a clock that never reaches the
 * end of its own countdown.
 */

import type { TimerView } from '@flipside/protocol'

/** A server timer plus the local reading of the clock when it arrived. */
export interface AnchoredTimer extends TimerView {
  /** From `monotonicNow()` — a local, same-origin reading, never compared against a server time. */
  at: number
}

/**
 * A clock that cannot jump. `performance.now()` is monotonic; `Date.now()` is not — an NTP
 * correction or the user editing the date mid-turn would otherwise make the countdown leap or stall.
 * (`performance` is present in every browser this app runs in; the fallback is for a bare test
 * runtime, which is where this module's own tests live.)
 */
export function monotonicNow(): number {
  const p = globalThis.performance as Performance | undefined
  return typeof p?.now === 'function' ? p.now() : Date.now()
}

export function anchorTimer(timer: TimerView, now: number = monotonicNow()): AnchoredTimer {
  return { ...timer, at: now }
}

/** Milliseconds left, clamped to the window: never negative, never more than the server allowed. */
export function remainingMs(timer: AnchoredTimer, now: number = monotonicNow()): number {
  const elapsed = Math.max(0, now - timer.at)
  return Math.min(timer.durationMs, Math.max(0, timer.remainingMs - elapsed))
}

/**
 * Whole seconds to show. Rounded **up**, so a running clock reads "1" for the whole of its last
 * second and only reaches "0" when the time is genuinely gone — the way every countdown a player
 * has ever seen behaves.
 */
export function secondsLeft(timer: AnchoredTimer, now: number = monotonicNow()): number {
  return Math.ceil(remainingMs(timer, now) / 1000)
}

/** How much of the window is left, 0…1 — the dial a progress ring is drawn from. */
export function fractionLeft(timer: AnchoredTimer, now: number = monotonicNow()): number {
  if (timer.durationMs <= 0) return 0
  return remainingMs(timer, now) / timer.durationMs
}

/** Below this, the clock is visibly running out: the UI turns it into a warning. */
export const URGENT_MS = 10_000

export function isUrgent(timer: AnchoredTimer, now: number = monotonicNow()): boolean {
  return remainingMs(timer, now) <= URGENT_MS
}
