import { memo } from 'react'
import type { Color, Face, Kind, Side } from '@flipside/engine'

/**
 * A single card face, drawn as parametric SVG. There is no bitmap anywhere in the game: a card is
 * data (`{ color, kind, value }`), a colour is a CSS variable, and a theme is therefore a block of
 * variables plus this file. That is the whole reason the board is DOM/SVG and not canvas — it keeps
 * the cards responsive, legible, and restyleable.
 */

const WHEEL_LIGHT: Color[] = ['red', 'yellow', 'green', 'blue']
const WHEEL_DARK: Color[] = ['pink', 'teal', 'orange', 'purple']

/** The big central mark for a face. Numbers show their digit; actions show a glyph. */
function glyphFor(kind: Kind, value: number | undefined): string {
  switch (kind) {
    case 'number':
      return String(value ?? '')
    case 'draw1':
      return '+1'
    case 'draw5':
      return '+5'
    case 'skip':
      return '⦸'
    case 'skipEveryone':
      return '⦸'
    case 'reverse':
      return '⇅'
    case 'flip':
      return '⟳'
    case 'wildDraw2':
      return '+2'
    case 'wildDrawColor':
      return '+'
    case 'wild':
      return ''
  }
}

/** A short kicker under some glyphs, so Skip-all and the two wild-draws read unambiguously. */
function kickerFor(kind: Kind): string | null {
  switch (kind) {
    case 'skipEveryone':
      return 'ALL'
    case 'wildDrawColor':
      return 'COLOR'
    case 'flip':
      return 'FLIP'
    default:
      return null
  }
}

export interface CardProps {
  face: Face
  side?: Side
  /** Card width in px; height follows the 2:3 playing-card ratio. */
  width?: number
  selected?: boolean
  playable?: boolean
  dimmed?: boolean
  onClick?: () => void
  ariaLabel?: string
}

function label(face: Face): string {
  const color = face.color ?? 'wild'
  if (face.kind === 'number') return `${color} ${face.value}`
  return `${color} ${face.kind}`
}

export const Card = memo(function Card({
  face,
  side = 'light',
  width = 90,
  selected = false,
  playable = false,
  dimmed = false,
  onClick,
  ariaLabel,
}: CardProps) {
  const height = Math.round(width * 1.5)
  const isWild = face.color === null
  const glyph = glyphFor(face.kind, face.value)
  const kicker = kickerFor(face.kind)
  const fill = isWild ? 'var(--card-wild-bg)' : `var(--c-${face.color})`
  const wheel = side === 'light' ? WHEEL_LIGHT : WHEEL_DARK
  // Dark-side faces get a near-black border; a white one washes out against the darker palette.
  const edge = side === 'dark' ? 'var(--card-edge-dark)' : 'var(--card-edge)'
  // The ink colour for the central mark — the card's own colour, or white on a wild's wheel.
  const ink = isWild ? 'var(--card-ink-onwild)' : `var(--c-${face.color})`
  // Skip / skip-everyone / flip are drawn as vector marks, not glyphs, so they read distinctly:
  // a single ban for skip, a wider double ring for skip-everyone, a turning card for flip.
  const markCy = kicker ? 70 : 76

  const classes = ['card']
  if (selected) classes.push('card--selected')
  if (playable) classes.push('card--playable')
  if (dimmed) classes.push('card--dimmed')
  if (onClick) classes.push('card--interactive')

  const content = (
    <svg viewBox="0 0 100 150" width={width} height={height} role="img" aria-label={ariaLabel ?? label(face)}>
      <rect x="2" y="2" width="96" height="146" rx="12" fill={fill} stroke={edge} strokeWidth="3" />
      {isWild ? (
        <g>
          {/* The four-colour wheel behind the central oval. */}
          <clipPath id={`clip-${face.kind}`}>
            <ellipse cx="50" cy="75" rx="34" ry="52" />
          </clipPath>
          <g clipPath={`url(#clip-${face.kind})`}>
            <rect x="16" y="23" width="34" height="52" fill={`var(--c-${wheel[0]})`} />
            <rect x="50" y="23" width="34" height="52" fill={`var(--c-${wheel[1]})`} />
            <rect x="16" y="75" width="34" height="52" fill={`var(--c-${wheel[2]})`} />
            <rect x="50" y="75" width="34" height="52" fill={`var(--c-${wheel[3]})`} />
          </g>
          <ellipse cx="50" cy="75" rx="34" ry="52" fill="none" stroke="var(--card-oval)" strokeWidth="4" />
        </g>
      ) : (
        <ellipse cx="50" cy="75" rx="34" ry="52" fill="var(--card-oval)" transform="rotate(-20 50 75)" />
      )}

      {face.kind === 'skip' || face.kind === 'skipEveryone' ? (
        <SkipMark cy={markCy} everyone={face.kind === 'skipEveryone'} color={ink} />
      ) : face.kind === 'flip' ? (
        <FlipMark cy={markCy} color={ink} />
      ) : glyph ? (
        <text x="50" y={kicker ? 78 : 84} textAnchor="middle" className="card__glyph" fill={ink}>
          {glyph}
        </text>
      ) : null}
      {kicker && (
        <text x="50" y="102" textAnchor="middle" className="card__kicker" fill={ink}>
          {kicker}
        </text>
      )}

      {/* Corner pips, top-left and (rotated) bottom-right — the at-a-glance read in a fanned hand. */}
      <text x="12" y="24" textAnchor="middle" className="card__pip" fill="var(--card-oval)">
        {cornerFor(face)}
      </text>
      <text x="88" y="138" textAnchor="middle" className="card__pip" fill="var(--card-oval)" transform="rotate(180 88 133)">
        {cornerFor(face)}
      </text>
    </svg>
  )

  if (!onClick) return <span className={classes.join(' ')}>{content}</span>
  return (
    <button type="button" className={classes.join(' ')} onClick={onClick} aria-label={ariaLabel ?? label(face)}>
      {content}
    </button>
  )
})

