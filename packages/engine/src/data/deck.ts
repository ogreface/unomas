/**
 * The canonical 112-card UNO FLIP! deck.
 *
 * Each physical card has a fixed light face and a fixed dark face. Mattel has never published
 * this bijection; the table below is transcribed from a physical deck.
 *
 * Format: `<light face> / <dark face>`, one card per line, in the order supplied.
 *
 * Light faces:  red|yellow|green|blue <1-9|draw1|skip|reverse|flip>  ·  wild  ·  wildDraw2
 * Dark faces:   pink|teal|orange|purple <1-9|draw5|skipEveryone|reverse|flip>  ·  wild  ·  wildDrawColor
 *
 * There is NO zero card on either side.
 *
 * The composition is asserted at module load by `validateDeck()` — 72 numbers / 32 colored
 * actions / 8 wilds per side, 112 total, every face appearing exactly the expected number of
 * times. If a transcription error creeps in, the module throws rather than dealing a broken deck.
 *
 * NOTE ON THE PAIRING: it is emphatically NOT type-preserving (`blue reverse / wild`,
 * `red skip / orange draw5`). A consequence worth knowing: the 8 cards bearing a LIGHT wild face
 * and the 8 cards bearing a DARK wild face are disjoint sets — no card is a wild on both sides.
 */

const DECK_TABLE = `
wild draw2 / orange 4
wild draw2 / orange 7
wild draw2 / pink 2
wild draw2 / purple 9
wild / pink 5
wild / pink flip
wild / purple 7
wild / teal 3
blue 1 / purple skipEveryone
blue 1 / purple skipEveryone
blue 2 / orange 8
blue 2 / pink 6
blue 3 / purple 8
blue 3 / teal 2
blue 4 / purple 1
blue 4 / teal draw5
blue 5 / orange reverse
blue 5 / pink 9
blue 6 / purple reverse
blue 6 / teal skipEveryone
blue 7 / orange 3
blue 7 / orange skipEveryone
blue 8 / teal 4
blue 8 / teal reverse
blue 9 / orange 5
blue 9 / purple flip
blue draw1 / pink 6
blue draw1 / teal 6
blue flip / purple 6
blue flip / purple 7
blue reverse / orange 4
blue reverse / wild
blue skip / pink 9
blue skip / teal 1
green 1 / orange 5
green 1 / orange flip
green 2 / teal draw5
green 2 / teal skipEveryone
green 3 / pink flip
green 3 / purple 2
green 4 / pink 8
green 4 / teal 9
green 5 / orange 7
green 5 / teal 4
green 6 / pink 5
green 6 / wildDrawColor
green 7 / orange 6
green 7 / teal 2
green 8 / pink reverse
green 8 / teal 9
green 9 / orange draw5
green 9 / pink reverse
green draw1 / orange 6
green draw1 / teal 6
green flip / teal 3
green flip / wildDrawColor
green reverse / orange 1
green reverse / pink 7
green skip / orange 9
green skip / purple 4
red 1 / pink 3
red 1 / purple 2
red 2 / orange reverse
red 2 / purple draw5
red 3 / pink 7
red 3 / wildDrawColor
red 4 / orange flip
red 4 / purple draw5
red 5 / pink 2
red 5 / teal 5
red 6 / orange 9
red 6 / pink skipEveryone
red 7 / orange 1
red 7 / purple 5
red 8 / purple reverse
red 8 / teal 7
red 9 / purple 5
red 9 / teal reverse
red draw1 / pink 3
red draw1 / pink 4
red flip / pink 8
red flip / purple 3
red reverse / purple 3
red reverse / teal 7
red skip / orange draw5
red skip / wild
yellow 1 / pink skipEveryone
yellow 1 / wild
yellow 2 / teal 1
yellow 2 / teal 8
yellow 3 / pink draw5
yellow 3 / purple 1
yellow 4 / pink draw5
yellow 4 / purple flip
yellow 5 / purple 9
yellow 5 / teal 8
yellow 6 / orange skipEveryone
yellow 6 / wildDrawColor
yellow 7 / orange 2
yellow 7 / purple 6
yellow 8 / orange 2
yellow 8 / pink 1
yellow 9 / purple 4
yellow 9 / teal 5
yellow draw1 / pink 1
yellow draw1 / purple 8
yellow flip / orange 8
yellow flip / pink 4
yellow reverse / teal flip
yellow reverse / wild
yellow skip / orange 3
yellow skip / teal flip
`

export type Side = 'light' | 'dark'
export type LightColor = 'red' | 'yellow' | 'green' | 'blue'
export type DarkColor = 'pink' | 'teal' | 'orange' | 'purple'
export type Color = LightColor | DarkColor

/** `color: null` marks a wild — it has no colour until one is declared. */
export type LightKind = 'number' | 'draw1' | 'skip' | 'reverse' | 'flip' | 'wild' | 'wildDraw2'
export type DarkKind =
  | 'number' | 'draw5' | 'skipEveryone' | 'reverse' | 'flip' | 'wild' | 'wildDrawColor'
