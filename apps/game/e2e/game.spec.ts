import { test, expect, type Page } from '@playwright/test'

/**
 * Two browser contexts play a real game of Uno Flip, lobby to a completed round, driving only the
 * actual UI — every click goes through the client, the WebSocket, the Durable Object, the reducer,
 * and back out as a redacted broadcast to both players. It is the one test that proves the whole
 * Stage-1 stack fits together.
 */

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/')
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Create a room' }).click()
  await expect(page.locator('.room-code')).toBeVisible()
  const code = (await page.locator('.room-code').textContent())?.trim()
  if (!code) throw new Error('no room code appeared')
  return code
}

async function joinRoom(page: Page, name: string, code: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Your name').fill(name)
  await page.locator('.code-input').fill(code)
  await page.getByRole('button', { name: 'Join' }).click()
}

/** Do exactly one thing on a page if it can, in priority order. Returns whether it acted. */
async function act(page: Page): Promise<boolean> {
  const swatch = page.locator('.overlay .swatch').first()
  if (await swatch.isVisible().catch(() => false)) {
    await swatch.click()
    return true
  }
  const take = page.getByRole('button', { name: 'Take the cards' })
  if (await take.isVisible().catch(() => false)) {
    await take.click()
    return true
  }
  const playable = page.locator('.hand__slot--playable button').first()
  if (await playable.isVisible().catch(() => false)) {
    await playable.click()
    return true
  }
  const draw = page.locator('.pile__stack--live')
  if (await draw.isVisible().catch(() => false)) {
    await draw.click()
    return true
  }
  const pass = page.getByRole('button', { name: 'Pass', exact: true })
  if (await pass.isVisible().catch(() => false)) {
    await pass.click()
    return true
  }
  return false
}

test('two players finish a real round together', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)

  // Both clients see the full roster before the game starts.
  await expect(a.locator('.roster li')).toHaveCount(2)
  await expect(b.locator('.roster li')).toHaveCount(2)

  // Host starts; both clients land on the board with a dealt hand.
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(a.locator('.board')).toBeVisible()
  await expect(b.locator('.board')).toBeVisible()
  expect(await a.locator('.hand .card').count()).toBeGreaterThanOrEqual(7)

  // The inverted-information channel is visible on screen: each player sees the *other's* cards but
  // renders none of their own in the opponent strip.
  expect(await a.locator('.opponent .mini-card').count()).toBeGreaterThanOrEqual(7)

  // Auto-play first-legal-card until a round completes on either screen.
  let sawEnd = false
  let idleStreak = 0
  for (let i = 0; i < 500 && !sawEnd; i++) {
    const didA = await act(a)
    const didB = await act(b)
    idleStreak = didA || didB ? 0 : idleStreak + 1
    // A round-over overlay showing a winner is our terminal condition (before anyone deals again).
    sawEnd = await a
      .locator('.endgame')
      .isVisible()
      .catch(() => false)
    if (!sawEnd) await a.waitForTimeout(idleStreak > 0 ? 150 : 40)
    if (idleStreak > 40) break // safety valve against an unexpected stuck state
  }

  // The round ended, and both clients agree on the outcome.
  await expect(a.locator('.endgame')).toBeVisible()
  await expect(b.locator('.endgame')).toBeVisible()
  await expect(a.locator('.endgame .scores')).toBeVisible()

  await ctxA.close()
  await ctxB.close()
})

test('two players share one browser via the ?as= testing param', async ({ browser }) => {
  // A single context => shared localStorage. Without `?as` both tabs would collapse to one player;
  // with distinct `?as` labels they are two, which is how you test locally in one browser.
  const ctx = await browser.newContext()
  const a = await ctx.newPage()
  const b = await ctx.newPage()

  await a.goto('/?as=ann')
  await a.getByLabel('Your name').fill('Ann')
  await a.getByRole('button', { name: 'Create a room' }).click()
  await expect(a.locator('.room-code')).toBeVisible()
  const code = (await a.locator('.room-code').textContent())?.trim()
  if (!code) throw new Error('no code')

  await b.goto('/?as=bo')
  await b.getByLabel('Your name').fill('Bo')
  await b.locator('.code-input').fill(code)
  await b.getByRole('button', { name: 'Join' }).click()

  // Two genuinely distinct players in the same browser.
  await expect(a.locator('.roster li')).toHaveCount(2)
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(a.locator('.board')).toBeVisible()
  await expect(b.locator('.board')).toBeVisible()

  await ctx.close()
})

test('the table view projects a live game without leaking a hand', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const table = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  const t = await table.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)
  await expect(a.locator('.roster li')).toHaveCount(2)
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(a.locator('.board')).toBeVisible()

  // The projector shows both players and the piles…
  await t.goto(`/r/${code}/table`)
  await expect(t.locator('.table-player')).toHaveCount(2)
  await expect(t.locator('.table-center .card').first()).toBeVisible()
  // …but never a private hand: the table has no interactive/own-hand region.
  expect(await t.locator('.hand').count()).toBe(0)

  await ctxA.close()
  await ctxB.close()
  await table.close()
})

