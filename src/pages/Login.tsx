import { useState, type FormEvent } from 'react'
import { Brand, errorText } from '../components/ui'
import { db } from '../lib/supabase'

export default function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setInfo('')
    try {
      if (mode === 'in') {
        const { error } = await db().auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { data, error } = await db().auth.signUp({
          email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname },
        })
        if (error) throw error
        if (!data.session) setInfo('Account created. Check your email for a confirmation link, then sign in.')
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <div className="auth">
        <Brand sub="Purchase reconciliation for CA firms" />
        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h2>{mode === 'in' ? 'Sign in' : 'Create an account'}</h2></div>
          <div className="panel-body">
            <label className="field">Email<input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="field">Password<input id="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></label>
            {error && <div className="notice bad">{error}</div>}
            {info && <div className="notice good">{info}</div>}
            <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
            <button type="button" className="btn" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); setInfo('') }}>
              {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          </div>
        </form>
        <p className="muted small" style={{ margin: 0 }}>Test version. Use anonymized client data only. Never enter GST portal passwords or OTPs.</p>
      </div>
    </div>
  )
}
