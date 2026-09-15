# Flipside

An online, multi-device card game built on the rules of UNO FLIP! — playable from any phone,
tablet, or laptop, designed for people who are already on a call together.

Not affiliated with Mattel. Game *mechanics* aren't copyrightable, but the UNO trademark and card
artwork are — so this ships none of Mattel's name or assets, and all card art is generated.

## Goals

1. **Play from any device.** A web app. No install, no store.
2. **A faithful game.** The official rules, including the parts most digital versions quietly drop.
3. **Custom rules, written in code.** Players can define their own cards, effects, and win
   conditions.

## The bet

Goal 3 shapes goal 2, not the other way around. The rules engine is generic and data-driven from
day one, and **official UNO FLIP is simply its first rule pack** — a bundled, trusted module using
exactly the interface a user's custom pack will later use. Customization then becomes "accept a
user's pack and sandbox it," not "rewrite the game."

## Fidelity

Two rules that most digital implementations get wrong or omit, which this one implements:

- **Flip inverts the entire discard pile.** Per Mattel's instruction sheet, playing a Flip card
  turns the whole pile over — so the card you just played ends up on the *bottom*, and the new
  active card is the other face of the card that was at the **bottom** of the pile. Not the Flip
  card's own back.
- **Your opponents can see your cards' dark faces, and you can't.** You hold your hand light-side
  toward you, so the dark side faces the table. It's a genuine inverted-information mechanic. The
  draw pile has the same property: its top card's dark face is visible to everyone.

The real 112-card light/dark pairing — which Mattel has never published — is transcribed from a
physical deck in [`packages/engine/src/data/deck.ts`](packages/engine/src/data/deck.ts) and
validated against the official card counts at module load.

## Computer players

A bot is an ordinary seat. The rules engine does not know bots exist — to the reducer it is a
`Player` like any other — and every move it makes goes through the same path yours does: build an
action, `reduce`, persist, broadcast.

The part worth knowing is that **`decideBot` takes a `PlayerView`, not `GameState`**: the bot is
handed exactly the redacted view a human at that seat would receive — its own active faces, its
opponents' dark faces, the draw pile's peek, and the legal plays the pack computed. It has no handle
on the hidden state, so it cannot cheat, and that is structural rather than a promise. (It also means
the same function could run in the browser for offline practice, since a `PlayerView` is precisely
what the client already holds.)

It is a house opponent, not an engine. It sheds expensive cards, saves its wilds unless a draw will
land on someone nearly out, stays in the colour it holds most of, declares UNO, catches you when you
forget, and takes a probabilistic view of whether a wild-draw challenge is worth it. `easy` plays a
random legal card, forgets UNO half the time, and never challenges or calls anyone out.

The Durable Object supplies the two things a bot cannot have on its own: a body (a stored **alarm**
that wakes the room when it is the bot's move — never a `setTimeout`, which would defeat hibernation
and not survive eviction) and a memory for its coin-flips, so a bot's decisions replay as exactly as
the deal does. Bots wait a beat before moving, and a longer one before pouncing on a missed UNO —
otherwise no human could reach the button in time.

## Stack

React + DOM + CSS on Cloudflare Workers, with one Durable Object per game room. Cards are generated
SVG, so a theme is a block of CSS variables and a custom card is just data. Later, user rule packs
run in a QuickJS sandbox — the same engine on the server and in the browser, so a local preview has
identical semantics to the authoritative game.

## Running it locally

```bash
pnpm install
pnpm dev            # vite + @cloudflare/vite-plugin: the real Worker + Durable Object in workerd
```

Open `http://localhost:5173`. One player creates a room and shares the 4-letter code; others join
with it. The read-only projector for a shared screen is at `/r/<CODE>/table`.

**Playing on your own.** In the lobby, the host can **Add computer player** (easy or normal). A bot
takes a real seat, so one person plus one bot is a legal two-handed game — and you can equally round
a table of four humans out to five. See [Computer players](#computer-players).

**Testing with several players in one browser.** Two tabs in the same browser share `localStorage`,
so they are the *same* player. To be different players without separate profiles, add an `?as=`
label per tab: open `http://localhost:5173/?as=ann` and `…/?as=bo` in two tabs and they're two
distinct seats. (Production URLs carry no such param and use one stable, seat-reclaiming identity.)
For a true test, run `pnpm --filter @flipside/game dev -- --host` and hit your machine's LAN address
from real phones.

```bash
pnpm -r test                            # engine + protocol + Durable Object tests (DO runs in real workerd)
pnpm --filter @flipside/game test:e2e   # Playwright: browser contexts play a real game
```

## Docs

- **[docs/plan.md](docs/plan.md)** — the implementation plan and staging
- [docs/decisions.md](docs/decisions.md) — the ruling on each rules ambiguity (source of truth)
- [docs/research/rules-spec.md](docs/research/rules-spec.md) — the authoritative rules, sourced from
  Mattel's instruction sheet, plus every ambiguity it leaves open
- [docs/research/stack-decisions.md](docs/research/stack-decisions.md) — stack choices, with the
  reasoning and the mobile gotchas

## Status

**Stage 0 (the rules engine) — complete and green.** The pure reducer, all action cards including
the full-pile Flip inversion, challenges, UNO call/callout, scoring, and view redaction with both
information channels — official Uno Flip shipping as the first rule pack.

**Stage 1 (network + UI MVP) — complete and green.** `packages/protocol` (zod wire schemas; the
client speaks card-key aliases, never deck ids), the `GameRoom` Durable Object (SQLite-backed
append-only log + snapshot, hibernatable WebSockets, reconnect-by-clientId, per-recipient
redaction), the single Worker serving the SPA + `/api` + `/ws`, and the React client: lobby, board
with parametric-SVG cards, the read-only table view for a screenshare, and an event→callout feed.

The Durable Object tests run in real `workerd` and include surviving eviction mid-game; a Playwright
pair play a full round to completion through the actual UI.

**Stage 2 has started with computer players — done and green.** A pure `decideBot(PlayerView, rng)`
policy in the engine, `addBot`/`removeBot` on the wire, and an alarm-driven driver in the
`GameRoom`. Tables of bots play whole games to 500 in the engine tests; a lone human finishes a real
round against one through the actual UI, and a bot takes its turn correctly after the room is evicted
mid-game. **183 unit/integration tests + 4 e2e pass; `tsc`, `vitest`, and `eslint` are all clean.**

Still to come in Stage 2: turn timers, sound, reconnection grace, house-rule toggles, and the full
a11y pass.
