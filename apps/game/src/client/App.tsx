import { useEffect, useState } from 'react'
import { normalizeCode } from '@flipside/protocol'
import { Home } from './ui/Home.js'
import { Room } from './ui/Room.js'
import { Table } from './ui/Table.js'

/** Tiny path router — three routes, no dependency. `navigate` pushes history; back/forward work. */
export function navigate(path: string): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

interface Route {
  kind: 'home' | 'room' | 'table' | 'notfound'
  code?: string
}

function routeOf(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { kind: 'home' }
  const m = pathname.match(/^\/r\/([^/]+)(\/table)?\/?$/)
  if (m) {
    const code = normalizeCode(decodeURIComponent(m[1] ?? ''))
    if (!code) return { kind: 'notfound' }
    return { kind: m[2] ? 'table' : 'room', code }
  }
  return { kind: 'notfound' }
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(routeOf(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  switch (route.kind) {
    case 'home':
      return <Home />
    case 'room':
      return <Room code={route.code!} />
    case 'table':
      return <Table code={route.code!} />
    default:
      return (
        <main className="screen screen--center">
          <div className="panel">
            <h1 className="brand">Flipside</h1>
            <p>That link doesn’t look like a room.</p>
            <button className="btn btn--primary" onClick={() => navigate('/')}>
              Go home
            </button>
          </div>
        </main>
      )
  }
}
