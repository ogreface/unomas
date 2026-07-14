# UNO FLIP! — Authoritative Rules Spec

**Primary source:** Mattel official instruction sheet, item **GDR44**, ©2018 Mattel —
https://service.mattel.com/instruction_sheets/GDR44-English.pdf

Where secondary sources contradict Mattel, Mattel wins. Ambiguities are listed in §6 — those
are ours to decide, and each becomes an explicit, documented, testable engine decision.

Players: 2–10.

---

## 1. Deck composition — 112 cards

Each physical card is double-sided. Both sides independently total 112.

### Light Side (white border)

| Category | Count | Detail |
|---|---|---|
| Blue / Green / Red / Yellow numbers | 18 each (72) | 1–9, **two of each**, per color |
| Draw One | 8 | 2 per color |
| Reverse | 8 | 2 per color |
| Skip | 8 | 2 per color |
| Flip | 8 | 2 per color |
| Wild | 4 | — |
| Wild Draw Two | 4 | — |
| **Total** | **112** | 72 number + 32 colored action + 8 wild |

### Dark Side (black border)

| Category | Count | Detail |
|---|---|---|
| Pink / Teal / Orange / Purple numbers | 18 each (72) | 1–9, **two of each**, per color |
| Draw Five | 8 | 2 per color |
| Reverse | 8 | 2 per color |
| Skip Everyone | 8 | 2 per color |
| Flip | 8 | 2 per color |
| Wild | 4 | — |
| Wild Draw Color | 4 | — |
| **Total** | **112** | 72 number + 32 colored action + 8 wild |

Per color: 18 + 2 + 2 + 2 + 2 = 26; 26 × 4 = 104; + 8 wilds = 112. ✅

### ⚠️ There is NO zero card

Mattel: *"18 Blue cards - 1 to 9"* for every color, both sides. 18 = 2 × 9 → two each of 1–9,
no 0. (Base UNO *does* have a 0: *"19 Blue Cards – 0 to 9"*.)

### ⚠️ The widely-repeated "76 number / 28 action / 8 wild" figure is WRONG

The correct breakdown is **72 / 32 / 8**. Do not use the 76/28 numbers found on many sites.

---

## 2. The Light↔Dark face pairing — ✅ RESOLVED

> **Status: we have the real table.** Transcribed from a physical deck and encoded in
> [`packages/engine/src/data/deck.ts`](../../packages/engine/src/data/deck.ts), where a validator
> asserts the composition at module load.
>
> It reconciles **exactly** against Mattel's published per-category counts — 72 numbers / 32
> colored actions / 8 wilds on *both* sides, 112 total — which is strong evidence the transcription
> is complete and correct.
>
> **Two facts the sources could not tell us, now settled:**
> 1. **The pairing is NOT type-preserving.** `blue reverse / wild`, `red skip / orange draw5`,
>    `yellow reverse / teal flip`. The 1:1 correspondence of per-category counts across sides is a
>    coincidence of the totals, not a structural property.
> 2. **No card is a wild on both sides.** The 8 cards bearing a light wild face and the 8 bearing a
>    dark wild face are **disjoint sets**. A light Wild's dark back is an ordinary coloured card
>    (`wild draw2 / orange 4`); a dark Wild's light front is an ordinary coloured card
>    (`blue reverse / wild`).
>
> Gameplay consequence, given we model the information channel: **holding a light Wild reveals
> nothing to you about it — but your opponents can see it's an orange 4 waiting to happen.** And a
> card that looks like a boring `blue reverse` to you is a Wild the whole table can see coming.

Each physical card has one Light face and one Dark face. The deck embodies a **fixed bijection**
between the 112 Light faces and the 112 Dark faces.

Mattel has never published the mapping, and no card-by-card manifest exists anywhere in the public
record — hence the transcription above.

**This is load-bearing for three reasons:**

1. **It is an information channel.** Setup step 3: *"Hold the cards with the Light Side facing you
   and the Dark Side facing your opponents."* While playing the Light side, **your opponents can
   see the Dark faces of every card in your hand, and you cannot.** This is a deliberate,
   inverted-information mechanic that almost no digital implementation models.
2. **It determines hands after a Flip.** Re-rolling the pairing on each Flip would break the game
   and destroy the channel above.
3. **It affects scoring.** Held cards are scored at their **currently face-up** values.

**Implementation:** Card = `{ id, lightFace, darkFace }`. Build the bijection once at deck
construction and persist it. Never derive one face from the other at runtime.

**Structural hint (inference, not fact):** per-category counts correspond 1:1 across sides
(8 Draw One ↔ 8 Draw Five, 4 Wild ↔ 4 Wild, 72 numbers ↔ 72 numbers, etc.). This is *consistent*
with a type-preserving pairing but is **not proof** — any bijection preserves the totals.

---

## 3. Turn & play rules

