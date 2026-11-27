import { describe, expect, it } from 'vitest'
import type { EventView, PhaseView, PlayerView } from '@flipside/engine'
import { clockCues, gameCues } from './cues.js'
import type { ClockMemory, ClockSample } from './cues.js'

/**
 * Which sound plays, and when. The rule underneath all of them: a sound is a nudge for *this*
 * player, so it fires on the moment something changes — never on a state that merely persists, and
 * never twice for the same moment.
 */

const YOU = 'p_you'
const BO = 'p_bo'

/** Just enough of a `PlayerView` for the parts the cues read: who is on move, in what phase. */
function view(patch: { turn?: string | null; phase?: PhaseView } = {}): PlayerView {
  return {
    you: YOU,
    turn: BO,
    phase: { t: 'awaitingPlay' },
    ...patch,
  } as PlayerView
}

const unoCalled = (player: string): EventView => ({ t: 'unoCalled', player })
const gameEnded = (winner: string): EventView => ({ t: 'gameEnded', winner })

describe('gameCues — your turn', () => {
  it('chimes when the move passes to you', () => {
    expect(gameCues(view({ turn: BO }), view({ turn: YOU }), [])).toEqual(['yourTurn'])
  })

  it('stays quiet while the move stays yours — drawing, then deciding on the drawn card', () => {
    const drew = view({ turn: YOU, phase: { t: 'awaitingDrawnCardChoice', card: 'k1' } })
    expect(gameCues(view({ turn: YOU }), drew, [])).toEqual([])
  })

  it('stays quiet when the move passes to somebody else', () => {
    expect(gameCues(view({ turn: YOU }), view({ turn: BO }), [])).toEqual([])
  })

  it('chimes for a decision you owe while the turn is somebody else’s — a challenge', () => {
    const challenge = view({
      turn: BO,
      phase: {
        t: 'awaitingChallenge',
        challenger: YOU,
        accused: BO,
        kind: 'wildDraw2',
        color: 'red',
        priorColor: 'blue',
        resume: { actor: 1, extraSkips: 0, forcedTurn: null },
      },
    })
    expect(gameCues(view({ turn: BO }), challenge, [])).toEqual(['yourTurn'])
  })

  it('chimes for a colour you owe after a Flip shows a wild', () => {
    const choose = view({
      turn: BO,
      phase: { t: 'awaitingColorChoice', chooser: YOU, reason: 'flip', resume: null } as PhaseView,
    })
    expect(gameCues(view({ turn: BO }), choose, [])).toEqual(['yourTurn'])
  })

  it('does not chime again when your own Flip hands you the colour choice', () => {
    const choose = view({
      turn: YOU,
      phase: { t: 'awaitingColorChoice', chooser: YOU, reason: 'flip', resume: null } as PhaseView,
    })
    expect(gameCues(view({ turn: YOU }), choose, [])).toEqual([])
  })

  it('chimes when the round opens on you, with nothing before it to compare against', () => {
    expect(gameCues(null, view({ turn: YOU }), [])).toEqual(['yourTurn'])
  })

  it('chimes when the next round is dealt and you lead', () => {
    const between = view({ turn: YOU, phase: { t: 'roundOver', winner: YOU, points: 40 } })
    expect(gameCues(between, view({ turn: YOU }), [])).toEqual(['yourTurn'])
  })

  it('is silent between rounds, whoever the turn pointer is left on', () => {
    const between = view({ turn: YOU, phase: { t: 'roundOver', winner: BO, points: 40 } })
    expect(gameCues(view({ turn: BO }), between, [])).toEqual([])
  })
})

describe('gameCues — UNO', () => {
  it('sounds for everybody when anybody calls UNO', () => {
    expect(gameCues(view(), view(), [unoCalled(BO)])).toEqual(['uno'])
  })

  it('sounds for the caller too — it is the confirmation the call landed', () => {
    expect(gameCues(view({ turn: YOU }), view({ turn: BO }), [unoCalled(YOU)])).toEqual(['uno'])
  })

  it('plays once however many calls land in one batch', () => {
    expect(gameCues(view(), view(), [unoCalled(BO), unoCalled(YOU)])).toEqual(['uno'])
  })

  it('plays before the turn chime when both land at once', () => {
    expect(gameCues(view({ turn: BO }), view({ turn: YOU }), [unoCalled(BO)])).toEqual(['uno', 'yourTurn'])
  })
})

