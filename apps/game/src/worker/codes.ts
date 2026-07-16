import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@flipside/protocol'

/** A fresh, readable room code. Entropy comes from the Worker's real CSPRNG, not the engine's. */
export function generateCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]
  return out
}

/**
 * The Durable Object name for a room code. Hashed (HMAC when a secret is set) so the object id is
 * not a trivially enumerable function of a 4-character code — a small speed bump against someone
 * walking the whole code space to find live rooms.
 */
export async function roomDoName(code: string, secret?: string): Promise<string> {
  const enc = new TextEncoder()
  if (secret) {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(code))
    return hex(sig)
  }
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(code))
  return hex(digest)
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
