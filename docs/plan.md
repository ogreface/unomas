# Implementation Plan

**Name: Flipside.** (Cannot be "UNO" — Mattel trademark. See [Naming](#naming).)

Supporting research: [`research/rules-spec.md`](research/rules-spec.md) ·
[`research/stack-decisions.md`](research/stack-decisions.md)

---

## The bet

**Build the customization engine first; ship official Uno Flip as its first rule pack.**

The MVP's rules live in a *bundled, trusted rule pack* that uses exactly the interface a user's
custom pack will later use. Stage 3 becomes "accept a user's pack and sandbox it," not "rewrite the
game."

Five constraints make this work. Each is cheap now and brutally expensive to retrofit:

1. The engine is a **pure synchronous reducer** — `(state, action) → { state, events }`. No I/O, no
   clock, no `Math.random`. Enforced by ESLint `no-restricted-globals` from commit one.
2. **The seeded RNG's state lives inside `GameState`.** An RNG seeded outside the state is not
   replayable.
3. **All state is JSON-plain.** No `Map`, `Set`, class instances, `undefined`, or `Symbol`. It must
   cross a sandbox boundary by serialization later.
4. **Every rule decision routes through one call site** — the `RuleHost` interface, async at the DO
   boundary, sync inside. Stage 1 calls in-process; Stage 3 swaps in QuickJS and *nothing else in
   the codebase changes*.
5. **Rule hooks return effect *data*, never mutations**, and receive a frozen, redacted view. The
   `Effect` union is the security boundary — designed as a closed, versioned type now.

---

## Repository structure

```
/
├─ pnpm-workspace.yaml
├─ docs/
│  ├─ plan.md                  # this file
│  ├─ decisions.md             # the ruling on each ambiguity (source of truth)
│  └─ research/
├─ packages/
│  ├─ engine/                  # pure TS. ZERO dependencies. The heart.
│  │  ├─ src/
│  │  │  ├─ types.ts           # GameState, Action, Event, Effect, Card, Face
│  │  │  ├─ rng.ts             # seeded PRNG; state is JSON-plain
│  │  │  ├─ deck.ts            # 112-card construction + light↔dark bijection
│  │  │  ├─ reduce.ts          # the pure reducer
│  │  │  ├─ effects.ts         # Effect union + trusted applier
│  │  │  ├─ view.ts            # redaction: GameState → PlayerView
│  │  │  ├─ score.ts
│  │  │  ├─ rulepack.ts        # RulePack + RuleHost interfaces
│  │  │  └─ packs/unoflip/     # ← the official rules, as a rule pack
│  │  └─ test/
│  └─ protocol/                # wire types, zod schemas, shared client↔server
└─ apps/
   └─ game/
      ├─ wrangler.jsonc
      ├─ vite.config.ts        # @cloudflare/vite-plugin
      └─ src/
         ├─ client/            # React SPA
         └─ worker/            # Worker entry + GameRoom Durable Object
```

`packages/engine` having **zero dependencies** is a hard rule. It is the thing that must one day run
inside a QuickJS sandbox.

---

## Core data model

### Cards

```ts
type Side  = 'light' | 'dark'
type Color = 'red'|'yellow'|'green'|'blue' | 'pink'|'teal'|'orange'|'purple'
type Kind  = 'number'|'draw'|'skip'|'skipAll'|'reverse'|'flip'|'wild'|'wildDraw'

interface Face { color: Color | null; kind: Kind; value?: number }  // color null ⇒ wild
interface Card { id: CardId; light: Face; dark: Face }              // the fixed bijection
```

### The discard pile is an ordered stack — and Flip is `reverse()`

This is the crux of the whole engine, and it falls out beautifully:

```ts
discardPile: CardId[]   // index 0 = BOTTOM of the pile, last element = TOP
activeFace = card(discardPile.at(-1))[state.side]
```

Playing a Flip card:

```ts
state.discardPile.reverse()      // Mattel: "flip over the Discard Pile"
state.side = other(state.side)
```

The Flip card you just played was the last element (top) → after `reverse()` it is index 0
(bottom). The card that *was* at the bottom is now last → it is the new top, and we read its
**other** face. That is precisely Mattel's rule, with no special-casing.

Hands and the draw pile flip for free: they're arrays of `CardId`, and `state.side` decides which
face of each card is live.

### The information channels

Both are real mechanics in the physical game, and both are **on by default** (your call):

- **Hands:** you hold cards light-side-toward-you, so **opponents see your dark faces and you
  don't.** In `view.ts`: for player P, P sees the **active** side of their own hand and the
  **inactive** side of every opponent's hand. That single asymmetry *is* the mechanic.
- **Draw pile:** setup places it light-side-*down*, so **the top card's dark face is visible to
  everyone.** While playing light, the whole table can see the dark face of the next card to be
  drawn.

Redaction therefore hides: your own cards' inactive faces, opponents' active faces, and the draw
pile below the top card.

### RNG

Splitmix64 held as two uint32s (JSON-safe, exact). `state.rng` advances *as part of the reduction*,
so a replay of the action log reproduces the game bit-for-bit.

---

## Stage 0 — Engine + rules (no network, no UI)

The game is won or lost here, and it is fully testable headless.

| # | Work | Done when |
|---|---|---|
| 0.1 | Monorepo scaffold, TS strict, vitest, ESLint no-clock/no-random rule | `pnpm test` runs green on an empty suite |
| 0.2 | ✅ **`deck.ts` — the real 112-card deck, done.** Plus `types.ts`, `rng.ts` | Deck transcribed from a physical copy; validator asserts 72/32/8 per side at module load and passes |
| 0.3 | Reducer core: turn order, legal-play matching, draw, pass | 2-player game of number cards only can be played to completion |
| 0.4 | Action cards, **incl. the Flip pile-inversion** | Golden replay tests; a Flip mid-game exposes the *bottom* card's other face |
| 0.5 | Challenges, UNO call + callout, scoring, round/game end at 500 | Full 4-player round completes and scores correctly on both sides |
| 0.6 | `RuleOptions` + all 17 ambiguities decided, documented, tested | `docs/decisions.md` complete; one test per row |
| 0.7 | `view.ts` redaction + both information channels | Test: P cannot see own dark faces; P *can* see opponents' dark faces |

**Invariant test that runs after every action:** all 112 cards are accounted for across
hands + drawPile + discardPile, with no duplicates. This one test catches most engine bugs.

### The rulings (defaults; each is a `RuleOptions` flag)

Full list and reasoning in `docs/decisions.md`. The load-bearing ones:

| Ambiguity | Ruling |
|---|---|
| ~~**Light↔dark pairing**~~ | ✅ **No longer a decision.** We have the **real deck**, transcribed from a physical copy and encoded in `packages/engine/src/data/deck.ts`. It reconciles exactly against Mattel's published counts. The pairing is **not type-preserving**, and **no card is a wild on both sides**. |
| **Flip inverts whole pile** | **Yes** — rules-accurate. UI animates the inversion and calls out the new active card. |
| **Flip as opening card** | Return to deck, draw another (Mattel's own pattern for Wild Draw Two). |
| **Flip exposes a Wild** (no active color) | The player who played the Flip chooses the color. Now precisely bounded: **exactly 8 of the 112 cards can trigger this.** |
| **Flip exposes an action card** | **No effect.** It was revealed, not played; it only sets the active color/symbol. |
| **Wild-draw legality** | **Not blocked.** Allow the play; implement the challenge (reveal to challenger only, broadcast the *outcome* to all). |
| **Wild Draw Color termination** | 🔴 Hard cap. Draw-until-color stops if draw+discard are exhausted. Genuine infinite-loop hazard. |
| **Two-player Reverse** | Acts as Skip. Mattel is *silent*, so there is no "accurate" answer; this is universal player expectation. |
| **Stacking** | **Off.** Confirmed not official. House-rule toggle. |
| **UNO window** | Explicit UNO button; callout window open until the next player's action resolves. |

---

## Stage 1 — MVP: five people finish a real game

**Done = five people on a Zoom call finish a real game of Uno Flip on their phones.**

| # | Work | Notes |
|---|---|---|
| 1.1 | `packages/protocol` — zod wire schemas | C→S: join, start, play, draw, callUno, callout, challenge. S→C: welcome, sync, events, error |
| 1.2 | `GameRoom` Durable Object | SQLite: `room`, `players`, `actions` (append-only log), `snapshot`. Hibernation API. |
| 1.3 | Worker entry + static assets + `@cloudflare/vite-plugin` | Single Worker: SPA + `/api/*` + `/ws/*` |
| 1.4 | Client connection layer, `partysocket` for reconnect | **Every deploy disconnects every player.** Resync is not optional polish. |
| 1.5 | Lobby: create room → code → join by nickname | `idFromName(hmac(code))`; real join check inside the DO |
| 1.6 | Board UI: `<Card>`, hand, piles, players, color picker | Parametric SVG cards; overlapping-cascade hand |
| 1.7 | **Table view** (`/r/:code/table`) — read-only, for screenshare | Big discard pile, turn order, hand counts, event feed |
| 1.8 | Event → animation pipeline | Server sends `Event[]`; client plays them as a queue |
| 1.9 | Playwright multi-client e2e; deploy | Two browser contexts play a real game |

### Durable Object shape

```
Worker fetch
 ├─ /api/room          → create room, return code
 ├─ /ws/:code          → upgrade, route to DO via idFromName(hmac(code))
 └─ /*                 → static assets (SPA)

GameRoom (one DO per room, SQLite-backed)
 ├─ acceptWebSocket() + serializeAttachment({ playerId, seat })   // ≤16 KiB, no game state
 ├─ webSocketMessage() → validate → ruleHost.reduce() → append to log → snapshot → broadcast
 ├─ ctx.storage.setAlarm()   ← turn timers & room GC.  NEVER setTimeout.
 └─ setWebSocketAutoResponse()  ← ping/pong without waking the object
```

**Non-negotiables** (each is a documented Cloudflare footgun):
- Game state is **never** cached in a class field — the constructor re-runs after hibernation.
- Turn timers use **alarms**, never `setTimeout`, which silently defeats hibernation and blows up
  the cost model.
- Alarm handlers are **idempotent** (at-least-once delivery).
- Reconnect protocol from day one: client sends last-seen sequence number; server replays snapshot +
  events since.

### Testing

`@cloudflare/vitest-pool-workers`, including **`evictDurableObject()`** — we explicitly test that a
game in progress survives eviction between two moves. That is otherwise the #1 source of
production-only bugs.

---

## Stage 2 — Feel

Turn timers · sound · spectators · reconnection grace · house-rule toggles (stacking, 7-0,
draw-to-match, jump-in) · AI fill-in for empty seats · animation polish · full a11y pass
(every card is a `<button>`; the whole game is keyboard- and screen-reader-playable).

---

## Stage 3 — Customization

**Ship the data-driven card spec before the sandbox.** A JSON card definition —

```jsonc
{ "match": { "color": "any" },
  "effects": [ { "type": "draw", "n": 3, "target": "allOthers" },
               { "type": "reverse" } ] }
```

— covers ~90% of what people actually want ("a card that makes everyone draw 3 and reverses") with
**zero sandbox risk**. Code hooks are for the long tail.

| # | Work |
|---|---|
| 3.1 | `CardDef` JSON spec + validator; custom cards playable with no code |
| 3.2 | Rule-pack format: deck composition, options, win condition |
| 3.3 | `QuickJSRuleHost` — the whole reducer runs in-sandbox; one boundary crossing per action |
| 3.4 | In-browser editor with **live preview** — same QuickJS engine, so identical semantics to the server |
| 3.5 | Pack sharing (a pack is just a document; a room references one) |

**Why QuickJS over Cloudflare's Dynamic Workers:** Dynamic Workers is faster and more hardened, but
it is *server-only*. A browser preview would then run different semantics than the authoritative
server — exactly the bug class we cannot afford. QuickJS is the only option that runs the **same
engine on both sides**. `DynamicWorkerRuleHost` stays behind the same interface as a swap-in.

**Sandbox ≠ determinism.** We separately delete `Math.random`, `Date.now`, and
`crypto.getRandomValues` from the guest, inject `ctx.rng()` from the in-state PRNG, and bound
execution with `setInterruptHandler()` — because blowing the DO's 30s CPU limit takes the **whole
room** down, not just the offending pack.

---

## Explicitly not doing

- **boardgame.io.** `npm install` today gives you November 2022 code; its server is Koa + socket.io,
  which *cannot run on Workers*; and its rules are code-known-at-build-time — the opposite of the
  runtime-interpreted sandboxed rules we need. We steal its two good ideas (server-side view
  redaction, one reducer shared by client and server) and write the ~400 lines ourselves.
- **Canvas / WebGL.** Costs accessibility, text rendering, and responsive layout — precisely the
  brief. Board Game Arena runs the world's largest board-game platform on DOM.
- **Motion / Framer Motion.** 42.5 kB, and its ergonomic syntax is *not* hardware-accelerated
  (compiles to CSS variables). Plain CSS + WAAPI is smaller *and* faster.
- **Mattel's name or artwork.**

---

## Risks

| Risk | Mitigation |
|---|---|
| 🔴 **The full-pile Flip confuses real players** | It's the official rule and you chose fidelity — so the *UI* carries the burden. Animate the pile inverting; explicitly call out the new active card. If playtesting hates it, the house-rule toggle already exists. |
| 🔴 **Wild Draw Color never terminates** | Hard cap in the engine + a test that constructs the pathological deck. |
| 🟠 **The dark-face channel overwhelms the UI** | It doubles the information on screen. Needs real design: probably a peek/toggle rather than always-on clutter. Prototype early. |
| 🟠 **Every deploy disconnects everyone** | Reconnect + resync is Stage 1 work, not polish. |
| 🟠 **QuickJS + Workers WASM papercut** | Workers forbid dynamic WASM compilation — must import the `.wasm` statically via `newVariant()`. Known, solved, ~1 hour. |
| 🟡 Dynamic Workers is open beta | We're not depending on it. QuickJS is the primary. |

---

## Naming

**Flipside.** Can't be "UNO" — mechanics aren't copyrightable, but the trademark and trade dress
are, so the name, card art, and metadata all have to be our own.
