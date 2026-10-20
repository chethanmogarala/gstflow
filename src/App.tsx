import { HashRouter, NavLink, Route, Routes } from 'react-router-dom'
import { Brand, ToastProvider } from './components/ui'
import { SessionProvider, useSession } from './lib/session'
import { isDemo, supabase } from './lib/supabase'
import ClientSettings from './pages/ClientSettings'
import ClientsPage from './pages/ClientsPage'
import FirmSetup from './pages/FirmSetup'
import Login from './pages/Login'
import MonthPage from './pages/MonthPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  if (!supabase) return <NotConfigured />
  return (
    <SessionProvider>
      <ToastProvider>
        <HashRouter>
          <Gate />
        </HashRouter>
      </ToastProvider>
    </SessionProvider>
  )
}

function Gate() {
  const { loading, session, firm } = useSession()
  if (loading) return <div className="center muted">Loading…</div>
  if (!session) return <Login />
  if (!firm) return <FirmSetup />
  return <Shell />
}

function Shell() {
  const { firm, email, member, signOut } = useSession()
  return (
    <div className="shell">
      <aside className="side">
        <Brand sub={firm!.name} />
        <nav className="nav">
          <div className="nav-label">Practice</div>
          <NavLink to="/" end>Clients</NavLink>
          <NavLink to="/settings">Team and settings</NavLink>
        </nav>
        <div className="side-foot">
          <span>{email} · {member?.role}</span>
          <button onClick={signOut}>Sign out</button>
          <span>{isDemo ? 'Demo mode: nothing is saved' : 'Test version'}</span>
        </div>
      </aside>
      <main className="main">
        {isDemo && <div className="notice">Demo mode. Everything stays in this browser tab and is gone when you reload.</div>}
        <Routes>
          <Route path="/" element={<ClientsPage />} />
          <Route path="/clients/:clientId" element={<MonthPage />} />
          <Route path="/clients/:clientId/settings" element={<ClientSettings />} />
          <Route path="/clients/:clientId/:period" element={<MonthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div className="empty">Page not found. <a href="#/">Go to clients</a></div>} />
        </Routes>
      </main>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="center">
      <div className="auth">
        <Brand sub="Setup needed" />
        <div className="panel"><div className="panel-body">
          <h2>Not connected to a database yet</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> when building the app.
            See <code>README.md</code> for the steps.
          </p>
        </div></div>
      </div>
    </div>
  )
}
