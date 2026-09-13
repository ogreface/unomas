import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * Two projects, because the two halves of this app need genuinely different runtimes.
 *
 * `worker` — the Durable Object tests run inside real `workerd`, not a mock. `wrangler.configPath`
 * hands the pool the same bindings and SQLite migrations production uses, so `env.GAME_ROOM` is the
 * actual namespace and `evictDurableObject()` can tear down a live room mid-game — the one thing
 * that reproduces the #1 class of production-only Durable Object bugs.
 *
 * `client` — plain Node, deliberately *without* browser globals. The client's job is to survive
 * browsers that are missing the APIs it wants (a phone on plain http has no `crypto.randomUUID`;
 * iOS with cookies blocked throws on `localStorage`), and a bare runtime is the honest place to
 * stub each of those absences one at a time.
 *
 * (Vitest 4 moved the worker pool from `defineWorkersProject` + `test.poolOptions.workers` to the
 * `cloudflareTest()` plugin; see the package's `vitest-v3-to-v4` codemod.)
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            isolatedStorage: true,
            main: './src/worker/index.ts',
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'node',
          include: ['src/client/**/*.test.ts'],
        },
      },
    ],
  },
})
