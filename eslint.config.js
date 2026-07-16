import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The load-bearing rule in this file is the `packages/engine` block below.
 *
 * The engine must one day run inside a QuickJS sandbox as an untrusted rule pack's host. That
 * means it can have no ambient nondeterminism: no clock, no entropy, no I/O. Every source of
 * randomness comes from the seeded PRNG whose state lives inside `GameState`, and `now` is stamped
 * once by the Durable Object and passed in as part of the action.
 *
 * Catching this at commit one is cheap. Retrofitting it is not.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**', '**/playwright-report/**', '**/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'The engine is a pure reducer. `now` arrives inside the action.' },
        { name: 'setTimeout', message: 'The engine is synchronous and pure.' },
        { name: 'setInterval', message: 'The engine is synchronous and pure.' },
        { name: 'fetch', message: 'The engine performs no I/O.' },
        { name: 'crypto', message: 'Use the seeded PRNG in `state.rng`.' },
        { name: 'performance', message: 'The engine is a pure reducer — no clock.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use `nextInt(state.rng)` — the PRNG state lives inside GameState so replays are exact.' },
        { object: 'Date', property: 'now', message: 'The engine is a pure reducer. `now` arrives inside the action.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'The engine is a pure reducer — no clock.' },
        { selector: "NewExpression[callee.name='Map']", message: 'GameState must be JSON-plain: it crosses a sandbox boundary by serialization. Use arrays/records.' },
        { selector: "NewExpression[callee.name='Set']", message: 'GameState must be JSON-plain: it crosses a sandbox boundary by serialization. Use arrays/records.' },
      ],
    },
  },
  {
    // The deck table and its validator are module-load-time construction, not reduction. They are
    // allowed the collection types the reducer is not, because none of it enters GameState.
    files: ['packages/engine/src/data/**/*.ts', 'packages/engine/**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
)
