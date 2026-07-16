import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end against the *real* local stack: `vite dev` runs the Worker and the `GameRoom` Durable
 * Object inside workerd (via `@cloudflare/vite-plugin`), so these tests exercise the same server the
 * production build ships — WebSockets, hibernation-capable sockets, SQLite persistence and all.
 */
const PORT = 5199

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm exec vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
