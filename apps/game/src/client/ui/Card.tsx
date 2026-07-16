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

  const classes = ['card']
  if (selected) classes.push('card--selected')
  if (playable) classes.push('card--playable')
  if (dimmed) classes.push('card--dimmed')
  if (onClick) classes.push('card--interactive')

  const content = (
    <svg viewBox="0 0 100 150" width={width} height={height} role="img" aria-label={ariaLabel ?? label(face)}>
      <rect x="2" y="2" width="96" height="146" rx="12" fill={fill} stroke="var(--card-edge)" strokeWidth="3" />
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

      {glyph && (
        <text
          x="50"
          y={kicker ? 78 : 84}
          textAnchor="middle"
          className="card__glyph"
          fill={isWild ? 'var(--card-ink-onwild)' : `var(--c-${face.color})`}
        >
          {glyph}
        </text>
      )}
      {kicker && (
        <text x="50" y="102" textAnchor="middle" className="card__kicker" fill="var(--card-ink-onwild)">
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

/** The tiny corner mark. Keeps numbers as digits and actions as a compact symbol. */
function cornerFor(face: Face): string {
  if (face.kind === 'number') return String(face.value ?? '')
  if (face.color === null) return 'W'
  return glyphFor(face.kind, face.value) || '★'
}
