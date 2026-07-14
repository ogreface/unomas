# Stack & Architecture Research — verified 2026-07-14

Findings from research into (a) Cloudflare Durable Objects as a realtime game backend,
(b) sandboxing user-written rule code, (c) card-game frontend rendering.

---

## Backend: Cloudflare Workers + Durable Objects

**One Durable Object per game room, WebSocket Hibernation API.** Cloudflare's own
["Rules of Durable Objects"](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
names *multiplayer games* as the canonical use case.

### Hibernation gotchas (all load-bearing)

| Gotcha | Consequence |
|---|---|
| In-memory state is lost on hibernation; the constructor re-runs on wake | Never cache game state in a class field. Load from SQLite. |
| Only `serializeAttachment()` survives (max 16 KiB/socket) | Use for `{playerId, seat, roomId}` only — never game state. |
| `setTimeout`/`setInterval` **prevent hibernation** | Turn timers **must** use `ctx.storage.setAlarm()`. This is the single biggest cost mistake. |
| A code deploy immediately disconnects every WebSocket | Need reconnect + state-resync **on day one**. Every deploy is a mass disconnect. |
| Alarms have at-least-once delivery | Alarm handlers must be **idempotent**. |

Use `setWebSocketAutoResponse()` for ping/pong so heartbeats never wake the object.

### Limits / cost
- 128 MB memory per DO; 30 s CPU per invocation; **32,768** WebSockets per DO (we need 2–10).
- Alarms: one per DO at a time; wake a hibernated DO.
- **Cost for a handful of rooms: the $5/mo Workers Paid floor, and ~$0 above it.** A full game is
  ~200–400 messages. An idle (hibernated) room costs nothing.
- ⚠️ SQLite storage *billing* only started Jan 2026 — pre-2026 "it's free" posts are stale.

### Storage: SQLite-backed DO — not a choice anymore
A [2026-07-09 changelog](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)
restricts **new DO namespaces to the SQLite backend**. Use `new_sqlite_classes` in the migration
(not `new_classes`). There is no KV→SQLite migration path, so starting correctly matters.

Schema: **append-only action log + periodic state snapshot.** The log is what makes replay,
reconnect, spectating, and (critically) debugging user rule packs possible.

### Routing
`env.ROOM.idFromName(roomCode)` is deterministic and global. **Security note:** deterministic means
a guessable room code is a joinable room — use high-entropy codes and/or `idFromName(hmac(code))`,
plus a real join check inside the DO. Don't treat the room code as a capability.

Location hints are honored **only at creation** and can't be changed later.

### Frontend hosting: Workers Static Assets, NOT Pages
Single Worker serving static assets + the fetch handler + the DO, built with
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/) (GA since Apr
2025), which runs the Worker *and DOs* inside real workerd during `vite dev`, with React HMR.
Static asset requests are not billed as Worker requests.

```jsonc
{
  "main": "./src/worker/index.ts",
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/ws/*"]
  },
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "GameRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }]
}
```

