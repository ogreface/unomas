import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Color, EventView } from '@flipside/engine'
import type { LogBatch } from '@flipside/protocol'
import { describe } from './Feed.js'

const LOG_ID = 'game-log'

/** The button that opens and closes the drawer. It lives in whichever header the screen has. */
export function GameLogToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className="btn btn--ghost btn--tiny log-toggle"
      aria-expanded={open}
      // Only while the drawer is mounted: pointing at an id that is not in the page is worse than
      // pointing at nothing.
      aria-controls={open ? LOG_ID : undefined}
      onClick={onToggle}
    >
      Log
    </button>
  )
}

/**
 * The whole game, as a list you can scroll back through. The toasts in `Feed` narrate a move and
 * fade; this keeps every line of that narration, worded the same way, for the "wait, who skipped
 * me?" moment.
 *
 * Deliberately not modal: there is no backdrop, so on a wide screen a player can leave it open
 * and keep playing beside it. It sticks to the newest line unless you have scrolled up to read.
 *
 * Memoised, and its callers hand it stable props: the board re-renders five times a second while
 * the turn clock runs, and a long game is thousands of lines that need not be rebuilt each time.
 */
export const GameLog = memo(function GameLog({
  log,
  nameOf,
  onClose,
}: {
  log: LogBatch[]
  nameOf: (id: string) => string
  onClose: () => void
}) {
  const entries = useMemo(
    () =>
      log.flatMap(batch =>
        batch.events.flatMap((event, idx) => {
          const text = describe(event, nameOf)
          return text === null ? [] : [{ key: `${batch.seq}:${idx}`, event, text }]
        }),
      ),
    [log, nameOf],
  )

  const listRef = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries.length])

  // Focus moves into the drawer, and back to wherever it was when the drawer closes. Mount and
  // unmount only: the board re-renders on every tick of the turn clock, and this must not run on
  // each of those. (Not `autoFocus`, which would move focus before the opener could be noted.)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside id={LOG_ID} className="log" aria-label="Game log">
      <header className="log__head">
        <h2 className="log__title">Game log</h2>
        <button ref={closeRef} className="btn btn--ghost btn--tiny" aria-label="Close the game log" onClick={onClose}>
          ✕
        </button>
      </header>
      <ol
        ref={listRef}
        className="log__list"
        onScroll={e => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {entries.length === 0 && <li className="log__empty muted">Nothing has happened yet.</li>}
        {entries.map(({ key, event, text }) => {
          const color = colorOf(event)
          return (
            <li key={key} className={`log__entry log__entry--${event.t}`}>
              <span
                className="log__pip"
                style={color ? { background: `var(--ink-${color})` } : undefined}
                aria-hidden="true"
              />
              <span>{text}</span>
            </li>
          )
        })}
      </ol>
    </aside>
  )
})

/**
 * The colour a line is about, if it is about one, for a dot beside it. A wild gets none: the colour
 * it named arrives as its own "chose" line straight after.
 */
function colorOf(event: EventView): Color | null {
  if (event.t === 'cardPlayed') return event.face.color
  if (event.t === 'colorChosen') return event.color
  return null
}
