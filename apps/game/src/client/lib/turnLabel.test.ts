import { describe, expect, it } from 'vitest'
import type { PhaseView } from '@flipside/engine'
import { turnLabel } from './turnLabel.js'

/**
 * The words in the top bar. They have one job — say who the table is waiting on — and the way to get
 * it wrong is to read it off the turn, because the turn and the outstanding decision are not always
 * the same seat.
 */

const players = [
  { id: 'p_ann', name: 'Ann' },
  { id: 'p_bo', name: 'Bo' },
  { id: 'p_byte', name: 'Byte' },
]
const bots = new Set(['p_byte'])

function view(you: string, turn: string | null, phase: PhaseView) {
  return { you, turn, phase, players }
}

/** Ann has just played a Wild Draw Two at `challenger`: the turn is still hers, the decision is not. */
function challengeOn(challenger: string): PhaseView {
  return {
    t: 'awaitingChallenge',
    challenger,
    accused: 'p_ann',
    kind: 'wildDraw2',
    color: 'red',
    priorColor: 'blue',
    resume: { actor: 0, extraSkips: 0, forcedTurn: null },
  }
}

describe('turnLabel', () => {
  it('says it is your turn when the play is yours', () => {
    expect(turnLabel(view('p_ann', 'p_ann', { t: 'awaitingPlay' }), bots)).toBe('Your turn')
  })

  it('names the opponent the table is waiting on', () => {
    expect(turnLabel(view('p_bo', 'p_ann', { t: 'awaitingPlay' }), bots)).toBe('Ann’s turn')
  })

  it('says a computer player is thinking, rather than looking like a stall', () => {
    expect(turnLabel(view('p_ann', 'p_byte', { t: 'awaitingPlay' }), bots)).toBe('Byte is thinking…')
  })

  describe('while a wild draw waits on a challenge', () => {
    it('tells the challenger it is on them, not on the player who played the card', () => {
      expect(turnLabel(view('p_bo', 'p_ann', challengeOn('p_bo')), bots)).toBe('Your turn')
    })

    it('stops telling the player who played it that it is their turn', () => {
      expect(turnLabel(view('p_ann', 'p_ann', challengeOn('p_bo')), bots)).toBe('Bo’s turn')
    })

    it('says a computer challenger is thinking, not that it is still your turn', () => {
      expect(turnLabel(view('p_ann', 'p_ann', challengeOn('p_byte')), bots)).toBe('Byte is thinking…')
    })
  })

  it('names the chooser while a colour is owed', () => {
    const phase: PhaseView = { t: 'awaitingColorChoice', chooser: 'p_bo', reason: 'opening', resume: null }
    expect(turnLabel(view('p_ann', 'p_bo', phase), bots)).toBe('Bo’s turn')
    expect(turnLabel(view('p_bo', 'p_bo', phase), bots)).toBe('Your turn')
  })

  it('names nobody once the round is over, whoever played last', () => {
    expect(turnLabel(view('p_ann', 'p_ann', { t: 'roundOver', winner: 'p_ann', points: 20 }), bots)).toBe('—')
  })
})