### Testing
`@cloudflare/vitest-pool-workers` gives `runInDurableObject()`, `runDurableObjectAlarm()`, and —
[added 2026-06-25](https://developers.cloudflare.com/changelog/post/2026-06-25-durable-object-eviction-test-helpers/) —
**`evictDurableObject()`**. That last one is important: it lets us test that a game in progress
survives hibernation/eviction, otherwise the #1 source of production-only bugs.

### PartyKit / PartyServer: skip the server wrapper, use the client
`partyserver` is maintained but self-describes as WIP and has drifted toward being AI-agent
plumbing. It buys ~60 lines we'd write anyway, at the cost of a WIP dependency in the hot path.
**But use [`partysocket`](https://github.com/cloudflare/partykit) on the client** —
reconnecting-WebSocket-with-backoff is the piece we genuinely don't want to write, and we *will*
need it.

---

## Sandboxing user rule code (Stage 3)

### The two real options

**Cloudflare Dynamic Workers** — [open beta since 2026-03-24](https://developers.cloudflare.com/dynamic-workers/).
Loads arbitrary code into a fresh V8 isolate at runtime with Cloudflare's full hardening stack.
`globalOutbound: null` blocks all network egress; `cpuMs` / `subRequests` per-invocation limits are
a real gas meter. Works from inside a DO. **Still open beta; Paid plan only.**

**QuickJS-WASM** ([`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten), actively
maintained, has a first-party Cloudflare Workers example). Total isolation, `setMemoryLimit()`,
`setInterruptHandler()`, ~1.3 MB bundle (limit is 10 MB gzipped on Paid).

### Recommendation: QuickJS primary, Dynamic Workers as swap-in

The tiebreaker is **browser parity**. QuickJS is the only option that runs the *same engine* on
server and client, so users can preview custom rules locally with identical semantics. Dynamic
Workers is server-only — a browser preview would run different semantics than the authoritative
server, which is exactly the bug class we cannot afford. QuickJS's sync variant also keeps the
reducer a pure sync function.

Keep `DynamicWorkerRuleHost` behind the same interface as a swap-in.

⚠️ **Workers forbid dynamic WASM compilation** — must `import wasm from "./RELEASE_SYNC.wasm"`
statically and build a custom variant via `newVariant()`. Known, solved papercut; budget an hour.

**`isolated-vm` is impossible on Workers** (native N-API addon, Node-only). **Workers for Platforms
is overkill** ($25/mo, designed for deploying customers' whole Workers).

### Determinism — a sandbox gives isolation, NOT determinism

| Hazard | Fix |
|---|---|
| `Math.random()` | Delete it. Inject `ctx.rng()` from a seeded PRNG **whose state lives inside the game state**, so replay reproduces exactly. |
| `Date.now()` / `new Date()` | Delete them. The DO stamps `now` once per action and passes it in. |
| `crypto.getRandomValues()` | Delete it. |
| Iteration order | Use **arrays** for anything ordered. Never depend on `Object.keys()` order. |
| Floats | Integers only in scoring. |
| Infinite loops | **In-sandbox limits, not DO limits.** Blowing the DO's 30s CPU limit takes the whole room down. |
| Mutation of host state | Hooks get a **frozen, deep-cloned, redacted** view and **return effect descriptions (data), never mutations**. |

### Also: ship a data-driven card spec FIRST
A JSON card definition (`{ match: {...}, effects: [{type:"draw", n:2}, {type:"skip"}] }`) covers
~90% of what users actually want ("a card that makes everyone draw 3 and reverses") with **zero
sandbox risk**. Reserve code hooks for the long tail. This isn't the lesser option — it's the
option that lets us ship custom rules *before* we ship a sandbox.

---

## Frontend: React + DOM + CSS. No canvas.

### Verdict on canvas/WebGL: not close
PixiJS/Three/Phaser are all healthy — suitability is the objection, not maintenance. A canvas costs
us: **accessibility (effectively everything)**, text rendering (numerals become a texture-atlas
problem), and **layout** (we'd reimplement responsive reflow by hand — precisely backwards for a
project whose brief is responsiveness across phone/tablet/desktop).

Decisive evidence:
- **Board Game Arena** — the largest online board-game platform in the world — is HTML/CSS DOM.
- **[pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)** recreates 20+
  holographic/foil card effects in **pure CSS**. "Looks premium" and "needs WebGL" are unrelated.

It would be justified above ~500 animated sprites (we have ~60), or for a true 3D physics table.
Neither applies.

### Scale is a non-issue
Realistic ceiling is **60–80 card elements**. Mobile Safari animates that trivially. **The rule:
never render a pile as N DOM nodes** — a 112-card deck is *one* element with a stacked box-shadow
and a count badge.

### Animation: plain CSS + WAAPI. Total dependency cost: 3.3 kB.

Bundle sizes below are **measured** (esbuild → minify → gzip -9, React externalized, 2026-07-14),
not taken from marketing pages. Motion's own docs understate its feature chunks by ~60%.

| Library | Measured min+gzip | Verdict |
|---|---|---|
| **Plain CSS transitions + WAAPI (`element.animate()`)** | **0 B** | ✅ **The answer, and it isn't close.** Covers deal, flip, hover-lift, selection-raise, pile-slide. Guaranteed compositor path. `Element.animate()` is in iOS Safari since 13.4. |
| **`@formkit/auto-animate`** | **3.3 kB** | ✅ **Add this, for one job:** `useAutoAnimate()` on the hand container handles card enter/exit/reorder in one line. WAAPI-backed, respects `prefers-reduced-motion`. Very actively maintained (0.10.0, 2026-07-10). |
| `motion/mini` (vanilla `animate`, WAAPI) | 3.1 kB | Reasonable if we want an ergonomic imperative API. Keeps the compositor path. |
| `gsap` core | 27.6 kB | Now 100% free incl. all plugins (Webflow, Apr 2025) — but **proprietary, not open source**, main-thread rAF, and `@gsap/react` is stale since Jan 2025. Only justified if deal-sequence *choreography* (timelines + stagger) gets genuinely hairy. Reach for it after feeling the pain, not before. |
| `motion/react` (full) | **42.5 kB** | ❌ **Overkill and mildly counterproductive.** 13× the bytes of `motion/mini`, and — per [Motion's own perf docs](https://motion.dev/docs/performance) — the headline `animate={{ rotateY: 180 }}` syntax **"uses CSS variables which are not accelerated"**. It lands us on the main thread *by default*, the exact opposite of what we want on phones. |
| `@react-spring/web` | 18.6 kB | ❌ Spring physics we explicitly don't want. Bus factor ~1. |
| `react-flip-toolkit` | 8.5 kB | ❌ **Last commit 2024-07-06.** Two years dark, no React 19 story. Avoid. |
| View Transitions API | 0 B | ❌ Same-doc VT is finally cross-browser (Chrome 111 / Safari 18 / **Firefox 144**), and `::view-transition-group()` gives FLIP morphing free — **but only one document-scoped transition can run at a time**, making staggered dealing inexpressible. The fix (element-scoped `Element.startViewTransition`) is **Chrome 147 only**. Plus `view-transition-name` must be globally unique across all cards — one collision *silently skips the whole transition*. Revisit ~2028. |
| React 19 `<ViewTransition>` | — | ❌ **Canary/Experimental only — not in React 19.2 stable.** Also: plain `setState` doesn't trigger it. |

FLIP (first-last-invert-play) is ~20 lines with `getBoundingClientRect()` + `element.animate()`.
That's the only genuinely hard animation here, and it does not justify a library.

### 🔴 Card flip: the spec rule that will break you

The classic `preserve-3d` + `backface-visibility: hidden` + `rotateY(180deg)` technique has a
**spec-level footgun** that is the single most common cause of "my card flip works until I do X."

Per [MDN `transform-style`](https://developer.mozilla.org/en-US/docs/Web/CSS/transform-style), the
3D context is **silently flattened** — collapsing your flip — if the element has *any* of:
`overflow` other than visible/clip · **`opacity` < 1** · `filter` other than none · `clip-path` ·
`mask-image` · `mix-blend-mode` · `isolation: isolate` · **`contain: paint`**.

Concretely, all three of these break the flip:
- **Fading a card in while it flips** (`opacity` on the flip container).
- **`overflow: hidden` to clip rounded corners.**
- **`filter: drop-shadow()` for a card shadow.**

Worse: Safari and Chrome historically disagreed on enforcing the opacity rule — so the flip works in
one browser and breaks in the other. And note the trap: the usual "use `contain: paint` to limit
layer count" advice **also flattens the 3D context**.

**Rule: the `preserve-3d` element carries ONLY `transform-style` and `transform`. Nothing else.**
Shadows, opacity, and corner-clipping go on a separate parent or child element.

3D transforms are still regression-prone in 2026 — e.g. [Firefox bug 2034283](https://bugzilla.mozilla.org/show_bug.cgi?id=2034283):
`preserve-3d` stopped preserving in Firefox 150–152 and 3D-transformed elements became **completely
invisible**. Fixed, but indicative. Failure modes here are silent visual corruption, not exceptions.

**Therefore, for the deck-wide Flip, avoid 3D entirely.** UNO Flip's light/dark switch is a *global
state change*, not a physical card rotation. A `scaleX(1) → scaleX(0) → swap content → scaleX(0) →
scaleX(1)` "card-edge" animation reads as a flip, is a pure 2D composited transform, and cannot
z-fight or flatten. Reserve true `rotateY` for at most a single hero moment.

### Card assets: ship ZERO artwork
Game *mechanics* aren't copyrightable — we can implement the rules freely. Mattel owns the **"UNO"
trademark** and the **specific card artwork/trade dress**. So: **don't use the name, don't copy the
card faces.**

Render cards from **data** via a single parametric `<Card>` component → inline SVG + **CSS custom
properties** for colors. This means:
- Infinitely scalable, sharp at any DPR.
- A theme is just a block of CSS variables; `[data-side="dark"]` swaps the whole deck's palette in
  one rule — **UNO Flip's light/dark sides fall out for free.**
- **A user's custom card is just a new `CardDef`.** No asset pipeline, no upload, no CDN. This is
  the strongest argument for generated SVG: it's the only approach where "users define custom
  cards" doesn't become an asset-management project.

**Icons: Lucide (ISC, no attribution required).** Note **game-icons.net is CC BY 3.0 — requires
visible credit** — so it's a poor default despite being the most game-flavoured.
**Fonts: Fredoka or Baloo 2** (SIL OFL), self-hosted and subset to digits.

### Hand layout: overlapping cascade → scroll-snap
The **exposed sliver** of each overlapped card is the tap target and must be **≥44px**. That single
constraint drives the layout.

Fanned arcs are beautiful on desktop but a liability on phone (diagonal hit targets, wasted
vertical space). Use an **overlapping cascade that naturally becomes a horizontal scroller** when
the hand outgrows the screen — no breakpoint, no JS measurement, no mode switch:

```css
.hand {
  --card-w: clamp(64px, 22vmin, 110px);
  --overlap: max(44px, calc(var(--card-w) * 0.55));
  display: flex; overflow-x: auto; scroll-snap-type: x proximity;
  padding-bottom: env(safe-area-inset-bottom);
}
```

**Interaction: tap-to-select → tap-to-play.** Drag-to-play competes with the horizontal scroll
gesture and is error-prone with a thumb. Tap-to-play also gives a free confirmation step before an
irreversible move, and makes each card a real `<button>` — keyboard- and screen-reader-accessible,
which canvas could never be.

### boardgame.io — **do not adopt**
- **`npm install boardgame.io` in July 2026 installs code from November 2022.** Latest npm release
  is 0.50.2 (2022-11-10). There's a revival attempt on `main` but **nothing has shipped**.
- **It cannot run on Workers.** Its server is Koa + **socket.io**, both of which assume a
  long-lived Node process. [socket.io does not run on Cloudflare Workers.](https://github.com/socketio/socket.io/discussions/5019)
- **It fights our roadmap.** Rules are JS move functions in a static game object — *code-shaped,
  known at build time*. We need rules that are **data, interpreted at runtime, sandboxed**. We'd
  end up writing an interpreter inside a single boardgame.io move function, with its phase/stage
  machinery duplicating and conflicting with our control flow.

**Steal its two good ideas** — server-side `playerView` state redaction, and a pure reducer that
runs identically on client (prediction) and server (authority) — and implement them directly. That's
~300–500 lines.

---

## Gotchas to design around

- **`env(safe-area-inset-bottom)` + `viewport-fit=cover`** — or the iOS home indicator eats the
  bottom row of the hand. The #1 visual bug in mobile web card games.
- **Use `100svh`.** `100vh` overflows (largest viewport); `100dvh` re-layouts continuously as the
  toolbar collapses — visibly janky.
- **`will-change` only on the 1–3 cards actually moving**, removed on animation end. 60
  permanently-promoted layers ≈ **120 MB of GPU memory** on a DPR-3 phone — enough to get the tab
  reaped. This, not node count, is what kills mobile.
- **`transform` creates a stacking context.** Keep all cards as direct siblings of one
  *untransformed* container; set `z-index: var(--i)`; raise z-index *before* the transform. Never
  wrap a transformed card in a transformed parent.
- **`contain: paint` / `overflow: hidden` will clip fanned cards** and flatten 3D contexts.
- **`touch-action: manipulation` + `user-select: none` + `-webkit-touch-callout: none`** on every
  card — otherwise long-press pops the iOS selection loupe and double-tap zooms the board.
- **Pointer Events only.** Never mix in touch events.
- **Don't memoize or virtualize 60 cards.** More time spent than the browser spends rendering.
- **Every Cloudflare deploy disconnects every player.** Reconnect/resync is not optional polish.