### Setup
1. All cards oriented the same way.
2. Dealer determination: each player draws a card, reveals the Light Side; highest number deals
   (symbol cards count as zero).
3. Deal **7 cards** each. Hold with Light Side facing you, Dark Side facing opponents.
4. Remainder becomes the DRAW pile, **Light Side facedown**.
5. Turn the top card over to begin the DISCARD pile (Light Side up).

**The game always starts on the Light Side.** Player to the dealer's left starts.

### Legal play
*"you must match a card from your hand to the card on the top of the DISCARD pile, either by
number, color or symbol."*

**Critical restriction**, repeated on every colored action card: *"may only be played on a
matching color or on another [same-type] card."* Symbol matching is **type-for-type only** — you
cannot play a Skip on a Reverse. Wilds are always playable.

One card per turn.

### Drawing
- No match → draw one from the DRAW pile.
- A drawn card **may** be played immediately if playable (optional). Otherwise turn passes.
- **Optional draw is legal:** you may decline to play a playable card, but then you must draw, and
  you may only play *that drawn card* — no other card from your hand.

### Draw pile exhaustion
Reshuffle the discard pile into a new draw pile. (The Spanish text is more precise: **leave the
top card**, reshuffle the rest.) Use the Spanish reading.

### "UNO" call
Play your next-to-last card → yell UNO. If not, and you are **caught before the next player begins
their turn**, draw **two** cards.

### Round end
Round ends when a player has no cards. If the last card played was a Draw One / Draw Five / Wild
Draw Two / Wild Draw Color, the next player **must still draw** — and **those cards count toward
the winner's score.**

---

## 4. Action cards — exact effects

### Light Side

| Card | Effect | As opening discard |
|---|---|---|
| **Draw One** | Next player draws 1, misses turn. | Same rule applies. |
| **Reverse** | Direction reverses. | Dealer goes first, play moves right. |
| **Skip** | Next player loses turn. | Player left of dealer is skipped. |
| **Wild** | Choose the color (may re-choose current). Playable any time. | Player left of dealer chooses color. |
| **Wild Draw Two** | Choose color + next player draws 2 and loses turn. **Only playable when you hold no other card matching the discard's COLOR** (number/action matches are fine). | Return to deck, draw another. |
| **Flip** | See below. | ⚠️ **NOT SPECIFIED** — see §6. |

### Dark Side

| Card | Effect |
|---|---|
| **Draw Five** | Next player draws 5, misses turn. |
| **Reverse** | Direction reverses. |
| **Skip Everyone** | *All* players are skipped. **Play returns to whoever played the card** → they take another turn. |
| **Wild** | Choose the color. Playable any time. |
| **Wild Draw Color** | Next player **draws until they get a color of your choosing** (however many it takes) and loses their turn. Same color restriction as Wild Draw Two. |
| **Flip** | See below. |

### 🔴 The Flip card — exact mechanic

Verbatim: *"when you play this card, everything flips from the Light Side to the Dark Side. Once
the Flip card has been played, **flip over the Discard Pile (the card just played will now be on
the bottom)**, then the Draw Pile, then everyone's hands must flip to the other side."*

Order: **Discard pile → Draw pile → all hands.**

**The counterintuitive consequence:** "flip over the Discard Pile" means inverting the *entire
stack*. The stack order **reverses** and every card shows its opposite face. The Flip card you just
played, being on top, ends up on the **bottom**. Therefore:

> **The new active card is the DARK face of the card that was at the BOTTOM of the discard pile**
> — i.e. the *first* card discarded since the last reshuffle. **Not** the dark face of the Flip
> card you played.

This is unambiguous in the rules text and is the single most-misimplemented rule in UNO Flip. It
means:
- The discard pile must be a **full ordered list** of double-sided cards, not a "top card" pointer.
- Each Flip **inverts** that list.
- A reshuffle collapses the discard pile to one card, resetting what the next Flip will expose.

### Challenge rule — YES, on both wild-draw cards

**Wild Draw Two:** challenge → challenged player shows their hand to the challenger. **Guilty** →
they draw 2 instead of you. **Innocent** → you draw 2 + 2 more (4 total).

**Wild Draw Color:** **Guilty** → they draw-to-color instead of you. **Innocent** → you draw to
color **plus 2 more**.

There is **no Wild Draw Four** in UNO Flip.

### Two-player rules

**GDR44 contains NO two-player section at all.** Reverse's behavior with 2 players is never
addressed. Modern base-UNO sheets also omit it. "Reverse acts as Skip with 2 players" is
legacy folklore, **not current official Mattel text**. A literal reading makes Reverse a **no-op**
with 2 players.

### Stacking — NOT OFFICIAL

Stacking draw cards is a **house rule**. Nothing in GDR44 permits it, and Mattel's official account
publicly confirmed in May 2019 that you cannot stack. **Ship stacking OFF by default**; offer it as
an explicit house-rule toggle.

---

## 5. Scoring

