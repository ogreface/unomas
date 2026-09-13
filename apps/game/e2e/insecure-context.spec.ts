import { test, expect } from '@playwright/test'

/**
 * The bug this guards: a phone reaching a dev server over plain http (`http://192.168.x.x:5173`,
 * which is exactly what the README tells you to do to test with real devices) is not in a *secure
 * context*, so `crypto.randomUUID` is `undefined` there. Minting the client id threw inside the
 * socket's `open` handler, `join` was never sent, and the host's own phone showed a lobby with an
 * empty roster and no Start button — no error, nothing to explain it.
 *
 * Playwright always serves a secure-ish origin, so the absence is simulated the only way that
 * matters: delete the property before any app code runs, and drive the real UI.
 */
test('the host can start a game where crypto.randomUUID is unavailable', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    // `randomUUID` lives on `Crypto.prototype`, not on the `crypto` instance — deleting it from the
    // instance would silently do nothing and the test would pass against the bug.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (Crypto.prototype as any).randomUUID
    if (typeof globalThis.crypto.randomUUID === 'function') throw new Error('randomUUID still present')
  })

  const host = await context.newPage()
  await host.goto('/')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('button', { name: 'Create a room' }).click()

  await expect(host.locator('.room-code')).toBeVisible()
  const code = (await host.locator('.room-code').textContent())?.trim()
  if (!code) throw new Error('no room code appeared')

  // The host is seated and recognised as the host, so the button exists — disabled only because
  // they are still alone. Before the fix this read "Waiting for the host to start…" instead.
  await expect(host.locator('.tag--you')).toBeVisible()
  const start = host.getByRole('button', { name: /Start game|Need \d\+ players/ })
  await expect(start).toBeVisible()
  await expect(start).toBeDisabled()

  const guest = await context.newPage()
  await guest.goto(`/?as=bo`)
  await guest.getByLabel('Your name').fill('Bo')
  await guest.locator('.code-input').fill(code)
  await guest.getByRole('button', { name: 'Join' }).click()

  const startNow = host.getByRole('button', { name: 'Start game' })
  await expect(startNow).toBeEnabled()
  await startNow.click()

  await expect(host.locator('.hand')).toBeVisible()
  await context.close()
})
