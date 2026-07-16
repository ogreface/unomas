/**
 * Seeded PRNG — splitmix64.
 *
 * Two properties are non-negotiable, and both come from the same place in the plan:
 *
 * 1. **The state is JSON-plain.** It is stored as two uint32 halves of a uint64, so it survives a
 *    `JSON.stringify` round trip through SQLite and, later, a QuickJS sandbox boundary. `bigint`
 *    is used only *inside* these functions, where it gives exact 64-bit arithmetic; it never
 *    escapes into `GameState`.
 *
 * 2. **Every function is pure and returns the next state.** The RNG is threaded through the
 *    reducer rather than mutated in place, because an RNG seeded *outside* the state is not
 *    replayable — and replay is what makes the append-only action log worth having.
 */

/** The uint64 splitmix64 state, split into two uint32s so it stays JSON-plain. */
export interface RngState {
  hi: number
  lo: number
}

const MASK64 = 0xffff_ffff_ffff_ffffn
const GOLDEN = 0x9e37_79b9_7f4a_7c15n

const toBig = (s: RngState): bigint => ((BigInt(s.hi >>> 0) << 32n) | BigInt(s.lo >>> 0)) & MASK64

const toState = (x: bigint): RngState => ({
  hi: Number((x >> 32n) & 0xffff_ffffn),
  lo: Number(x & 0xffff_ffffn),
})

/** FNV-1a over the seed string — deterministic, and independent of platform hashing. */
export function seedRng(seed: string): RngState {
  let h = 0xcbf2_9ce4_8422_2325n
  const prime = 0x0000_0100_0000_01b3n
  for (let i = 0; i < seed.length; i++) {
    h = (h ^ BigInt(seed.charCodeAt(i))) & MASK64
    h = (h * prime) & MASK64
  }
  // A zero state is legal for splitmix64, but seeding it is a smell; nudge it.
  return toState(h === 0n ? GOLDEN : h)
}

function splitmix64(state: bigint): { value: bigint; next: bigint } {
  const next = (state + GOLDEN) & MASK64
  let z = next
  z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64
  z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64
  z = z ^ (z >> 31n)
  return { value: z & MASK64, next }
}

/** One 32-bit draw. Returns the value and the advanced state. */
export function nextUint32(rng: RngState): [number, RngState] {
  const { value, next } = splitmix64(toBig(rng))
  return [Number(value >> 32n) >>> 0, toState(next)]
}

/**
 * A uniform integer in `[0, bound)`, via rejection sampling — the naive `% bound` is biased, and
 * a biased shuffle is the kind of bug nobody notices for a year.
 */
export function nextInt(rng: RngState, bound: number): [number, RngState] {
  if (!Number.isInteger(bound) || bound <= 0) throw new Error(`nextInt: bad bound ${bound}`)
  if (bound === 1) return [0, rng]

  const limit = Math.floor(0x1_0000_0000 / bound) * bound
  let state = rng
  for (let guard = 0; guard < 100; guard++) {
    const [raw, next] = nextUint32(state)
    state = next
    if (raw < limit) return [raw % bound, state]
  }
  // Unreachable in practice: each iteration rejects with probability < 1/2.
  throw new Error('nextInt: rejection sampling failed to converge')
}

/** Fisher-Yates. Pure: the input is not touched. */
export function shuffle<T>(items: readonly T[], rng: RngState): [T[], RngState] {
  const out = items.slice()
  let state = rng
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = nextInt(state, i + 1)
    state = next
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return [out, state]
}
