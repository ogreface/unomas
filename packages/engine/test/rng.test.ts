import { describe, expect, it } from 'vitest'
import { nextInt, nextUint32, seedRng, shuffle } from '../src/index.js'

describe('the seeded RNG', () => {
  it('is a pure function of its state', () => {
    const a = seedRng('hello')
    const [x1] = nextUint32(a)
    const [x2] = nextUint32(a)
    expect(x1).toBe(x2) // same input state ⇒ same output, always
  })

  it('produces the same stream for the same seed', () => {
    const draw = (seed: string): number[] => {
      let rng = seedRng(seed)
      return Array.from({ length: 20 }, () => {
        const [v, next] = nextUint32(rng)
        rng = next
        return v
      })
    }
    expect(draw('flipside')).toEqual(draw('flipside'))
    expect(draw('flipside')).not.toEqual(draw('flipsidf'))
  })

  // The whole reason the state is two uint32s rather than a bigint: it has to survive SQLite, the
  // wire, and — later — a sandbox boundary, all of which speak JSON.
  it('has a JSON-plain state that survives a round trip exactly', () => {
    let rng = seedRng('json')
    for (let i = 0; i < 5; i++) rng = nextUint32(rng)[1]

    const revived = JSON.parse(JSON.stringify(rng))
    expect(revived).toEqual(rng)
    expect(nextUint32(revived)[0]).toBe(nextUint32(rng)[0])

    expect(Number.isInteger(rng.hi)).toBe(true)
    expect(Number.isInteger(rng.lo)).toBe(true)
    expect(rng.hi).toBeGreaterThanOrEqual(0)
    expect(rng.hi).toBeLessThanOrEqual(0xffff_ffff)
  })

  it('nextInt stays in range', () => {
    let rng = seedRng('range')
    for (let i = 0; i < 2000; i++) {
      const [v, next] = nextInt(rng, 7)
      rng = next
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })

  // A biased shuffle is the kind of bug that hides for a year, so this checks the thing that
  // actually matters: every value shows up, and roughly evenly.
  it('nextInt is not obviously biased', () => {
    let rng = seedRng('bias')
    const buckets = new Array(6).fill(0)
    const n = 60_000
    for (let i = 0; i < n; i++) {
      const [v, next] = nextInt(rng, 6)
      rng = next
      buckets[v]++
    }
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 6 - n / 60)
      expect(b).toBeLessThan(n / 6 + n / 60)
    }
  })

  it('shuffle permutes without loss, purely', () => {
    const input = Array.from({ length: 112 }, (_, i) => `c${i}`)
    const [out, next] = shuffle(input, seedRng('shuffle'))

    expect(input[0]).toBe('c0') // the input was not touched
    expect(out).toHaveLength(112)
    expect([...out].sort()).toEqual([...input].sort())
    expect(out).not.toEqual(input)
    expect(next).not.toEqual(seedRng('shuffle'))
  })

  it('shuffle is deterministic under the same seed', () => {
    const input = Array.from({ length: 50 }, (_, i) => i)
    expect(shuffle(input, seedRng('x'))[0]).toEqual(shuffle(input, seedRng('x'))[0])
    expect(shuffle(input, seedRng('x'))[0]).not.toEqual(shuffle(input, seedRng('y'))[0])
  })

  it('every element reaches every position under enough shuffles', () => {
    let rng = seedRng('positions')
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const [out, next] = shuffle([0, 1, 2, 3], rng)
      rng = next
      seen.add(out.join(''))
    }
    expect(seen.size).toBe(24) // all 4! permutations
  })
})
