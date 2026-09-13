import { WebSocket as ReconnectingWebSocket } from 'partysocket'
import type { ClientMessageInput, ConnectRole, ServerMessage } from '@flipside/protocol'
import { socketUrl } from '../lib/api.js'
import { clientId } from '../lib/identity.js'

export type ConnStatus = 'connecting' | 'open' | 'closed'

export interface ConnectOptions {
  code: string
  role: ConnectRole
  nickname: string
  onMessage: (msg: ServerMessage) => void
  onStatus: (status: ConnStatus) => void
  /** The socket opened but we could not even say who we are. Unrecoverable, and never silent. */
  onJoinFailed: (message: string) => void
  /** Latest applied sequence, read at (re)connect time so the server can resync from it. */
  lastSeq: () => number
}

export interface Connection {
  send: (msg: ClientMessageInput) => void
  close: () => void
}

/**
 * A reconnecting game socket. The crucial behaviour is the `open` handler: it fires on the *first*
 * connect and on every reconnect after a dropped link or a deploy, and each time it re-sends `join`
 * with the last sequence the client applied. That single line is the whole "every deploy
 * disconnects everyone" story — the server replies with a fresh snapshot and play resumes.
 */
export function connect(opts: ConnectOptions): Connection {
  opts.onStatus('connecting')
  const ws = new ReconnectingWebSocket(socketUrl(opts.code))

  ws.addEventListener('open', () => {
    opts.onStatus('open')
    let frame: string
    try {
      frame = JSON.stringify({
        t: 'join',
        clientId: clientId(),
        nickname: opts.nickname,
        role: opts.role,
        lastSeq: opts.lastSeq(),
      } satisfies ClientMessageInput)
    } catch (e) {
      // A throw here used to vanish into the event dispatch: the socket stayed open, `join` was
      // never sent, and the player sat in a lobby with an empty roster and no Start button with
      // nothing on screen to say why. Whatever broke, say so and stop.
      opts.onJoinFailed(e instanceof Error ? e.message : 'could not identify this browser')
      ws.close()
      return
    }
    ws.send(frame)
  })

  ws.addEventListener('close', () => opts.onStatus('closed'))

  ws.addEventListener('message', event => {
    try {
      opts.onMessage(JSON.parse(event.data as string) as ServerMessage)
    } catch {
      // A frame we can't parse is not worth tearing the game down over.
    }
  })

  return {
    send: msg => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  }
}
