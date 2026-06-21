import { StrictMode, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { App } from './App'
import { Login } from './components/Login'
import { bootstrapToken, clearToken } from './auth'

// Root owns the token. One state-driven path covers both logout (Settings) and
// WS auth-fail: clearing the token unmounts App and remounts Login.
function Root() {
  const [token, setToken] = useState<string | null>(() => bootstrapToken())
  if (!token) return <Login onAuthed={setToken} />
  return (
    <App
      token={token}
      onLogout={() => {
        clearToken()
        setToken(null)
      }}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
