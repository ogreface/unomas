# Rulings — the source of truth

UNO FLIP!'s official instruction sheet (Mattel GDR44) leaves a number of situations genuinely
undefined. A faithful digital engine has to make a call on each one, and — because those calls are
the difference between "the game everyone remembers" and "a game that happens to share a deck" —
each one is a documented, tested, and *configurable* decision rather than a silent assumption.

This file is the source of truth for those rulings. It is the prose companion to two things in code:

- **[`packages/engine/src/types.ts`](../packages/engine/src/types.ts)** — the `RuleOptions`
  interface and `DEFAULT_OPTIONS`. Every ruling below that is a runtime toggle is a field there.
- **[`packages/engine/src/packs/unoflip/index.ts`](../packages/engine/src/packs/unoflip/index.ts)** —
  the official rule pack, which reads those options and encodes the rulings that aren't toggles
  (opening-card policy, degenerate two-player cases).

The ambiguity numbers (**#1–#16**) match §6 of
[`research/rules-spec.md`](research/rules-spec.md). The decision tags (**D2–D14**) are the anchors
used in code comments — grep `Dn` in `packages/engine/src` to jump to the implementation of any
ruling. **#17** and **#18** are the two entries Mattel could not have left ambiguous, because
neither can happen around a table: a player who simply stops playing, and a player who is no longer
there at all.

Every row has a test. If you change a default here, a test in `packages/engine/test` should change
with it.

---

## Defaults at a glance

From `DEFAULT_OPTIONS` in [`types.ts`](../packages/engine/src/types.ts):

| Option | Default | Ambiguity |
|---|---|---|
| `twoPlayerReverseActsAsSkip` | `true` | #6 / D6 |
| `flipInvertsDiscardPile` | `true` | #5 / D5 |
| `flipExposedActionCardTakesEffect` | `false` | #4 / D4 |
| `enforceWildDrawColorRestriction` | `false` | #7 / D7 |
| `challengesEnabled` | `true` | #7 / D7 |
| `drawUntilColorCap` | `112` | #9 / D9 |
| `unoPenaltyCards` | `2` | #12 / D12 |
| `falseCalloutPenaltyCards` | `0` | #12 (Mattel silent) |
| `stackingEnabled` | `false` | not official |
| `scoreLimit` | `500` | official |
| `handSize` | `7` | official |
| `turnTimeoutMs` | `30_000` | #17 / D17 — online only |
| `dropAfterTimeouts` | `3` | #18 / D18 — online only |

Rulings that are **structural** (not a toggle) — opening-card policy, who picks the colour after a
Flip, the degenerate two-player cases, the challenge visibility rule, the dark-face information
channel — live in the pack and the reducer, and are documented in the rows below.

---

## The rulings

### #1 — Light↔dark face pairing · ✅ RESOLVED, no longer a judgment call

The pairing table Mattel has never published. **We transcribed the real 112-card deck from a
physical copy** and encoded it in
[`packages/engine/src/data/deck.ts`](../packages/engine/src/data/deck.ts). A validator asserts the
official per-side counts (72 number / 32 action / 8 wild on each side) at module load. The pairing
is **not** type-preserving, and **no card is a wild on both faces** — which is what bounds #3.

- **Ruling:** use the real deck. This is data, not a decision.
- **Tested:** `test/deck.test.ts` (counts, bijection, load-time validation).

### #2 — Flip as the opening discard card · D2

GDR44 gives an opening rule for every card *except* Flip.

- **Ruling:** **return it to the deck, reshuffle, and turn another** — Mattel's own escape hatch for
  Wild Draw Two, extended to Flip. Encoded as `openingPolicy(face) → { t: 'redraw' }`.
- **Why:** applying a Flip to an empty pile is undefined, and "redraw the opener" is the pattern
  Mattel already established for the one opening card they *did* find too disruptive to keep.
- **Code:** `openingPolicy` in [`packs/unoflip/index.ts`](../packages/engine/src/packs/unoflip/index.ts); opener rejection in [`reduce.ts`](../packages/engine/src/reduce.ts).
- **Tested:** `test/setup.test.ts`, `test/play.test.ts`.

### #3 — A Flip exposes a Wild (no active colour) · D3

When the newly-active face (the *other* face of what was the pile's bottom card) is itself a wild,
there is no active colour. Exactly **8 of the 112 cards** can trigger this — it is not a rare
theoretical case.

- **Ruling:** **the player who played the Flip chooses the colour.** The reducer opens an
  `awaitingColorChoice` phase for the flipper before play continues.
- **Why:** the flip was that player's move; giving them the choice mirrors how declaring a colour
  works everywhere else in the game.
- **Code:** `awaitingColorChoice` phase in [`reduce.ts`](../packages/engine/src/reduce.ts); flip resolution in [`effects.ts`](../packages/engine/src/effects.ts).
- **Tested:** `test/flip.test.ts` — *"a Flip that exposes a wild (D3)"*.

### #4 — A Flip exposes an action card · D4 · `flipExposedActionCardTakesEffect`

If the newly-active face is an action card (say Draw Five), does that action *fire*?

- **Ruling (default `false`):** **no effect.** A revealed card was not *played*; it only sets the
  active colour/symbol.
- **Why:** the action cards fire when someone plays them onto the pile. A Flip reveals a face; it
  doesn't play it. Firing it would double-apply the card that's about to be played on top of it.
- **Tested:** `test/flip.test.ts` — *"a Flip that exposes an action card (D4)"*.

### #5 — Does Flip invert the *whole* pile? · D5 · `flipInvertsDiscardPile`

The load-bearing rule, and the one most digital versions quietly drop.

- **Ruling (default `true`):** **yes.** Playing a Flip reverses the entire discard-pile stack, so
  the Flip card you just played lands on the *bottom* and the new active card is the **other face of
  the card that was at the bottom** of the pile — exactly per GDR44 ("flip over the Discard Pile").
- **How it's implemented:** `discardPile` is an ordered array (`index 0 = bottom`, `last = top`).
  A Flip is literally `discardPile.reverse()` + `side = other(side)`. No special-casing — the rule
  falls out of the data model.
- **Risk:** this genuinely confuses first-time players (see plan's risk table). The UI carries that
  burden by animating the inversion and calling out the new active card; this toggle exists as the
  house-rule escape valve if playtesting rejects it.
- **Tested:** `test/flip.test.ts` — *"inverts the whole pile, not just the top card (D5)"* and the
  exposes-the-BOTTOM-card test.

### #6 — Two-player Reverse · D6 · `twoPlayerReverseActsAsSkip`

Mattel is silent. Literal reading = no-op; universal player expectation = acts as Skip.

- **Ruling (default `true`):** **acts as Skip.** With two players a Reverse returns the turn to the
  player who played it.
- **Why:** there is no "accurate" answer — Mattel says nothing — so we follow what every table
  already does.
- **Tested:** `test/actions.test.ts` — *"Reverse"*.

### #7 — Enforcing the Wild-Draw colour restriction · D7 · `enforceWildDrawColorRestriction` + `challengesEnabled`

The rule that a Wild Draw card may only be played when you hold no card of the current colour.

- **Ruling (default: `enforceWildDrawColorRestriction: false`, `challengesEnabled: true`):**
  **do not hard-block the play** — allow it, and let the **challenge** decide. This is the
  rules-accurate behaviour and it preserves the challenge minigame.
- **Why:** hard-blocking illegal plays deletes the challenge — the whole bluff mechanic — from the
  game. The physical game polices this socially via the challenge, not by preventing the play.
- **Alternate:** set `enforceWildDrawColorRestriction: true` to block the illegal play outright
  (kills the challenge for that card). Set `challengesEnabled: false` to resolve wild-draws
  immediately with no challenge window.
- **Code:** `isPlayable` note in [`packs/unoflip/index.ts`](../packages/engine/src/packs/unoflip/index.ts); challenge flow in [`reduce.ts`](../packages/engine/src/reduce.ts).
- **Tested:** `test/challenge.test.ts` — including *"enforceWildDrawColorRestriction: true (D7, the
  other way)"* and *"challengesEnabled: false"*.

### #8 — Sub-ambiguities inside that restriction · D8

Two unstated details of "you have no card that matches the colour":

- **Does "the colour" mean the *declared* colour when the top card is itself a Wild?** — **Yes.**
  The active colour is the declared one.
- **Does holding another Wild count as a matching card?** — **No.** A Wild in hand has no colour, so
  it never counts as a colour match, so it never makes a Wild Draw play illegal.
- **Code:** the matching logic and its D8 comment in [`reduce.ts`](../packages/engine/src/reduce.ts).
- **Tested:** `test/challenge.test.ts`.

### #9 — Wild Draw Color non-termination · D9 · `drawUntilColorCap` · 🔴 hazard

"Draw until you get colour X" has no termination guarantee: if every card of X is in players' hands,
a naive engine loops forever.

- **Ruling:** **the real guarantee is deck exhaustion** — draw-until-colour stops when the draw pile
  and reshuffleable discard are both spent (see #10). `drawUntilColorCap` (default `112`) is a
  structural belt-and-suspenders backstop, not the primary mechanism.
- **Why:** this is a genuine infinite-loop / DoS hazard, doubly so once packs run in a sandbox with a
  CPU limit — a hang takes the whole room down. It gets a hard structural bound.
- **Code:** the draw-until-colour loop in [`effects.ts`](../packages/engine/src/effects.ts) (D9);
  exhaustion path in [`reduce.ts`](../packages/engine/src/reduce.ts) (D10).
- **Tested:** `test/challenge.test.ts` (Wild Draw Color), `test/actions.test.ts`.

### #10 — Draw pile exhausted with ≤1 discard card · D10

After a large Wild-Draw-Color draw, the draw pile can empty with nothing (or only the single active
card) left in the discard to reshuffle.

- **Ruling:** when there is nothing to reshuffle, the piles are **genuinely exhausted** — the reshuffle
  helper returns false and the turn ends rather than looping or crashing.
- **Code:** the reshuffle helper in [`effects.ts`](../packages/engine/src/effects.ts) (D10); the
  turn-ends path in [`reduce.ts`](../packages/engine/src/reduce.ts) (D10).
- **Tested:** `test/challenge.test.ts` (exhaustion during draw-until-colour).

### #11 — Reshuffle resets the discard pile's bottom card · D11

Reshuffling the discard back into the draw pile changes which card sits at the bottom of the pile —
and therefore what the *next* Flip will expose. Mattel almost certainly never considered this
interaction.

- **Ruling:** **accepted consequence, not special-cased.** The reshuffle rebuilds the pile normally;
  the Flip target legitimately changes. There is no coherent alternative that keeps both mechanics
  intact.
- **Code:** the reshuffle helper's D11 note in [`effects.ts`](../packages/engine/src/effects.ts).

### #12 — UNO-call timing window · D12 · `unoPenaltyCards`, `falseCalloutPenaltyCards`

A digital game has no physical "catching," so the window has to be defined explicitly.

- **Ruling:** an explicit **UNO button**, plus a **callout window that stays open until the next
  player's action resolves.** A player caught at one card with no UNO call draws `unoPenaltyCards`
  (default **2**). Calling out a player who *did* say UNO costs `falseCalloutPenaltyCards` (default
  **0** — Mattel is silent on a false-callout penalty).
- **Code:** the UNO/callout window in [`reduce.ts`](../packages/engine/src/reduce.ts) (D12).
- **Tested:** `test/uno.test.ts` — *"the UNO call"* and *"the callout"*.

### #13 — Challenge visibility · D13

The rules say a challenged hand is shown "to the challenger only."

- **Ruling:** on a challenge, the accused's hand is revealed **to the challenger and to nobody
  else**; **everyone learns the verdict** (guilty / not). Redaction is enforced in the view layer,
  per-recipient, so the reveal never leaks into other players' views.
- **Code:** event redaction in [`view.ts`](../packages/engine/src/view.ts) — the `challenged`
  event carries `revealed` only for the challenger.
- **Tested:** `test/view.test.ts` — *"event redaction"*.

### #14 — Skip Everyone with two players · D14

Skip Everyone (dark side) with only two players skips the opponent and returns play to you.

- **Ruling:** **degenerates to a plain Skip** — the correct, consistent behaviour, no special case
  needed.
- **Code:** the Skip-Everyone effect and its D14 note in
  [`effects.ts`](../packages/engine/src/effects.ts); pack note in
  [`packs/unoflip/index.ts`](../packages/engine/src/packs/unoflip/index.ts).
- **Tested:** `test/actions.test.ts` — *"Skip Everyone (dark)"*.

### #15 — Reverse as opening card with two players

A degenerate case that interacts with #6.

- **Ruling:** falls out of the #6 ruling (two-player Reverse acts as Skip) combined with the normal
  opening-card handling — no independent special case.
- **Tested:** covered by the two-player action tests in `test/actions.test.ts` and setup tests.

### #16 — The opponent-visible dark-face information channel

Physically mandated by setup: you hold your hand light-side toward you, so **opponents see your
dark faces and you don't**, and the draw pile's top card shows its dark face to the whole table.
Almost no digital implementation models this.

- **Ruling:** **included, on by default.** It is a real, differentiating mechanic. In `view.ts`, for
  a player P: P sees the **active** face of their own hand and the **inactive** face of every
  opponent's hand; the draw pile is redacted below its top card, whose dark face is public.
- **Risk:** it doubles the information on screen and needs real UI design (likely a peek/toggle
  rather than always-on clutter — see the plan's risk table). The *engine* models it faithfully; the
  *UI* decides how to surface it.
- **Code:** redaction in [`view.ts`](../packages/engine/src/view.ts).
- **Tested:** `test/view.test.ts` — *"the information channel"* and *"the view leaks nothing"*.

### #17 — A player who stops playing · D17 · `turnTimeoutMs`

Not a rules ambiguity: a physical game has no such state, because the person holding everybody up is
sitting right there. Online they are not — their phone died, the call dropped, they went to answer
the door — and without a ruling the table simply stops, permanently, with no legal move anyone else
can make.

- **Ruling:** every outstanding decision is on a **30-second clock**, and when it runs out the game
  forfeits *that one decision* on the player's behalf. Configurable per room via `turnTimeoutMs`;
  `0` switches the clock off entirely, for a group who would rather wait.
- **What a forfeit does** — always the option that cannot be better than what the player would have
  chosen, so that dropping off the call is never an advantage:

  | Waiting on | The clock does | Why |
  |---|---|---|
  | a play | draws one card, then declines to play it | the physical game's "you snooze, you draw"; it never picks a card *for* them, because picking the card is the game |
  | the drawn-card choice | passes | the same, one step in |
  | a colour choice | takes the side's first colour | a real decision we cannot make well for them, but a fixed one replays identically, cannot be gamed by an opponent, and beats hanging the table |
  | a challenge | takes the cards | a challenge they did not ask for can cost them two more cards if the accused is innocent |

- **Whose clock it is:** whoever the phase says owes a decision — which is not always the player at
  the turn. A colour choice or a challenge is owed by somebody else while the turn sits still. With
  one exception: **a computer player is never on the clock.** Its seat is driven (#2.1 in the plan),
  so the alarm that matters there is the one that makes its move; forfeiting it would narrate a
  player who has wandered off while the room was about to play for them anyway.
- **Visible to everyone.** The countdown is on the top bar, on the tile of the player it is about,
  and large on the projected table view. A timeout is narrated in the feed like any other event, so
  nobody has to guess why the cards moved.
- **Where it lives:** the *duration* is a rule option and the *forfeit* is a rule
  ([`reduce.ts`](../packages/engine/src/reduce.ts)'s `doTimeout`, plus `playerToAct` in
  [`clock.ts`](../packages/engine/src/clock.ts)), but the **clock itself is the Durable Object's**
  ([`room.ts`](../apps/game/src/worker/room.ts)) — a storage alarm, never a `setTimeout`, because the
  engine may not read the time of day and a timer in memory would both defeat hibernation and die
  with the first quiet moment in a game. Alarm delivery is at-least-once, so the handler is
  idempotent: a duplicate finds a clock that no longer matches the phase it was armed for.
- **It shares that alarm with the bot driver,** because a Durable Object only gets one. The room
  arms it for whichever errand is due first and the handler works out what is actually due on
  arrival rather than trusting why it was set — so a wake meant for a bot can find a deadline
  expired, and the other way round, and neither loses its turn.
- **Tested:** `packages/engine/test/timeout.test.ts` (what a forfeit costs) and
  `apps/game/test/timeout.test.ts` (the alarm: eviction mid-turn, duplicate delivery, early wake,
  reconnect, the countdown reaching every screen, and the two errands sharing the one alarm slot).

### #18 — A player who is no longer there · D18 · `dropAfterTimeouts`

#17 keeps the table moving past a player who has stopped deciding, one forfeited turn at a time. It
does not answer what happens when they are never coming back: left alone, the table waits out a full
clock for that seat on every lap, from here to 500 points.

- **Ruling:** a player who has gone is **dropped from the game**, for good. Two things count as
  gone:
  - **They closed the tab.** All the room sees of that is a closed connection — and it sees exactly
    the same thing for a reload, a phone in a dead spot, and a deploy, which cuts every socket in the
    room at once. So the seat is **held for 10 seconds** after a player's *last* connection closes,
    and they are dropped only if they have not reconnected by then — which is also what forgives a
    tab closed by accident: open it again inside the ten seconds and nothing has happened. A second
    tab or a second device still open means they have not left at all; the projected table view is
    nobody's seat.
  - **The clock ran out on them `dropAfterTimeouts` times in a row** (default **3**; `0` never drops
    anyone). *In a row* is the point: three slow turns over an evening are three slow turns, but
    three with nothing in between is an empty chair. Anything the player does themselves — a play, a
    draw, an UNO call — wipes the count. The third strike *is* the drop: no card is drawn for it.
- **What a drop does** — what would happen if somebody got up from a real table:

  | | |
  |---|---|
  | Their seat | stays where it is, empty. They keep their name and score on the board, and every other seat keeps its number — the turn simply passes over them |
  | Their hand | is shuffled into the **draw** pile. Shuffled, because the table has seen the back of every card in it; the draw pile, because the discard pile's order is what the next Flip turns over (#5) and nobody played these |
  | The rules that count players | count the players still in: three who lose one are a two-player game, and a Reverse is a Skip from that moment (#6) |
  | One player left | wins the **game**. No round is scored for it — nobody went out |

- **If the game was waiting on them**, it is settled without them, in whichever way costs the people
  still sitting there the least:

  | They owed | What happens | Why |
  |---|---|---|
  | a play, or the drawn-card choice | the turn passes; nothing is drawn | the cards are going back in the deck anyway |
  | a colour choice | the side's first colour, as the clock would have picked (#17) | play cannot continue without one |
  | a challenge decision (they were the target of a wild draw) | nobody draws; the play stands and the turn moves past them | there is nobody to draw — and if that wild draw was the accused's last card, they have won the round |
  | — and if it was *their* wild draw awaiting an answer | **the draw is void**; its target takes an ordinary turn | their hand has gone back in the deck, so nobody can ever show whether it was a bluff. Letting the draw stand takes the challenge away from its target; letting them challenge finds an empty hand and calls it innocent |

- **It is final for that game.** A dropped player who comes back gets their own seat's view — the
  board, an empty hand, and a plain statement of why — so they can watch, but nothing they send is
  accepted (`not_in_game`) and the next deal does not include them. Letting them back in for the
  next round is a reasonable house rule and is not built.
- **Before the deal** there is no game to be dropped from, only a seat to give back: after the same
  10 seconds the player comes off the roster and the gap closes, so the host does not deal a hand to
  an empty chair.
- **The host.** Between rounds the whole table waits on the host to deal, so the job cannot leave
  with them: it passes to the longest-seated person still in the game, and every screen is told.
- **Computer players** are never dropped (they have no connection to lose and are never on the
  clock), and they stop when the last *person* has gone. To the rules two bots are a perfectly good
  game; left to it they would play on to 500 for an audience of nobody.
- **Where it lives:** the same split as #17. *That* a player is gone is the Durable Object's call
  ([`room.ts`](../apps/game/src/worker/room.ts) — the `absences` table, sharing the room's one alarm
  with the turn clock and the bot driver); *what that does* is a rule
  ([`reduce.ts`](../packages/engine/src/reduce.ts)'s `dropPlayer`, and `seatAfter` /
  `nextSeatInPlay` in [`effects.ts`](../packages/engine/src/effects.ts)). The strike count is engine
  state, so a replay of the action log drops the same player at the same moment.
- **Tested:** `packages/engine/test/drop.test.ts` (every case in the tables above, plus five-player
  games that lose two players mid-flight and still finish with every card accounted for),
  `apps/game/test/presence.test.ts` (the grace period: reload, eviction, early and duplicate alarms,
  two tabs, the host handing over, the lobby), and a Playwright test in which a real browser closes
  a real tab.

---

## Non-ambiguity options (plain config knobs)

These aren't Mattel ambiguities — they're just the official numbers, exposed so a house game can
change them:

| Option | Default | Meaning |
|---|---|---|
| `scoreLimit` | `500` | First to this many points wins the game. |
| `handSize` | `7` | Cards dealt to each player at the start of a round. |
| `turnTimeoutMs` | `30000` | How long a player has per decision before the clock forfeits it for them (#17 / D17). `0` switches the clock off. |
| `dropAfterTimeouts` | `3` | How many decisions in a row the clock may forfeit before the player is dropped from the game (#18 / D18). `0` never drops anyone. |
| `stackingEnabled` | `false` | Stacking Draw cards. **Confirmed NOT official** (Mattel, May 2019); off by default, available as a house rule. Tested in `test/actions.test.ts` — *"stacking is off by default"*. |