describe('gameCues — game over', () => {
  it('plays the fanfare when the game ends', () => {
    const over = view({ turn: BO, phase: { t: 'gameOver', winner: BO } })
    expect(gameCues(view(), over, [gameEnded(BO)])).toEqual(['gameOver'])
  })

  it('drowns out everything else in that batch — the game is over, nobody is on move', () => {
    const over = view({ turn: YOU, phase: { t: 'gameOver', winner: BO } })
    expect(gameCues(view(), over, [unoCalled(BO), gameEnded(BO)])).toEqual(['gameOver'])
  })

  it('stays quiet for the end of a round that is not the end of the game', () => {
    const roundEnded: EventView = { t: 'roundEnded', winner: BO, points: 30, scores: [] }
    const between = view({ phase: { t: 'roundOver', winner: BO, points: 30 } })
    expect(gameCues(view(), between, [roundEnded])).toEqual([])
  })
})

describe('clockCues — time running out', () => {
  const sample = (seconds: number, player = YOU, phase: ClockSample['phase'] = 'awaitingPlay'): ClockSample => ({
    player,
    phase,
    seconds,
  })

  /** Feed a run of readings through, the way the screen's ticking clock does, collecting cues. */
  function run(readings: (ClockSample | null)[], start: ClockMemory | null = null) {
    let memory = start
    const heard: string[][] = []
    for (const r of readings) {
      const out = clockCues(memory, r, YOU)
      memory = out.memory
      heard.push(out.cues)
    }
    return { heard, memory }
  }

  it('warns once as your clock crosses into its last ten seconds', () => {
    const { heard } = run([sample(12), sample(11), sample(11), sample(10), sample(10), sample(9)])
    expect(heard.flat()).toEqual(['hurry'])
    expect(heard[3]).toEqual(['hurry'])
  })

  it('ticks once for each of the last five seconds, and not at zero', () => {
    const { heard } = run([6, 5, 5, 4, 3, 3, 2, 1, 1, 0].map(s => sample(s)))
    expect(heard.flat()).toEqual(['tick', 'tick', 'tick', 'tick', 'tick'])
  })

  it('says nothing about somebody else’s clock', () => {
    const { heard } = run([12, 10, 5, 4, 3, 2, 1].map(s => sample(s, BO)))
    expect(heard.flat()).toEqual([])
  })

  it('says nothing on first sight of a clock already low — a reconnect is not a countdown', () => {
    expect(run([sample(4)]).heard.flat()).toEqual([])
  })

  it('does not repeat a cue when a fresh frame re-anchors the clock a second higher', () => {
    // Any event mid-turn re-sends the timer, and the network latency in it can read a second more
    // than this screen had already counted down to. That is the same moment, not a new one.
    const { heard } = run([sample(11), sample(10), sample(11), sample(10), sample(9)])
    expect(heard.flat()).toEqual(['hurry'])
  })

  it('starts over on a fresh clock for the same player — a Skip that comes back to you', () => {
    const { heard } = run([sample(11), sample(10), sample(30), sample(11), sample(10)])
    expect(heard.flat()).toEqual(['hurry', 'hurry'])
  })

  it('starts over when the clock moves to a different decision', () => {
    const { heard } = run([sample(11), sample(10), sample(11, YOU, 'awaitingDrawnCardChoice'), sample(10, YOU, 'awaitingDrawnCardChoice')])
    expect(heard.flat()).toEqual(['hurry', 'hurry'])
  })

  it('plays one cue, not a pile-up, when a sleeping tab skips several seconds at once', () => {
    const { heard } = run([sample(12), sample(4)])
    expect(heard.flat()).toEqual(['hurry'])
  })

  it('forgets the clock when nobody is on it', () => {
    const { memory } = run([sample(12), null])
    expect(memory).toBeNull()
  })
})