test('everyone watches the same countdown, and a player who vanishes does not stall the table', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ctxT = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  const t = await ctxT.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)
  await expect(a.locator('.roster li')).toHaveCount(2)
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(a.locator('.board')).toBeVisible()
  await expect(b.locator('.board')).toBeVisible()
  await t.goto(`/r/${code}/table`)

  // The countdown is not private to whoever is on the clock: both players and the projector show it.
  await expect(a.locator('.turn-clock').first()).toBeVisible()
  await expect(b.locator('.turn-clock').first()).toBeVisible()
  await expect(t.locator('.turn-clock').first()).toBeVisible()

  const seconds = async (page: Page): Promise<number> =>
    Number(((await page.locator('.turn-clock__num').first().textContent()) ?? '').trim())

  const startedAt = await seconds(a)
  expect(startedAt).toBeGreaterThan(0)
  expect(startedAt).toBeLessThanOrEqual(30)
  await a.waitForTimeout(2_500)
  expect(await seconds(a)).toBeLessThan(startedAt)

  // Exactly one of the two boards hangs the clock on an *opponent* tile — the player whose turn it
  // is not sees it on the person they are waiting for.
  const onAnOpponent =
    (await a.locator('.opponent .turn-clock').count()) +
    (await b.locator('.opponent .turn-clock').count())
  expect(onAnOpponent).toBe(1)

  // Now nobody touches anything, as though whoever is up has walked away from the call. The server's
  // clock — not either client — forfeits the turn, and the table carries on.
  const turnBefore = (await a.locator('.turn-label').textContent()) ?? ''
  await expect(a.locator('.toast--timedOut')).toBeVisible({ timeout: 45_000 })
  await expect(a.locator('.turn-label')).not.toHaveText(turnBefore)
  await expect(b.locator('.turn-label')).toBeVisible()
  // …and the clock is running again, on the next decision.
  expect(await seconds(a)).toBeGreaterThan(0)

  await ctxA.close()
  await ctxB.close()
  await ctxT.close()
})

/**
 * Records the pitch of every note the page plays, on the browser's real Web Audio — the sounds are
 * synthesized, so a note is an oscillator and its pitch says which cue it belongs to: the turn
 * chime is 659 Hz then 988, the ten-second warning is two beeps at 880, a clock tick is 1800.
 */
function listenToSounds() {
  const heard: number[] = []
  ;(window as unknown as { __heard: number[] }).__heard = heard
  const create = AudioContext.prototype.createOscillator
  AudioContext.prototype.createOscillator = function (this: AudioContext) {
    const osc = create.call(this)
    const set = osc.frequency.setValueAtTime.bind(osc.frequency)
    osc.frequency.setValueAtTime = (value: number, time: number) => {
      heard.push(Math.round(value))
      return set(value, time)
    }
    return osc
  }
}

const TURN_CHIME = [659, 988]
const HURRY = 880
const TICK = 1800

async function heard(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __heard: number[] }).__heard)
}

test('the player on move hears it: a chime as the turn arrives, then the clock running out', async ({
  browser,
}) => {
  // Waits out most of a real 30-second clock, on purpose.
  test.setTimeout(120_000)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  await ctxA.addInitScript(listenToSounds)
  await ctxB.addInitScript(listenToSounds)
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)
  await expect(a.locator('.roster li')).toHaveCount(2)
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(a.locator('.board')).toBeVisible()
  await expect(b.locator('.board')).toBeVisible()

  // Whoever the deal puts on move hears the chime; the other player hears nothing.
  const label = (page: Page) => page.locator('.turn-label').textContent()
  await expect.poll(async () => [await label(a), await label(b)]).toContain('Your turn')
  const [first, second] = (await label(a)) === 'Your turn' ? [a, b] : [b, a]
  await expect.poll(() => heard(first)).toEqual(TURN_CHIME)
  expect(await heard(second)).toEqual([])

  // They take their turn by drawing — always legal — and the chime moves with it.
  const swatch = first.locator('.overlay .swatch').first()
  if (await swatch.isVisible()) await swatch.click() // the deal opened on a wild: name a colour first
  await first.locator('.pile__stack--live').click()
  await expect(first.locator('.pile__stack--live')).toHaveCount(0)
  // A drawn card that can be played holds the turn for a choice; one that cannot passes it at once.
  const pass = first.getByRole('button', { name: 'Pass', exact: true })
  if (await pass.isVisible()) await pass.click()
  await expect(second.locator('.turn-label')).toHaveText('Your turn')
  await expect.poll(() => heard(second)).toEqual(TURN_CHIME)
  expect(await heard(first)).toEqual(TURN_CHIME)

  // Now nobody touches anything. The second player's clock warns them as it turns red, then ticks
  // down the last five seconds — and the first player, who is not on the clock, hears none of it.
  await expect
    .poll(() => heard(second), { timeout: 40_000 })
    .toEqual([...TURN_CHIME, HURRY, HURRY, TICK, TICK, TICK, TICK, TICK])
  expect((await heard(first)).filter(f => f === HURRY || f === TICK)).toEqual([])

  await ctxA.close()
  await ctxB.close()
})

