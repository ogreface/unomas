import { env } from 'cloudflare:test'
import { expect } from 'vitest'
import type { ClientMessageInput, ServerMessage } from '@flipside/protocol'
import type { Color, PlayerView } from '@flipside/engine'
import type { GameRoom } from '../src/worker/room.js'

export type RoomStub = DurableObjectStub<GameRoom>

/** A Durable Object stub for a room, named directly by its code (the Worker's hmac is skipped in tests). */
export function stubFor(code: string): RoomStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code))
}

/**
 * A test-side game client over a real hibernatable WebSocket. It tracks the latest `PlayerView` it
 * has been sent, and lets a test await the next message of a given type.
 */
export class Client {
  readonly ws: WebSocket
  latestView: PlayerView | null = null
  private readonly queue: ServerMessage[] = []
  private readonly waiters: Array<(m: ServerMessage) => void> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data as string) as ServerMessage
      if (msg.t === 'events' || msg.t === 'sync') this.latestView = msg.view
      const waiter = this.waiters.shift()
      if (waiter) waiter(msg)
      else this.queue.push(msg)
    })
  }

  static async connect(stub: RoomStub, code: string): Promise<Client> {
    const res = await stub.fetch(`https://room/ws/${code}`, { headers: { Upgrade: 'websocket' } })
    expect(res.status).toBe(101)
    const ws = res.webSocket
    if (!ws) throw new Error('expected a webSocket on the upgrade response')
    ws.accept()
    return new Client(ws)
  }

  send(msg: ClientMessageInput): void {
    this.ws.send(JSON.stringify(msg))
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise(resolve => this.waiters.push(resolve))
  }

  async waitFor<T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (;;) {
      const msg = await this.next()
      if (msg.t === t) return msg as Extract<ServerMessage, { t: T }>
      if (msg.t === 'error' && t !== 'error') {
        throw new Error(`expected "${t}" but got error: ${msg.code} — ${msg.message}`)
      }
    }
  }

  close(): void {
    this.ws.close(1000, 'test done')
  }
}

/** Who, if anyone, must act right now — accounts for every waiting phase, not just the turn. */
export function owes(view: PlayerView): string | null {
  switch (view.phase.t) {
    case 'awaitingPlay':
    case 'awaitingDrawnCardChoice':
      return view.turn
    case 'awaitingColorChoice':
      return view.phase.chooser
    case 'awaitingChallenge':
      return view.phase.challenger
    default:
      return null
  }
}

const colorForSide = (side: PlayerView['side']): Color => (side === 'light' ? 'red' : 'pink')

/**
 * Have whichever client owes an action take a legal one, then wait for the resulting broadcast to
 * reach **every** client — so all views are back in sync at the same sequence before the next
 * decision. Deciding from a client's asynchronously-updated `latestView` without this barrier races:
 * a stale view can name a card the hand no longer holds. Returns false when nobody owes anything
 * (round or game over). A deliberately simple auto-player: it drives the pipeline, it does not play
 * well.
 */
export async function autoMove(clients: Client[]): Promise<boolean> {
  const actor = clients.find(c => c.latestView && owes(c.latestView) === c.latestView.you)
  if (!actor || !actor.latestView) return false
  const view = actor.latestView

  const phase = view.phase
  if (phase.t === 'awaitingColorChoice') {
    actor.send({ t: 'chooseColor', color: colorForSide(view.side) })
  } else if (phase.t === 'awaitingChallenge') {
    actor.send({ t: 'acceptDraw' })
  } else if (phase.t === 'awaitingDrawnCardChoice') {
    if (view.legalPlays.includes(phase.card)) sendPlay(actor, view, phase.card)
    else actor.send({ t: 'pass' })
  } else {
    // awaitingPlay
    const key = view.legalPlays[0]
    if (key) sendPlay(actor, view, key)
    else actor.send({ t: 'draw' })
  }

  // Every accepted action broadcasts one `events` to every client; wait for all of them.
  await Promise.all(clients.map(c => c.waitFor('events')))
  return true
}

function sendPlay(client: Client, view: PlayerView, key: string): void {
  const card = view.hand.find(c => c.key === key)
  const isWild = card?.face.color === null
  client.send({ t: 'play', key, ...(isWild ? { declaredColor: colorForSide(view.side) } : {}) })
}
