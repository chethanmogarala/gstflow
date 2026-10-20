import { HashRouter, NavLink, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ui'
import { SessionProvider, useSession } from './lib/session'
import { supabase } from './lib/supabase'
import ClientPage from './pages/ClientPage'
import ClientsPage from './pages/ClientsPage'
import FirmSetup from './pages/FirmSetup'
import Login from './pages/Login'
import PeriodPage from './pages/PeriodPage'
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
        <div className="brand">
          <div className="brand-mark">GF</div>
          <div><b>GSTFlow</b><span>{firm!.name}</span></div>
        </div>
        <nav className="nav">
          <div className="nav-label">Practice</div>
          <NavLink to="/" end>Clients</NavLink>
          <NavLink to="/settings">Team and settings</NavLink>
        </nav>
        <div className="side-foot">
          <span>{email} · {member?.role}</span>
          <button onClick={signOut}>Sign out</button>
          <span>Test version · sample data available on each import screen</span>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<ClientsPage />} />
          <Route path="/clients/:clientId" element={<ClientPage />} />
          <Route path="/clients/:clientId/periods/:periodId" element={<PeriodPage />} />
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
        <div className="brand"><div className="brand-mark">GF</div><div><b>GSTFlow</b><span>Setup needed</span></div></div>
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