/**
 * The skip mark: a prohibition ring with a diagonal bar. Skip-everyone (the dark-side card that skips
 * *all* other players) gets a second, wider ring around it — the game's own visual for "bigger skip".
 */
function SkipMark({ cy, everyone, color }: { cy: number; everyone: boolean; color: string }) {
  const r = everyone ? 15 : 22
  const d = r * 0.707 // slash endpoints at 45°, sitting inside the ring
  return (
    <g fill="none" stroke={color} strokeLinecap="round">
      {everyone && <circle cx={50} cy={cy} r={r + 9} strokeWidth={4} opacity={0.55} />}
      <circle cx={50} cy={cy} r={r} strokeWidth={6} />
      <line x1={50 - d} y1={cy - d} x2={50 + d} y2={cy + d} strokeWidth={6} />
    </g>
  )
}

/**
 * The flip mark: a tilted card ringed by a looping arrow, reading as a card turning over rather than
 * the circular spinner it used to share with skip.
 */
function FlipMark({ cy, color }: { cy: number; color: string }) {
  return (
    <g fill="none" stroke={color} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round">
      {/* the card, caught mid-turn */}
      <rect x={41} y={cy - 15} width={18} height={30} rx={3} transform={`rotate(-20 50 ${cy})`} />
      {/* an ellipse of two arcs looping around it, each capped with an arrowhead */}
      <path d={`M26 ${cy} A 26 19 0 0 1 74 ${cy}`} />
      <path d={`M74 ${cy} A 26 19 0 0 1 26 ${cy}`} />
      <path d={`M74 ${cy} l 3 -8 M74 ${cy} l -8 -2`} />
      <path d={`M26 ${cy} l -3 8 M26 ${cy} l 8 2`} />
    </g>
  )
}

/** The tiny corner mark. Keeps numbers as digits and actions as a compact symbol. */
function cornerFor(face: Face): string {
  if (face.kind === 'number') return String(face.value ?? '')
  if (face.color === null) return 'W'
  return glyphFor(face.kind, face.value) || '★'
}
