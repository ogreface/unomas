import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The sound player. Two things are worth pinning: it never throws on a browser that cannot or will
 * not play sound, and it never saves sound up — a cue that could not play when it happened is
 * dropped, not delivered late in a burst the next time somebody taps the screen.
 */

/** The module holds its one AudioContext at module level, so every case gets a fresh copy. */
async function freshSound() {
  vi.resetModules()
  return import('./sound.js')
}

interface FakeOscillator {
  type: string
  startedAt: number | null
}

/**
 * Just enough of the Web Audio graph for the player to build on. It starts `suspended`, the way a
 * browser hands one over before the page has been touched.
 */
class FakeAudioContext {
  static made: FakeAudioContext[] = []
  state: 'suspended' | 'running' | 'interrupted' = 'suspended'
  currentTime = 0
  destination = {}
  oscillators: FakeOscillator[] = []

  constructor() {
    FakeAudioContext.made.push(this)
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }

  createGain() {
    const param = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }
    return { gain: param, connect: (n: unknown) => n, disconnect() {} }
  }

  createOscillator() {
    const osc = {
      type: 'sine',
      startedAt: null as number | null,
      frequency: { value: 440, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      onended: null as null | (() => void),
      connect: (n: unknown) => n,
      disconnect() {},
      start(t: number) {
        osc.startedAt = t
      },
      stop() {},
    }
    this.oscillators.push(osc)
    return osc
  }
}

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as Storage
}

/** A tap on the page, which is the only thing a browser accepts as permission to make a sound. */
async function tap(target: EventTarget) {
  target.dispatchEvent(new Event('pointerdown'))
  await Promise.resolve()
}

beforeEach(() => {
  FakeAudioContext.made = []
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a browser with no Web Audio at all', () => {
  it('plays nothing, and does not throw', async () => {
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    expect(() => playCues(['yourTurn', 'uno', 'hurry', 'tick', 'gameOver'])).not.toThrow()
  })

  it('does not throw when there is no page to listen on either', async () => {
    const { installAudioUnlock } = await freshSound()
    expect(() => installAudioUnlock(undefined)).not.toThrow()
  })
})

describe('with Web Audio', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  it('makes no context until the page is touched — a browser would refuse to start it', async () => {
    const { installAudioUnlock, playCues } = await freshSound()
    installAudioUnlock(new EventTarget())
    playCues(['yourTurn'])
    expect(FakeAudioContext.made).toHaveLength(0)
  })

  it('wakes on the first tap and plays from then on', async () => {
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)

    const ctx = FakeAudioContext.made[0]!
    expect(ctx.state).toBe('running')
    playCues(['yourTurn'])
    expect(ctx.oscillators.length).toBeGreaterThan(0)
  })

  it('uses Safari’s prefixed constructor where that is all there is', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', FakeAudioContext)
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    playCues(['tick'])
    expect(FakeAudioContext.made[0]!.oscillators.length).toBeGreaterThan(0)
  })

  it('drops a cue it cannot play now rather than saving it for later', async () => {
    // iOS suspends a backgrounded page's audio. A suspended context's clock stands still, so anything
    // scheduled on it would all come out at once on the next tap — a chime for a turn long gone.
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    const ctx = FakeAudioContext.made[0]!
    ctx.state = 'interrupted'

    playCues(['yourTurn', 'tick'])
    expect(ctx.oscillators).toHaveLength(0)
  })

  it('wakes again on the next tap after the browser suspended it', async () => {
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    const ctx = FakeAudioContext.made[0]!
    ctx.state = 'interrupted'

    await tap(page)
    expect(ctx.state).toBe('running')
    expect(FakeAudioContext.made).toHaveLength(1) // the same context, woken, not a second one
    playCues(['tick'])
    expect(ctx.oscillators.length).toBeGreaterThan(0)
  })

  it('plays the cues of one moment one after another, not on top of each other', async () => {
    const { installAudioUnlock, playCues } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    const ctx = FakeAudioContext.made[0]!

    playCues(['uno'])
    const unoVoices = ctx.oscillators.length
    const unoStarts = ctx.oscillators.map(o => o.startedAt!)
    ctx.oscillators = []

    playCues(['uno', 'yourTurn'])
    const turnStarts = ctx.oscillators.slice(unoVoices).map(o => o.startedAt!)
    expect(Math.min(...turnStarts)).toBeGreaterThan(Math.max(...unoStarts))
  })
})

describe('mute', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  it('is off until somebody turns it on', async () => {
    const { soundMuted } = await freshSound()
    expect(soundMuted()).toBe(false)
  })

  it('silences every cue', async () => {
    const { installAudioUnlock, playCues, setSoundMuted } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    setSoundMuted(true)

    playCues(['yourTurn', 'gameOver'])
    expect(FakeAudioContext.made[0]!.oscillators).toHaveLength(0)
  })

  it('is remembered across a reload', async () => {
    const first = await freshSound()
    first.setSoundMuted(true)
    const second = await freshSound()
    expect(second.soundMuted()).toBe(true)
  })

  it('makes no audio at all for a player who has it muted, not even on a tap', async () => {
    const first = await freshSound()
    first.setSoundMuted(true)
    const { installAudioUnlock } = await freshSound()
    const page = new EventTarget()
    installAudioUnlock(page)
    await tap(page)
    expect(FakeAudioContext.made).toHaveLength(0)
  })

  it('wakes the audio as it is switched off — the switch is itself a tap', async () => {
    const first = await freshSound()
    first.setSoundMuted(true)
    const { setSoundMuted, playCues } = await freshSound()

    await setSoundMuted(false)
    playCues(['tick'])
    expect(FakeAudioContext.made[0]!.oscillators.length).toBeGreaterThan(0)
  })

  it('still works, for the tab, when storage throws', async () => {
    const boom = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom } as unknown as Storage)
    const { setSoundMuted, soundMuted } = await freshSound()

    expect(soundMuted()).toBe(false)
    expect(() => setSoundMuted(true)).not.toThrow()
    expect(soundMuted()).toBe(true)
  })
})
