import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { errorText, Hint, useToast } from '../components/ui'
import { currentReturnPeriod, dueDate, inr, nextPeriod, periodLabel, previousPeriod } from '../engine/format'
import { GSTIN_RE } from '../engine/reconcile'
import { audit } from '../lib/data'
import { loadSample, SAMPLE } from '../lib/sample'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { Client, Period } from '../lib/types'

interface Next { rank: number; label: string; cls: string; action: string }

function nextStep(p: Period | undefined): Next {
  const open = Number((p?.summary as { open?: number } | null)?.open ?? 0)
  if (!p?.run_at) return { rank: 1, label: 'Files not uploaded', cls: 'p-mute', action: 'Upload files' }
  if (p.status === 'final') return { rank: 3, label: 'Closed', cls: 'p-good', action: 'View' }
  if (open > 0) return { rank: 0, label: `${open} issue${open > 1 ? 's' : ''} to fix`, cls: 'p-warn', action: 'Fix issues' }
  return { rank: 2, label: 'Ready to send & close', cls: 'p-info', action: 'Send & close' }
}

export default function ClientsPage() {
  const { firm, email } = useFirm()
  const toast = useToast()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const month = params.get('m') ?? currentReturnPeriod()
  const [clients, setClients] = useState<Client[] | null>(null)
  const [periods, setPeriods] = useState<Record<string, Period>>({})
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', gstin: '' })
  const [error, setError] = useState('')
  const [loadingSample, setLoadingSample] = useState(false)

  useEffect(() => {
    Promise.all([
      db().from('clients').select('*').order('name'),
      db().from('periods').select('*').eq('period', month),
    ]).then(([c, p]) => {
      if (c.error || p.error) { toast(errorText(c.error ?? p.error)); return }
      setClients(c.data ?? [])
      setPeriods(Object.fromEntries((p.data ?? []).map((x: Period) => [x.client_id, x])))
    })
  }, [month, toast])

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    const gstin = form.gstin.trim().toUpperCase()
    if (!GSTIN_RE.test(gstin)) { setError('That GSTIN is not in the right format: 15 characters, like 29AAKFS4821M1ZQ.'); return }
    const { data, error } = await db().from('clients').insert({ firm_id: firm.id, name: form.name.trim(), gstin }).select().single()
    if (error) { setError(error.code === '23505' ? 'A client with this GSTIN already exists.' : errorText(error)); return }
    await audit(firm.id, data.id, null, email, 'Added client', `${data.name} · ${gstin}`)
    nav(`/clients/${data.id}/${month}`)
  }

  async function trySample() {
    setLoadingSample(true)
    try {
      const c = await loadSample(firm, email)
      nav(`/clients/${c.id}/${SAMPLE.period}`)
    } catch (e) { toast(errorText(e)); setLoadingSample(false) }
  }

  const list = (clients ?? []).map(c => ({ c, p: periods[c.id], next: nextStep(periods[c.id]) }))
    .sort((a, b) => a.next.rank - b.next.rank || a.c.name.localeCompare(b.c.name))
  const attention = list.filter(x => x.next.rank < 3).length
  const hasSample = clients?.some(c => c.gstin === SAMPLE.gstin)

  return (
    <>
      <div className="head">
        <div><div className="eyebrow">{firm.name}</div><h1>{periodLabel(month)} returns</h1>
          <p className="sub">GSTR-3B due {dueDate(month)}.{clients?.length ? ` ${attention} of ${clients.length} clients need attention.` : ''}</p></div>
        <div className="actions">
          <div className="month-switch">
            <button className="btn sm" onClick={() => setParams({ m: previousPeriod(month) })} aria-label="Previous month">‹</button>
            <span>{periodLabel(month)}</span>
            <button className="btn sm" onClick={() => setParams({ m: nextPeriod(month) })} aria-label="Next month">›</button>
          </div>
          <button className="btn primary" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add client'}</button>
        </div>
      </div>

      {adding && (
        <form className="panel" onSubmit={add}>
          <div className="panel-body">
            <div className="form-row">
              <label className="field">Business name<input id="c-name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field">GSTIN<input id="c-gstin" required maxLength={15} className="mono" value={form.gstin} onChange={e => setForm({ ...form, gstin: e.target.value })} placeholder="29AAKFS4821M1ZQ" /></label>
              <button className="btn primary">Add and upload files</button>
            </div>
            {error && <div className="notice bad">{error}</div>}
          </div>
        </form>
      )}

      {clients === null ? <div className="empty">Loading…</div> : clients.length === 0 ? (
        <section className="panel"><div className="empty-state">
          <h2>Add your first client</h2>
          <p className="muted">Or try GSTFlow first with a made-up client whose September 2026 is already matched.</p>
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => setAdding(true)}>Add client</button>
            <button className="btn" onClick={trySample} disabled={loadingSample}>{loadingSample ? 'Loading sample…' : 'Try it with sample data'}</button>
          </div>
        </div></section>
      ) : (
        <>
          <Hint id="clients">Clients that need you most are at the top. Click a client to upload, fix issues, or send and close.</Hint>
          <section className="panel">
            {list.map(({ c, p, next }) => {
              const risk = (p?.summary as { itcAtRisk?: number } | null)?.itcAtRisk
              return (
                <div key={c.id} className="client-row" onClick={() => nav(`/clients/${c.id}/${month}`)}>
                  <div className="client-who"><div className="s1">{c.name}</div><div className="s2 mono">{c.gstin}</div></div>
                  <span className={`pill ${next.cls}`}>{next.label}</span>
                  <span className="small muted client-risk">{risk ? <>ITC you may lose <b className="num" style={{ color: 'var(--bad)' }}>{inr(risk)}</b></> : ''}</span>
                  <button className={`btn sm ${next.rank < 3 ? 'primary' : ''}`}>{next.action}</button>
                </div>
              )
            })}
          </section>
          {!hasSample && <p className="small muted" style={{ margin: 0 }}>Want to experiment? <button className="link" onClick={trySample} disabled={loadingSample}>{loadingSample ? 'Loading…' : 'Add the sample client'}</button></p>}
        </>
      )}
    </>
  )
}
