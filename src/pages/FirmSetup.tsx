import { useState, type FormEvent } from 'react'
import { errorText } from '../components/ui'
import { useSession } from '../lib/session'
import { db } from '../lib/supabase'

export default function FirmSetup() {
  const { email, refreshFirm, signOut } = useSession()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    const { error } = await db().rpc('create_firm', { firm_name: name.trim() })
    if (error) { setError(errorText(error)); setBusy(false); return }
    await refreshFirm()
  }

  return (
    <div className="center">
      <div className="auth">
        <div className="brand"><div className="brand-mark">GF</div><div><b>GSTFlow</b><span>{email}</span></div></div>
        <form className="panel" onSubmit={submit}>
          <div className="panel-head"><h2>Set up your firm</h2></div>
          <div className="panel-body">
            <p className="muted small" style={{ margin: 0 }}>
              You'll be the admin and can invite your staff afterwards. If a colleague already invited you,
              ask them to check the invite uses <b>{email}</b>, then sign out and back in.
            </p>
            <label className="field">CA firm name<input id="firm" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Rao & Associates" /></label>
            {error && <div className="notice bad">{error}</div>}
            <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create firm'}</button>
            <button type="button" className="btn" onClick={signOut}>Sign out</button>
          </div>
        </form>
      </div>
    </div>
  )
}
