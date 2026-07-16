import { useState } from 'react'
import { normalizeCode } from '@flipside/protocol'
import { createRoom } from '../lib/api.js'
import { rememberNickname, rememberedNickname } from '../lib/identity.js'
import { navigate } from '../App.js'

export function Home() {
  const [nickname, setNickname] = useState(rememberedNickname())
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = nickname.trim()

  async function onCreate() {
    if (!name) return setError('Pick a name first.')
    setBusy(true)
    setError(null)
    try {
      rememberNickname(name)
      const created = await createRoom()
      navigate(`/r/${created}${location.search}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a room.')
      setBusy(false)
    }
  }

  function onJoin() {
    if (!name) return setError('Pick a name first.')
    const normalized = normalizeCode(code)
    if (!normalized) return setError('That code doesn’t look right.')
    rememberNickname(name)
    navigate(`/r/${normalized}${location.search}`)
  }

  return (
    <main className="screen screen--center">
      <div className="panel">
        <h1 className="brand">Flipside</h1>
        <p className="tagline">UNO FLIP!, for everyone already on the call.</p>

        <label className="field">
          <span>Your name</span>
          <input
            value={nickname}
            maxLength={24}
            placeholder="e.g. Rae"
            onChange={e => setNickname(e.target.value)}
            autoFocus
          />
        </label>

        <button className="btn btn--primary btn--block" onClick={onCreate} disabled={busy}>
          {busy ? 'Creating…' : 'Create a room'}
        </button>

        <div className="or">or join with a code</div>

        <div className="join-row">
          <input
            className="code-input"
            value={code}
            maxLength={4}
            placeholder="ABCD"
            inputMode="text"
            autoCapitalize="characters"
            onChange={e => setCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && onJoin()}
          />
          <button className="btn" onClick={onJoin}>
            Join
          </button>
        </div>

        {error && <p className="error-text">{error}</p>}
      </div>
    </main>
  )
}