Round winner scores the value of all cards left in opponents' hands, valued on **the side the game
ended on**.

| Card | Points |
|---|---|
| Numbers (1–9) | Face value |
| Draw One (light) | 10 |
| Draw Five (dark) | 20 |
| Reverse (either side) | 20 |
| Skip (light) | 20 |
| Skip Everyone (dark) | 30 |
| Flip (either side) | 20 |
| Wild (either side) | 40 |
| Wild Draw Two (light) | 50 |
| Wild Draw Color (dark) | 60 |

> *"REMEMBER TO SCORE POINTS BASED ON WHICH SIDE (LIGHT OR DARK) THE GAME ENDED ON."*

**Winning:** first to **500 points**.
**Alternative (also official):** tally points held each round; when someone hits 500, the player
with the *lowest* total wins.

---

## 6. Ambiguities — engine must make a documented judgment call

Each of these gets an entry in the ruleset config, a documented default, and a test.

| # | Issue | Notes |
|---|---|---|
| 1 | ~~**Light↔Dark pairing table unpublished**~~ | ✅ **RESOLVED** — see §2. We have the real deck, transcribed and validated. No longer a judgment call. |
| 2 | **Flip as the opening discard card** | GDR44 gives opening rules for every other card but is **silent on Flip**. Safest: treat like Wild Draw Two — return to deck, draw another. |
| 3 | **Flip exposes a Wild** | If the discard pile's bottom card's other face is a Wild, there is **no active color**. Unaddressed by Mattel. Now precisely bounded: **exactly 8 cards can do this** — `c031 blue reverse`, `c085 red skip`, `c087 yellow 1`, `c109 yellow reverse` (→ Wild) and `c045 green 6`, `c055 green flip`, `c065 red 3`, `c097 yellow 6` (→ Wild Draw Color). Options: carry over last declared color / the player who flipped picks / next player picks. |
| 4 | **Flip exposes an action card** | Does a *revealed* (not played) Draw Five take effect? Silent. Recommend: **no** — it only sets active color/symbol. |
| 5 | **Does Flip really invert the whole pile?** | Rules-accurate answer: **yes**. Many implementations silently simplify. Decide explicitly. |
| 6 | **Two-player Reverse** | Literal = no-op. Convention = acts as Skip. Most players expect Skip. |
| 7 | **Enforcing the Wild-Draw color restriction** | Hard-block illegal plays (kills the challenge minigame) vs allow + challenge (rules-accurate). |
| 8 | **Sub-ambiguities in that restriction** | Does "matches the COLOR" mean the *declared* color when the top card is a Wild? (Presumably yes.) Does holding another Wild count as a match? (Presumably no.) Neither is stated. |
| 9 | 🔴 **Wild Draw Color non-termination** | "Draw until you get color X" has **no termination guarantee** — if every card of that color is in players' hands, this loops forever. **Must implement a hard cap.** Real infinite-loop hazard. |
| 10 | **Draw pile exhausted with ≤1 discard card** | Nothing to reshuffle. Undefined. Reachable after a big Wild-Draw-Color draw. |
| 11 | **Reshuffle resets the discard pile's bottom card** | Which changes what the next Flip exposes. Mattel almost certainly never considered this interaction. |
| 12 | **UNO-call timing window** | No "catching" in a digital game. Define the window explicitly (UNO button + callout button open until the next play resolves). |
| 13 | **Challenge visibility** | Rules say the hand is shown **to the challenger only**. Reveal to everyone? For how long? |
| 14 | **Skip Everyone with 2 players** | Degenerates to Skip (play returns to you). Consistent, but needs a test. |
| 15 | **Reverse as opening card with 2 players** | Degenerate; interacts with #6. |
| 16 | **The opponent-visible-dark-face channel** | Physically mandated by setup. Almost no digital game models it. Dropping it drops a real mechanic; including it is a differentiator. |

**The two nastiest:** #2 (Flip-as-opening-card) and #9 (Wild Draw Color non-termination). Both will
crash or hang a naive engine.

---

## Sources

| Source | URL | Status |
|---|---|---|
| Mattel GDR44 (UNO Flip) | https://service.mattel.com/instruction_sheets/GDR44-English.pdf | ✅ Authoritative |
| Mattel W2085 (base UNO), for comparison | https://service.mattel.com/instruction_sheets/W2085-UNO.pdf | ✅ Authoritative |
| unorules.com | https://www.unorules.com/uno-flip-rules/ | ⚠️ Deck composition unreliable |
| UltraBoardGames | https://www.ultraboardgames.com/uno/flip-game-rules.php | ⚠️ Unofficial, consistent |
| Wikipedia (UNO) | https://en.wikipedia.org/wiki/Uno_(card_game) | ⚠️ Good on stacking + 2-player history |
| Mattel anti-stacking statement (press) | https://www.today.com/popculture/uno-s-twitter-announces-move-illegal-people-are-arms-t153640 | ✅ Reflects official position |