export type Kind = LightKind | DarkKind

export interface Face {
  color: Color | null
  kind: Kind
  /** Present iff `kind === 'number'`. 1-9; there is no zero. */
  value?: number
}

export type CardId = string

export interface Card {
  id: CardId
  light: Face
  dark: Face
}

const LIGHT_COLORS: readonly string[] = ['red', 'yellow', 'green', 'blue']
const DARK_COLORS: readonly string[] = ['pink', 'teal', 'orange', 'purple']

function parseFace(text: string, side: Side): Face {
  const parts = text.trim().split(/\s+/)

  if (parts[0] === 'wild') {
    // `wild` alone, or `wild draw2` (light) / `wild drawColor` — the table writes the latter
    // two as single tokens, so a bare `wild` here is the plain wild.
    if (parts.length !== 1) throw new Error(`bad wild face: "${text}"`)
    return { color: null, kind: 'wild' }
  }
  if (parts[0] === 'wildDraw2' || parts[0] === 'wildDrawColor') {
    if (parts.length !== 1) throw new Error(`bad wild face: "${text}"`)
    return { color: null, kind: parts[0] as Kind }
  }

  const [color, rest] = parts
  if (parts.length !== 2) throw new Error(`bad face: "${text}"`)

  const legal = side === 'light' ? LIGHT_COLORS : DARK_COLORS
  if (!legal.includes(color)) throw new Error(`"${color}" is not a ${side}-side colour: "${text}"`)

  if (/^[1-9]$/.test(rest)) {
    return { color: color as Color, kind: 'number', value: Number(rest) }
  }

  const kinds: readonly string[] =
    side === 'light'
      ? ['draw1', 'skip', 'reverse', 'flip']
      : ['draw5', 'skipEveryone', 'reverse', 'flip']
  if (!kinds.includes(rest)) throw new Error(`"${rest}" is not a ${side}-side kind: "${text}"`)

  return { color: color as Color, kind: rest as Kind }
}

function parseDeck(): Card[] {
  const lines = DECK_TABLE.trim().split('\n').map(l => l.trim()).filter(Boolean)

  return lines.map((line, i) => {
    const halves = line.split('/')
    if (halves.length !== 2) throw new Error(`line ${i + 1}: expected one "/": "${line}"`)

    // The table writes light wilds as `wild draw2`; normalise to a single token.
    const lightText = halves[0].trim().replace(/^wild draw2$/, 'wildDraw2')

    return {
      id: `c${String(i).padStart(3, '0')}`,
      light: parseFace(lightText, 'light'),
      dark: parseFace(halves[1], 'dark'),
    }
  })
}

const faceKey = (f: Face): string =>
  f.kind === 'number' ? `${f.color} ${f.value}` : f.color ? `${f.color} ${f.kind}` : f.kind

/**
 * Asserts the deck matches Mattel's published composition (instruction sheet GDR44).
 *
 * Per side: 72 number cards (1-9, twice per colour, NO zero), 32 colored action cards
 * (2 of each action per colour), 8 wilds. Total 112.
 *
 * This is the single most important invariant in the codebase: a mistranscribed deck would
 * produce subtly wrong games forever. It runs at module load, not just in tests.
 */
function validateDeck(deck: Card[]): void {
  const fail = (msg: string): never => {
    throw new Error(`deck validation failed: ${msg}`)
  }

  if (deck.length !== 112) fail(`expected 112 cards, got ${deck.length}`)

  for (const [side, colors, actions, wilds] of [
    ['light', LIGHT_COLORS, ['draw1', 'skip', 'reverse', 'flip'], ['wild', 'wildDraw2']],
    ['dark', DARK_COLORS, ['draw5', 'skipEveryone', 'reverse', 'flip'], ['wild', 'wildDrawColor']],
  ] as const) {
    const counts = new Map<string, number>()
    for (const card of deck) {
      const key = faceKey(card[side])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const expect = (key: string, n: number): void => {
      const got = counts.get(key) ?? 0
      if (got !== n) fail(`${side}: expected ${n}× "${key}", found ${got}`)
      counts.delete(key)
    }

    for (const color of colors) {
      for (let v = 1; v <= 9; v++) expect(`${color} ${v}`, 2)
      for (const action of actions) expect(`${color} ${action}`, 2)
    }
    for (const wild of wilds) expect(wild, 4)

    if (counts.size > 0) fail(`${side}: unexpected faces ${[...counts.keys()].join(', ')}`)
  }
}

export const DECK: readonly Card[] = (() => {
  const deck = parseDeck()
  validateDeck(deck)
  return Object.freeze(deck)
})()

export const CARDS_BY_ID: ReadonlyMap<CardId, Card> = new Map(DECK.map(c => [c.id, c]))

/** The face of `card` currently showing, given the side the game is on. */
export const faceOf = (card: Card, side: Side): Face => card[side]
