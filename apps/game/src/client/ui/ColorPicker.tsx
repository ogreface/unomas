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
        {colorsFor(side).map(color => (
          <button
            key={color}
            className="swatch"
            style={{ background: `var(--c-${color})` }}
            aria-label={color}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
    </div>
  )
}
