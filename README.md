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

## Stack

React + DOM + CSS on Cloudflare Workers, with one Durable Object per game room. Cards are generated
SVG, so a theme is a block of CSS variables and a custom card is just data. Later, user rule packs
run in a QuickJS sandbox — the same engine on the server and in the browser, so a local preview has
identical semantics to the authoritative game.

## Docs

- **[docs/plan.md](docs/plan.md)** — the implementation plan and staging
- [docs/decisions.md](docs/decisions.md) — the ruling on each rules ambiguity (source of truth)
- [docs/research/rules-spec.md](docs/research/rules-spec.md) — the authoritative rules, sourced from
  Mattel's instruction sheet, plus every ambiguity it leaves open
- [docs/research/stack-decisions.md](docs/research/stack-decisions.md) — stack choices, with the
  reasoning and the mobile gotchas

## Status

Stage 0 (the rules engine) is complete and green: the pure reducer, all action cards including the
full-pile Flip inversion, challenges, UNO call/callout, scoring, and view redaction with both
information channels — official Uno Flip shipping as the first rule pack. 123 tests pass;
`tsc`, `vitest`, and `eslint` are all clean. Next up is Stage 1 (the network + UI MVP:
`packages/protocol`, the `GameRoom` Durable Object, and the client).
