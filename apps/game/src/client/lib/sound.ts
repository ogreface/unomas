/**
 * The game's sounds, synthesized on the spot with the Web Audio API — no audio files. For the same
 * reason the cards are generated SVG: there is nothing to download, nothing to license, and a cue is
 * a few lines of data that can be retuned without opening an editor.
 *
 * *When* a sound plays is decided in `cues.ts`. This module only makes the noise, and it is built
 * around the two ways a browser refuses to:
 *
 * - **Autoplay.** No browser lets a page make a sound before the person has touched it, and Safari
 *   insists the audio be woken *inside* that touch. So the context is created and resumed from a tap
 *   listener (`installAudioUnlock`), never from a socket message that happens to arrive later.
 * - **Suspension.** iOS suspends a backgrounded page's audio. A suspended context's clock stands
 *   still, so anything scheduled on it would come out all at once on the next tap — a chime for a
 *   turn that is long over. A cue that cannot play right now is therefore dropped, not queued, and
 *   the next tap wakes the context again.
 *
 * Nothing in here may throw: a browser with no Web Audio at all plays nothing and carries on.
 */

import type { Cue } from './cues.js'
import { readStore, writeStore } from './storage.js'

const MUTED_KEY = 'flipside.muted'

/** Overall loudness. These are nudges for somebody on a call, so they sit well under the voices. */
const VOLUME = 0.22

/** The silence between two cues that land at the same moment, so they read as two sounds. */
const GAP_S = 0.06

/** One note of a cue. Times are in seconds from the start of the cue. */
interface Voice {
  freq: number
  at: number
  dur: number
  type?: OscillatorType
  /** Peak loudness of this note, relative to the others. */
  gain?: number
  /** Slide to this pitch across the note — a falling pitch is what makes a blip sound like a tick. */
  glide?: number
}

const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const B5 = 987.77
const C6 = 1046.5
const E6 = 1318.51

const PATCHES: Record<Cue, Voice[]> = {
  /** Two soft rising notes — the friendly "you're up". */
  yourTurn: [
    { freq: E5, at: 0, dur: 0.18, gain: 0.8 },
    { freq: B5, at: 0.12, dur: 0.34, gain: 0.8 },
  ],
  /** A bright, quick run up a major chord: somebody is down to one card. */
  uno: [
    { freq: G5, at: 0, dur: 0.1, type: 'triangle' },
    { freq: C6, at: 0.07, dur: 0.1, type: 'triangle' },
    { freq: E6, at: 0.14, dur: 0.26, type: 'triangle' },
  ],
  /** Two short, level beeps as the ring turns red: ten seconds left. */
  hurry: [
    { freq: 880, at: 0, dur: 0.11, type: 'triangle', gain: 0.9 },
    { freq: 880, at: 0.17, dur: 0.11, type: 'triangle', gain: 0.9 },
  ],
  /** A dry little woodblock tick, once for each of the last five seconds. */
  tick: [{ freq: 1800, glide: 900, at: 0, dur: 0.045, gain: 0.55 }],
  /** A small fanfare: up the chord, landing on it. */
  gameOver: [
    { freq: C5, at: 0, dur: 0.16, type: 'triangle' },
    { freq: E5, at: 0.13, dur: 0.16, type: 'triangle' },
    { freq: G5, at: 0.26, dur: 0.16, type: 'triangle' },
    { freq: C6, at: 0.39, dur: 0.9, type: 'triangle' },
    { freq: E5, at: 0.39, dur: 0.9, gain: 0.35 },
    { freq: G5, at: 0.39, dur: 0.9, gain: 0.35 },
  ],
}

let ctx: AudioContext | null = null
let master: GainNode | null = null
let unlockInstalled = false

export function soundMuted(): boolean {
  return readStore(MUTED_KEY) === '1'
}

/**
 * Switch sound on or off, remembered on this device. Switching it on wakes the audio as it goes —
 * this is called from a button press, which is exactly the moment a browser allows that — and the
 * promise settles once it is awake, so the caller can play something to show it worked.
 */
export function setSoundMuted(muted: boolean): Promise<void> {
  writeStore(MUTED_KEY, muted ? '1' : '0')
  return muted ? Promise.resolve() : wake()
}

/**
 * Listen for the taps that let this page make a sound. Install it once, as the app starts — the tap
 * that counts is usually the one on *Join* or *Start*, long before the first cue — and leave it in
 * place: iOS suspends audio whenever the page goes to the background, and the next tap brings it back.
 */
export function installAudioUnlock(target: EventTarget | undefined = globalThis.window): void {
  if (unlockInstalled || !target) return
  unlockInstalled = true
  const onGesture = () => {
    if (!soundMuted()) void wake()
  }
  // Only some input events count as a gesture: a mouse's `pointerdown`, but a finger's `touchend` or
  // `pointerup` — a touch's pointerdown does not. Capture, so a handler that stops propagation cannot
  // swallow the tap first.
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
    target.addEventListener(type, onGesture, { capture: true, passive: true })
  }
}

/** Play these cues, one after another, now — or not at all. */
export function playCues(cues: readonly Cue[]): void {
  if (cues.length === 0 || soundMuted()) return
  // Never create the context here: outside a tap, a browser hands back one that will not start.
  if (!ctx || !master || ctx.state !== 'running') return
  try {
    let t = ctx.currentTime + 0.01
    for (const cue of cues) t = schedule(ctx, master, PATCHES[cue], t) + GAP_S
  } catch {
    // A half-built graph is just silence; it is not worth breaking the board over.
  }
}

/**
 * Create the context if this browser has one to give, and ask it to start. Settles when it has
 * (or has refused); never rejects.
 */
function wake(): Promise<void> {
  if (!ctx) {
    const Ctor = audioContextConstructor()
    if (!Ctor) return Promise.resolve()
    try {
      const made = new Ctor()
      master = made.createGain()
      master.gain.value = VOLUME
      master.connect(made.destination)
      ctx = made
    } catch {
      master = null
      return Promise.resolve()
    }
  }
  if (ctx.state === 'running') return Promise.resolve()
  try {
    // Wrapped, because an old WebKit's `resume()` is not guaranteed to hand back a promise.
    return Promise.resolve(ctx.resume()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

function audioContextConstructor(): (new () => AudioContext) | undefined {
  const g = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
  return g.AudioContext ?? g.webkitAudioContext
}

/** Lay one cue's notes onto the graph starting at `t0`. Returns when the last of them ends. */
function schedule(ctx: AudioContext, out: AudioNode, voices: readonly Voice[], t0: number): number {
  let end = t0
  for (const v of voices) {
    const start = t0 + v.at
    const stop = start + v.dur
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = v.type ?? 'sine'
    osc.frequency.setValueAtTime(v.freq, start)
    if (v.glide) osc.frequency.exponentialRampToValueAtTime(v.glide, stop)
    // A fast attack and an exponential fall: struck, like a bell or a key, rather than switched on.
    // (Exponential ramps cannot reach zero, so silence here is a ten-thousandth.)
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(v.gain ?? 1, start + Math.min(0.012, v.dur / 4))
    env.gain.exponentialRampToValueAtTime(0.0001, stop)
    osc.connect(env).connect(out)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
    osc.start(start)
    osc.stop(stop + 0.02)
    end = Math.max(end, stop)
  }
  return end
}
