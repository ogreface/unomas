/**
 * Redaction, and the inverted-information channel.
 *
 * *"Hold the cards with the Light Side facing you and the Dark Side facing your opponents."*
 *
 * You see the **active** face of your own hand. Your opponents see its **inactive** face. That
 * asymmetry is a real, deliberate mechanic — and it is worth nothing at all if the client can
 * derive one face from the other. These tests are the guard on that.
 */

import { describe, expect, it } from 'vitest'
import { cardIdForKey, keyOf, redactEvent, tableView, viewFor } from '../src/index.js'
import type { CardId, PlayerId } from '../src/index.js'
import { Deal, Game, face, faceStr } from './harness.js'

function rigged(top: CardId, hands: Record<PlayerId, CardId[]>, side: 'light' | 'dark' = 'light'): Game {
  const g = new Game({ players: 4 })
  g.do({ type: 'startRound' })
  g.rig({
    discard: [top],
    hands,
    turn: 'p0',
    side,
    direction: 1,
    declaredColor: null,
    phase: { t: 'awaitingPlay' },
  })
  return g
}

describe('the information channel', () => {
  it('you see your own ACTIVE faces and your opponents’ INACTIVE faces', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const mine = d.both('blue 5', 'pink 9') // to me: blue 5. To them: pink 9.
    const theirs = d.both('blue reverse', 'wild') // to them: blue reverse. To me: a Wild.

    const g = rigged(top, { p0: [mine], p1: [theirs], p2: [], p3: [] })
    const view = viewFor(g.state, 'p0')

    // My own hand, light side up.
    expect(view.hand).toHaveLength(1)
    expect(faceStr(view.hand[0]!.face)).toBe('blue 5')

    // I do NOT see my own dark face anywhere in my view.
    const everything = JSON.stringify(view)
    expect(everything).not.toContain('pink')

    // But I DO see p1's dark face — and it tells me their boring-looking Reverse is a Wild.
    const p1 = view.players.find(p => p.id === 'p1')!
    expect(p1.visible).toHaveLength(1)
    expect(faceStr(p1.visible[0]!.face)).toBe('wild')

    // And I do not see p1's light face.
    expect(everything).not.toContain('reverse')
  })

  it('and it inverts when the table flips', () => {
    const d = new Deal()
    const top = d.face('dark', 'teal 2')
    const mine = d.both('blue 5', 'pink 9')

    const g = rigged(top, { p0: [mine], p1: [mine === '' ? '' : d.both('blue 2', 'orange 8')], p2: [], p3: [] }, 'dark')
    const view = viewFor(g.state, 'p0')

    // Dark side now: I see my dark face…
    expect(faceStr(view.hand[0]!.face)).toBe('pink 9')
    // …and my opponents see my light one, which I no longer see.
    const p1 = view.players.find(p => p.id === 'p1')!
    expect(faceStr(p1.visible[0]!.face)).toBe('blue 2')
  })

  it('you never see your own hand in the `visible` list', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: [], p3: [] })

    const view = viewFor(g.state, 'p0')
    expect(view.players.find(p => p.id === 'p0')!.visible).toEqual([])
    expect(view.players.find(p => p.id === 'p1')!.visible).toHaveLength(3)
  })

  // Setup step 4: the draw pile goes down light-side-*down*, so the whole table can see the dark
  // face of the next card to be drawn.
  it('everyone can see the inactive face of the draw pile’s top card, and nothing below it', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(2), p1: d.filler(2), p2: [], p3: [] })

    const nextUp = g.state.drawPile[g.state.drawPile.length - 1]!
    const view = viewFor(g.state, 'p0')

    expect(view.drawPile.peek).not.toBeNull()
    expect(view.drawPile.peek!.key).toBe(keyOf(g.state, nextUp))

    // The pile is light-side-DOWN, so what the table sees is the card's dark face — the *inactive*
    // one, while play is on the light side.
    expect(view.drawPile.peek!.face).toEqual(face(nextUp, 'dark'))
    expect(view.drawPile.peek!.face).not.toEqual(face(nextUp, 'light'))

    // And nothing below the top card is visible at all: a count, and that is it.
    expect(view.drawPile.count).toBe(g.state.drawPile.length)
    const secondFromTop = g.state.drawPile[g.state.drawPile.length - 2]!
    expect(JSON.stringify(view)).not.toContain(keyOf(g.state, secondFromTop))
  })
})

describe('the view leaks nothing', () => {
  // The whole defence rests on this: the client is never given a deck id, so it cannot look the
  // card up in `deck.ts` (which is public, on GitHub) and read off the other face.
  it('carries opaque aliases, never deck ids', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(3), p2: [], p3: [] })

    const json = JSON.stringify(viewFor(g.state, 'p0'))

    for (const id of [...g.hand('p0'), ...g.hand('p1'), g.topId]) {
      expect(json, `view leaked the deck id "${id}"`).not.toContain(`"${id}"`)
      expect(json).toContain(keyOf(g.state, id))
    }
  })

  it('the alias round-trips, so the server can act on what the client sends', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(1), p2: [], p3: [] })

    const card = g.hand('p0')[0]!
    expect(cardIdForKey(g.state, keyOf(g.state, card))).toBe(card)
    expect(cardIdForKey(g.state, 'not-a-key')).toBeNull()
  })

  it('does not include the draw pile’s order', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: d.filler(3), p1: d.filler(1), p2: [], p3: [] })

    const view = viewFor(g.state, 'p0')
    expect(view).not.toHaveProperty('drawPile.cards')
    expect(Object.keys(view.drawPile).sort()).toEqual(['count', 'peek'])
  })
})

