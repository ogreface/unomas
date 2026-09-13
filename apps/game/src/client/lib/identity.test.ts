import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * These guard the two ways a real phone breaks this module — both of which presented identically
 * and invisibly: the socket opened, `join` was never sent, and the host sat in an empty lobby with
 * no way to start the game.
 */

/** The module caches ids in a module-level map, so every case gets a fresh copy of it. */
async function freshIdentity() {
  vi.resetModules()
  return import('./identity.js')
}

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    },
  } as Storage
}

/** iOS Safari under "Block All Cookies": every access is a SecurityError, not just writes. */
function hostileStorage(): Storage {
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 } as unknown as Storage
}

beforeEach(() => {
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clientId', () => {
  it('mints an id when crypto.randomUUID is missing', async () => {
    // `crypto.randomUUID` is gated on a secure context, so it is simply absent over plain http —
    // which is how a phone reaches a dev server on the LAN. This used to throw.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(7) })
    const { clientId } = await freshIdentity()

    const id = clientId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('mints distinct ids from real entropy', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256)
        return a
      },
    })
    const { clientId } = await freshIdentity()

    const mine = clientId()
    const { clientId: otherBrowser } = await freshIdentity()
    vi.stubGlobal('localStorage', fakeStorage())
    expect(otherBrowser()).not.toBe(mine)
  })

  it('prefers crypto.randomUUID where it exists', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'from-random-uuid', getRandomValues: (a: Uint8Array) => a })
    const { clientId } = await freshIdentity()

    expect(clientId()).toBe('from-random-uuid')
  })

  it('is stable across calls, and survives storage that throws', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random()}` })
    vi.stubGlobal('localStorage', hostileStorage())
    const { clientId, rememberNickname, rememberedNickname } = await freshIdentity()

    const first = clientId()
    expect(clientId()).toBe(first) // one seat, not a new one per reconnect

    rememberNickname('Rae')
    expect(rememberedNickname()).toBe('Rae')
  })

  it('namespaces the id per ?as= label', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random()}` })
    const { clientId } = await freshIdentity()

    vi.stubGlobal('location', { search: '?as=ann' })
    const ann = clientId()
    vi.stubGlobal('location', { search: '?as=bo' })
    expect(clientId()).not.toBe(ann)
  })
})
