import { describe, expect, it } from 'vitest'
import { DECK, CARDS_BY_ID } from '../src/index.js'
import type { Face, Side } from '../src/index.js'
import { faceStr } from './harness.js'

const count = (side: Side, pred: (f: Face) => boolean): number =>
  DECK.filter(c => pred(c[side])).length

describe('the 112-card deck', () => {
  it('is 112 cards with unique ids', () => {
    expect(DECK).toHaveLength(112)
    expect(new Set(DECK.map(c => c.id)).size).toBe(112)
    expect(CARDS_BY_ID.size).toBe(112)
  })

  // The widely-repeated "76 number / 28 action / 8 wild" figure is wrong. It is 72/32/8, and this
  // is the assertion that keeps a well-meaning future edit from "fixing" the deck to match a bad
  // source on the internet.
  for (const side of ['light', 'dark'] as const) {
    it(`${side} side is 72 numbers / 32 coloured actions / 8 wilds`, () => {
      expect(count(side, f => f.kind === 'number')).toBe(72)
      expect(count(side, f => f.color !== null && f.kind !== 'number')).toBe(32)
      expect(count(side, f => f.color === null)).toBe(8)
    })

    it(`${side} side has no zero card`, () => {
      expect(count(side, f => f.kind === 'number' && f.value === 0)).toBe(0)
      expect(count(side, f => f.kind === 'number' && (f.value! < 1 || f.value! > 9))).toBe(0)
    })
  }

  it('has two of every numbered card, per colour, per side', () => {
    for (const [side, colors] of [
      ['light', ['red', 'yellow', 'green', 'blue']],
      ['dark', ['pink', 'teal', 'orange', 'purple']],
    ] as const) {
      for (const color of colors) {
        for (let v = 1; v <= 9; v++) {
          expect(count(side, f => f.kind === 'number' && f.color === color && f.value === v)).toBe(2)
        }
      }
    }
  })

  it('has the right action counts on each side', () => {
    for (const kind of ['draw1', 'skip', 'reverse', 'flip'] as const) {
      expect(count('light', f => f.kind === kind)).toBe(8)
    }
    for (const kind of ['draw5', 'skipEveryone', 'reverse', 'flip'] as const) {
      expect(count('dark', f => f.kind === kind)).toBe(8)
    }
    expect(count('light', f => f.kind === 'wild')).toBe(4)
    expect(count('light', f => f.kind === 'wildDraw2')).toBe(4)
    expect(count('dark', f => f.kind === 'wild')).toBe(4)
    expect(count('dark', f => f.kind === 'wildDrawColor')).toBe(4)
  })

  // These two facts about the *pairing* are the reason the deck had to be transcribed from a
  // physical copy rather than derived. They are also load-bearing for the information channel, so
  // if a future deck edit quietly makes the pairing type-preserving, these fail.
  it('the light↔dark pairing is NOT type-preserving', () => {
    const typePreserving = DECK.every(c => c.light.kind === c.dark.kind)
    expect(typePreserving).toBe(false)

    // The three the docs call out by name.
    expect(DECK.some(c => faceStr(c.light) === 'blue reverse' && faceStr(c.dark) === 'wild')).toBe(true)
    expect(DECK.some(c => faceStr(c.light) === 'red skip' && faceStr(c.dark) === 'orange draw5')).toBe(true)
    expect(DECK.some(c => faceStr(c.light) === 'yellow reverse' && faceStr(c.dark) === 'teal flip')).toBe(true)
  })

  it('no card is a wild on both sides', () => {
    const lightWilds = DECK.filter(c => c.light.color === null).map(c => c.id)
    const darkWilds = DECK.filter(c => c.dark.color === null).map(c => c.id)

    expect(lightWilds).toHaveLength(8)
    expect(darkWilds).toHaveLength(8)
    expect(lightWilds.filter(id => darkWilds.includes(id))).toEqual([])
  })

  // D3 depends on this number: a Flip can only leave the table with no active colour if the card
  // it exposes is a dark wild — and exactly eight cards can do that.
  it('exactly 8 cards can have a Flip expose a wild face on the dark side', () => {
    const exposable = DECK.filter(c => c.dark.color === null).map(c => c.id)
    expect(exposable).toEqual(['c031', 'c045', 'c055', 'c065', 'c085', 'c087', 'c097', 'c109'])
  })
})