describe('legalPlays', () => {
  it('lists exactly the cards you may play, as aliases', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const playable = d.face('light', 'blue 7')
    const alsoPlayable = d.face('light', 'red 4')
    const not = d.face('light', 'red 7')
    const wild = d.face('light', 'wild')

    const g = rigged(top, { p0: [playable, alsoPlayable, not, wild], p1: d.filler(1), p2: [], p3: [] })
    const view = viewFor(g.state, 'p0')

    expect(view.legalPlays.sort()).toEqual(
      [playable, alsoPlayable, wild].map(id => keyOf(g.state, id)).sort(),
    )
    expect(view.legalPlays).not.toContain(keyOf(g.state, not))
  })

  it('is empty when it is not your turn', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), {
      p0: [d.face('light', 'blue 7')],
      p1: [d.face('light', 'blue 8')],
      p2: [],
      p3: [],
    })
    expect(viewFor(g.state, 'p1').legalPlays).toEqual([])
  })

  it('after drawing, only the drawn card is legal', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const held = d.face('light', 'blue 7')
    const drawn = d.face('light', 'blue 9')

    const g = rigged(top, { p0: [held], p1: d.filler(1), p2: [], p3: [] })
    g.stackDraw(drawn)
    g.do({ type: 'draw', player: 'p0' })

    const view = viewFor(g.state, 'p0')
    expect(view.legalPlays).toEqual([keyOf(g.state, drawn)])
    expect(view.phase).toEqual({ t: 'awaitingDrawnCardChoice', card: keyOf(g.state, drawn) })
  })
})

describe('event redaction', () => {
  it('a draw names the cards only for the player who drew them', () => {
    const d = new Deal()
    const g = rigged(d.face('light', 'blue 4'), { p0: [d.face('light', 'red 7')], p1: d.filler(1), p2: [], p3: [] })

    const events = g.do({ type: 'draw', player: 'p0' })
    const drawn = events.find(e => e.t === 'cardsDrawn')!

    const toDrawer = redactEvent(g.state, drawn, 'p0')
    const toOthers = redactEvent(g.state, drawn, 'p1')

    expect(toDrawer).toMatchObject({ t: 'cardsDrawn', count: 1 })
    expect((toDrawer as { cards: string[] }).cards).toHaveLength(1)

    expect(toOthers).toMatchObject({ t: 'cardsDrawn', count: 1 })
    expect((toOthers as { cards: string[] }).cards).toEqual([]) // they get the count, not the card
  })

  // "the challenged player shows their hand to the challenger" — to the challenger, and nobody else.
  it('a challenge reveals the hand to the challenger alone', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const wd2 = d.face('light', 'wildDraw2')

    const g = rigged(top, { p0: [wd2, d.face('light', 'blue 9')], p1: d.filler(2), p2: d.filler(1), p3: [] })
    g.do({ type: 'play', player: 'p0', card: wd2, declaredColor: 'red' })

    const events = g.do({ type: 'challenge', player: 'p1' })
    const challenged = events.find(e => e.t === 'challenged')!

    const toChallenger = redactEvent(g.state, challenged, 'p1') as { revealed: unknown[]; guilty: boolean }
    const toBystander = redactEvent(g.state, challenged, 'p2') as { revealed: unknown[]; guilty: boolean }
    const toAccused = redactEvent(g.state, challenged, 'p0') as { revealed: unknown[] }

    expect(toChallenger.revealed).toHaveLength(1)
    expect(toBystander.revealed).toEqual([])
    expect(toAccused.revealed).toEqual([])

    // But everyone learns the verdict — that is public.
    expect(toChallenger.guilty).toBe(true)
    expect(toBystander.guilty).toBe(true)
  })

  it('a played card is public, with its face attached', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const card = d.face('light', 'blue 7')

    const g = rigged(top, { p0: [card, ...d.filler(1)], p1: d.filler(1), p2: [], p3: [] })
    const events = g.do({ type: 'play', player: 'p0', card })
    const played = events.find(e => e.t === 'cardPlayed')!

    for (const who of ['p0', 'p1', 'p2', 'p3']) {
      const view = redactEvent(g.state, played, who) as { card: string; face: { color: string } }
      expect(view.card).toBe(keyOf(g.state, card))
      expect(faceStr(view.face as never)).toBe('blue 7')
    }
  })
})

describe('the table view (for a screenshare)', () => {
  it('shows every hand’s inactive faces — which are public anyway — and no hand’s active ones', () => {
    const d = new Deal()
    const top = d.face('light', 'blue 4')
    const p0card = d.both('blue 5', 'pink 9')
    const p1card = d.both('blue reverse', 'wild')

    const g = rigged(top, { p0: [p0card], p1: [p1card], p2: [], p3: [] })
    const table = tableView(g.state)
    const json = JSON.stringify(table)

    expect(faceStr(table.players[0]!.visible[0]!.face)).toBe('pink 9')
    expect(faceStr(table.players[1]!.visible[0]!.face)).toBe('wild')

    // A projector must not leak anyone's actual hand — this is the whole reason `tableView` is not
    // just `viewFor(someSpectator)`.
    expect(json).not.toContain('blue 5')
    expect(json).not.toContain('reverse')
    expect(table).not.toHaveProperty('hand')
  })
})