test('a tab closed by accident and reopened inside ten seconds keeps its seat', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)
  await expect(a.locator('.roster li')).toHaveCount(2)
  await a.getByRole('button', { name: /Start game/ }).click()
  await expect(b.locator('.board')).toBeVisible()
  const dealt = await b.locator('.hand__slot').count()
  expect(dealt).toBeGreaterThanOrEqual(7)

  // Bo's tab is gone — and back a moment later, in the same browser, so with the same identity.
  await b.close()
  const reopened = await ctxB.newPage()
  await reopened.goto(`/r/${code}`)
  await expect(reopened.locator('.hand__slot')).toHaveCount(dealt)

  // Wait out the whole dwell time, and then some. Coming back cancelled the hold rather than merely
  // beating it: with two players, a drop here would have ended the game on the spot.
  await a.waitForTimeout(12_000)
  await expect(reopened.locator('.hand__slot')).toHaveCount(dealt)
  await expect(reopened.locator('.out-banner')).toHaveCount(0)
  await expect(a.locator('.toast--playerDropped')).toHaveCount(0)
  await expect(a.locator('.opponent--out')).toHaveCount(0)
  await expect(a.locator('.endgame')).toHaveCount(0)

  await ctxA.close()
  await ctxB.close()
})

test('a player who closes their tab is dropped, and the table plays on without them', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  const c = await ctxC.newPage()

  const code = await createRoom(a, 'Ann')
  await joinRoom(b, 'Bo', code)
  await joinRoom(c, 'Cy', code)
  await expect(a.locator('.roster li')).toHaveCount(3)
  await a.getByRole('button', { name: /Start game/ }).click()
  for (const page of [a, b, c]) await expect(page.locator('.board')).toBeVisible()

  // Cy closes the tab. Nothing is sent to say so: the browser simply lets go of the socket, which
  // is all the server ever sees of somebody leaving. It holds the seat for a few seconds — a reload
  // looks exactly the same — and then gives it up.
  await c.close()

  for (const page of [a, b]) {
    await expect(page.locator('.toast--playerDropped')).toContainText('Cy left the game', { timeout: 30_000 })
    // The seat is still on the board, marked, rather than the table silently rearranging itself.
    await expect(page.locator('.opponent--out')).toContainText('Cy')
    await expect(page.locator('.opponent--out .tag--out')).toHaveText('left')
    await expect(page.locator('.opponent')).toHaveCount(2)
  }
  // Two players are left, so there is still a game.
  await expect(a.locator('.endgame')).toHaveCount(0)
  await expect(a.locator('.turn-label')).not.toContainText('Cy')

  // Cy comes back — same browser, so the same seat — and is told plainly that it is too late. The
  // board is there to watch; the hand is not.
  const back = await ctxC.newPage()
  await back.goto(`/r/${code}`)
  await expect(back.locator('.out-banner')).toContainText('You were away too long')
  await expect(back.locator('.hand')).toHaveCount(0)
  await expect(back.locator('.opponent')).toHaveCount(2)

  // Then Bo goes as well. One player left is not a game, so it is Ann's — and the screen says why,
  // because nobody played a last card.
  await ctxB.close()
  await expect(a.locator('.endgame h2')).toContainText('Ann wins', { timeout: 30_000 })
  await expect(a.locator('.endgame')).toContainText('Everyone else left the game.')
  await expect(a.locator('.scores__out')).toHaveCount(2)

  await ctxA.close()
  await ctxC.close()
})

test('one human plays a real round against a computer player', async ({ page }) => {
  // Nothing drives the computer here: every one of its moves is the room waking itself on a real
  // alarm, after the real 900ms pacing delay. That is the point of this test and also why it is
  // slow — a long round is a couple of minutes of genuine wall clock, so budget generously.
  test.setTimeout(300_000)

  // The solo path: no second browser, no second person. The host seats a bot, which is what makes
  // MIN_PLAYERS reachable alone, and every opponent move below is the Durable Object waking itself
  // on an alarm and playing from the bot's own redacted view.
  await createRoom(page, 'Ann')

  await page.getByRole('button', { name: 'Add computer player' }).click()
  await expect(page.locator('.roster li')).toHaveCount(2)
  await expect(page.locator('.tag--bot')).toBeVisible()

  await page.getByRole('button', { name: /Start game/ }).click()
  await expect(page.locator('.board')).toBeVisible()
  // The board labels the computer, so a pause on its turn reads as thinking rather than as a stall.
  await expect(page.locator('.opponent .tag--bot')).toBeVisible()

  let sawEnd = false
  let idleStreak = 0
  for (let i = 0; i < 500 && !sawEnd; i++) {
    const acted = await act(page)
    idleStreak = acted ? 0 : idleStreak + 1
    sawEnd = await page
      .locator('.endgame')
      .isVisible()
      .catch(() => false)
    // Idle means it is the bot's turn: give the room's alarm time to fire and broadcast.
    if (!sawEnd) await page.waitForTimeout(acted ? 60 : 150)
    if (idleStreak > 60) break
  }

  await expect(page.locator('.endgame')).toBeVisible()
  await expect(page.locator('.endgame .scores')).toBeVisible()
})
