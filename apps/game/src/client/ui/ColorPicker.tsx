import { colorsFor } from '@flipside/engine'
import type { Color, Side } from '@flipside/engine'

/** The four colours legal on the current side, as big tap targets. */
export function ColorPicker({
  side,
  onPick,
  title = 'Choose a colour',
}: {
  side: Side
  onPick: (color: Color) => void
  title?: string
}) {
  return (
    <div className="color-picker" role="group" aria-label={title}>
      <div className="color-picker__title">{title}</div>
      <div className="color-picker__row">
        {/* Each swatch is the ink over the body — the same two tones the card itself uses, so a
            dark-side swatch reads as the deep card it will produce, not a flat neon square. */}
        {colorsFor(side).map(color => (
          <button
            key={color}
            className="swatch"
            style={{ background: `linear-gradient(155deg, var(--ink-${color}), var(--c-${color}))` }}
            aria-label={color}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
    </div>
  )
}
