import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * The Durable Object tests run inside real `workerd`, not a mock. `wrangler.configPath` hands the
 * pool the same bindings and SQLite migrations production uses, so `env.GAME_ROOM` is the actual
 * namespace and `evictDurableObject()` can tear down a live room mid-game — the one thing that
 * reproduces the #1 class of production-only Durable Object bugs.
 *
 * (Vitest 4 moved this from `defineWorkersProject` + `test.poolOptions.workers` to the
 * `cloudflareTest()` plugin; see the package's `vitest-v3-to-v4` codemod.)
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      isolatedStorage: true,
      main: './src/worker/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
