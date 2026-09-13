import { describe, expect, it } from 'vitest'
import {
  anchorTimer,
  fractionLeft,
  isUrgent,
  remainingMs,
  secondsLeft,
  URGENT_MS,
} from './turnClock.js'
import type { AnchoredTimer } from './turnClock.js'

/**
 * The countdown every player watches. Two things are worth pinning down: it is anchored to the local
 * clock (so a phone whose idea of the time is wrong still shows the right number of seconds), and it
 * ends at zero rather than sailing past it.
 */

function timer(patch: Partial<AnchoredTimer> = {}): AnchoredTimer {
  return {
    player: 'p_ann',
    phase: 'awaitingPlay',
    durationMs: 30_000,
    remainingMs: 30_000,
    at: 1_000,
    ...patch,
  }
}

describe('remainingMs', () => {
  it('counts down from whatever the server said was left', () => {
    const t = timer({ remainingMs: 27_400, at: 1_000 })
    expect(remainingMs(t, 1_000)).toBe(27_400)
    expect(remainingMs(t, 6_000)).toBe(22_400)
  })

  it('never goes negative, however long the tab was asleep', () => {
    expect(remainingMs(timer(), 10_000_000)).toBe(0)
  })

  it('never exceeds the window, even if the local clock jumped backwards', () => {
    const t = timer({ remainingMs: 30_000 })
    expect(remainingMs(t, -50_000)).toBe(30_000)
  })

  it('is measured from the frame’s own arrival, so a skewed device clock is irrelevant', () => {
    // Same server timer, two devices whose clocks are wildly different. Five seconds after each of
    // them received it, both show the same time left.
    const onTime = timer({ remainingMs: 30_000, at: 1_000 })
    const skewed = timer({ remainingMs: 30_000, at: 9_000_000 })
    expect(remainingMs(onTime, 6_000)).toBe(remainingMs(skewed, 9_005_000))
  })
})

describe('secondsLeft', () => {
  it('rounds up, so the last second is shown as 1 and not as 0', () => {
    const t = timer({ remainingMs: 30_000, at: 0 })
    expect(secondsLeft(t, 0)).toBe(30)
    expect(secondsLeft(t, 100)).toBe(30) // 29.9s left
    expect(secondsLeft(t, 29_500)).toBe(1) // 0.5s left
    expect(secondsLeft(t, 30_000)).toBe(0) // genuinely out of time
  })
})

describe('fractionLeft', () => {
  it('runs 1 → 0 across the window', () => {
    const t = timer({ durationMs: 30_000, remainingMs: 30_000, at: 0 })
    expect(fractionLeft(t, 0)).toBe(1)
    expect(fractionLeft(t, 15_000)).toBeCloseTo(0.5)
    expect(fractionLeft(t, 30_000)).toBe(0)
  })

  it('is 0 rather than NaN for a zero-length window', () => {
    expect(fractionLeft(timer({ durationMs: 0, remainingMs: 0 }), 0)).toBe(0)
  })
})

describe('isUrgent', () => {
  it('turns on in the last ten seconds', () => {
    const t = timer({ remainingMs: 30_000, at: 0 })
    expect(isUrgent(t, 19_000)).toBe(false)
    expect(isUrgent(t, 30_000 - URGENT_MS)).toBe(true)
    expect(isUrgent(t, 30_000)).toBe(true)
  })
})

describe('anchorTimer', () => {
  it('stamps the local arrival time onto the server’s timer, untouched', () => {
    const anchored = anchorTimer({ player: 'p_bo', phase: 'awaitingChallenge', durationMs: 30_000, remainingMs: 12_000 }, 500)
    expect(anchored).toEqual({
      player: 'p_bo',
      phase: 'awaitingChallenge',
      durationMs: 30_000,
      remainingMs: 12_000,
      at: 500,
    })
  })
})
