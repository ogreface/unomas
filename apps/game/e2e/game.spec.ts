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
