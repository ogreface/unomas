import { colorsFor } from '@flipside/engine'
import type { Side } from '@flipside/engine'

/**
 * Which side the table is on. It names the side rather than relying on the cards alone, and carries
 * the four colours that are legal right now as a miniature wheel — so the palette key is always on
 * screen and a flip is visible even to someone who has only glanced up.
 */
export function SideBadge({ side }: { side: Side }) {
  return (
    <span className={`side-badge side-badge--${side}`}>
      {side} side
      <span className="side-badge__wheel" aria-hidden="true">
        {colorsFor(side).map(color => (
          <i key={color} style={{ background: `var(--ink-${color})` }} />
        ))}
      </span>
    </span>
  )
}
