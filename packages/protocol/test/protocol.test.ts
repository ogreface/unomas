import { describe, expect, it } from 'vitest'
import {
  BOT_CLIENT_PREFIX,
  ClientMessageSchema,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_RE,
  encodeServer,
  normalizeCode,
  parseClientMessage,
  type ServerMessage,
} from '../src/index.js'

describe('room codes', () => {
  it('accepts a well-formed code, case-insensitively', () => {
    expect(normalizeCode('ab2k')).toBe('AB2K')
    expect(normalizeCode('  Q7NP ')).toBe('Q7NP')
  })

  it('rejects codes with ambiguous or out-of-alphabet characters', () => {
    expect(normalizeCode('AO2K')).toBeNull() // O is not in the alphabet
    expect(normalizeCode('AB1K')).toBeNull() // 1 is not in the alphabet
    expect(normalizeCode('ABC')).toBeNull() // too short
    expect(normalizeCode('ABCDE')).toBeNull() // too long
  })

  it('every generator-alphabet character is a valid single-position match', () => {
    for (const ch of ROOM_CODE_ALPHABET) {
      expect(ROOM_CODE_RE.test(ch.repeat(4))).toBe(true)
    }
  })
})

describe('client message parsing', () => {
  it('parses a valid play with a declared colour', () => {
    const r = parseClientMessage(JSON.stringify({ t: 'play', key: 'k9', declaredColor: 'red' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.msg).toEqual({ t: 'play', key: 'k9', declaredColor: 'red' })
  })

  it('parses a play without a declared colour', () => {
    const r = parseClientMessage({ t: 'play', key: 'k1' })
    expect(r.ok).toBe(true)
  })

  it('applies defaults on join', () => {
    const r = parseClientMessage({ t: 'join', clientId: 'abcdefgh', nickname: 'Rae' })
    expect(r.ok).toBe(true)
    if (r.ok && r.msg.t === 'join') {
      expect(r.msg.role).toBe('player')
      expect(r.msg.lastSeq).toBe(0)
    }
  })

  it('trims nicknames and rejects empty ones', () => {
    const ok = parseClientMessage({ t: 'join', clientId: 'abcdefgh', nickname: '  Rae  ' })
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.msg.t === 'join') expect(ok.msg.nickname).toBe('Rae')

    const empty = parseClientMessage({ t: 'join', clientId: 'abcdefgh', nickname: '   ' })
    expect(empty.ok).toBe(false)
  })

  it('rejects an unknown message type', () => {
    expect(parseClientMessage({ t: 'nope' }).ok).toBe(false)
  })

  it('rejects a bad colour', () => {
    expect(parseClientMessage({ t: 'chooseColor', color: 'chartreuse' }).ok).toBe(false)
  })

  it('rejects a callout with no target', () => {
    expect(parseClientMessage({ t: 'callout' }).ok).toBe(false)
  })

  it('rejects non-JSON strings', () => {
    expect(parseClientMessage('{not json').ok).toBe(false)
  })

  it('covers every action verb in the discriminated union', () => {
    const verbs = ClientMessageSchema.options.map(o => o.shape.t.value).sort()
    expect(verbs).toEqual(
      [
        'acceptDraw',
        'addBot',
        'callUno',
        'callout',
        'challenge',
        'chooseColor',
        'draw',
        'join',
        'pass',
        'play',
        'removeBot',
        'resync',
        'start',
      ].sort(),
    )
  })
})

describe('computer players', () => {
  it('defaults addBot to the normal difficulty', () => {
    const r = parseClientMessage({ t: 'addBot' })
    expect(r.ok).toBe(true)
    if (r.ok && r.msg.t === 'addBot') expect(r.msg.difficulty).toBe('normal')
  })

  it('rejects a difficulty that is not one the engine implements', () => {
    expect(parseClientMessage({ t: 'addBot', difficulty: 'impossible' }).ok).toBe(false)
  })

  it('requires a player id to remove a bot', () => {
    expect(parseClientMessage({ t: 'removeBot' }).ok).toBe(false)
    expect(parseClientMessage({ t: 'removeBot', playerId: 'p_1' }).ok).toBe(true)
  })

  it('refuses a join that claims the reserved bot client-id namespace', () => {
    // Player ids are public on the roster, and a bot's client_id is derived from one — so without
    // this a client could hand itself a computer player's seat, and its hand.
    const r = parseClientMessage({
      t: 'join',
      clientId: `${BOT_CLIENT_PREFIX}p_abcdef123456`,
      nickname: 'Sneak',
    })
    expect(r.ok).toBe(false)
  })
})

describe('server message framing', () => {
  it('round-trips through the wire encoder', () => {
    const msg: ServerMessage = {
      t: 'error',
      code: 'not_your_turn',
      message: 'wait your turn',
      fatal: false,
    }
    expect(JSON.parse(encodeServer(msg))).toEqual(msg)
  })
})
