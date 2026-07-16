import { useState } from 'react'
import { rememberNickname, rememberedNickname } from '../lib/identity.js'
import { useRoom } from '../net/useRoom.js'
import { Lobby } from './Lobby.js'
import { Board } from './Board.js'
import { navigate } from '../App.js'

/**
 * The player's room screen. It gates on having a nickname (so a shared link opens straight into a
 * name prompt), then holds one live connection and shows either the lobby or the board depending on
 * whether a round has started.
 */
export function Room({ code }: { code: string }) {
  const [nickname, setNickname] = useState(rememberedNickname())
  const [entered, setEntered] = useState(rememberedNickname() !== '')

  if (!entered) {
    return <NicknameGate code={code} nickname={nickname} setNickname={setNickname} onEnter={() => setEntered(true)} />
  }
  return <ConnectedRoom code={code} nickname={nickname.trim()} />
}

function NicknameGate({
  code,
  nickname,
  setNickname,
  onEnter,
}: {
  code: string
  nickname: string
  setNickname: (v: string) => void
  onEnter: () => void
}) {
  function enter() {
    const name = nickname.trim()
    if (!name) return
    rememberNickname(name)
    onEnter()
  }
  return (
    <main className="screen screen--center">
      <div className="panel">
        <h1 className="brand">Flipside</h1>
        <p className="tagline">
          Joining room <strong>{code}</strong>
        </p>
        <label className="field">
          <span>Your name</span>
          <input
            value={nickname}
            maxLength={24}
            autoFocus
            onChange={e => setNickname(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && enter()}
          />
        </label>
        <button className="btn btn--primary btn--block" onClick={enter}>
          Join
        </button>
      </div>
    </main>
  )
}

function ConnectedRoom({ code, nickname }: { code: string; nickname: string }) {
  const room = useRoom({ code, role: 'player', nickname, enabled: true })

  if (room.fatal) {
    return (
      <main className="screen screen--center">
        <div className="panel">
          <h1 className="brand">Flipside</h1>
          <p className="error-text">{room.fatal.message}</p>
          <button className="btn btn--primary btn--block" onClick={() => navigate('/')}>
            Back to start
          </button>
        </div>
      </main>
    )
  }

  const banner =
    room.status !== 'open' ? (
      <div className="conn-banner">{room.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</div>
    ) : null

  if (room.view) {
    return (
      <>
        {banner}
        <Board room={room} />
      </>
    )
  }

  return (
    <>
      {banner}
      <Lobby room={room} onLeave={() => navigate('/')} />
    </>
  )
}
