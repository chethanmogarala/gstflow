import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorText, Tile, useToast } from '../components/ui'
import { inr, periodShort } from '../engine/format'
import { GSTIN_RE } from '../engine/reconcile'
import { audit } from '../lib/data'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { Client, Mode, Period } from '../lib/types'

const STATUS_LABEL: Record<Period['status'], [string, string]> = {
  draft: ['Files awaited', 'p-mute'],
  in_review: ['In review', 'p-info'],
  final: ['Final', 'p-good'],
}

export default function ClientsPage() {
  const { firm, email } = useFirm()
  const toast = useToast()
  const nav = useNavigate()
  const [clients, setClients] = useState<Client[] | null>(null)
  const [latest, setLatest] = useState<Record<string, Period>>({})
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', gstin: '', mode: 'register' as Mode })
  const [error, setError] = useState('')

  async function load() {
    const [{ data: cs, error: e1 }, { data: ps, error: e2 }] = await Promise.all([
      db().from('clients').select('*').order('name'),
      db().from('periods').select('*').order('period', { ascending: false }),
    ])
    if (e1 || e2) { toast(errorText(e1 ?? e2)); return }
    const byClient: Record<string, Period> = {}
    // Periods are MMYYYY, so sort by year then month to find the latest.
    for (const p of (ps ?? []).sort((a, b) => (b.period.slice(2) + b.period.slice(0, 2)).localeCompare(a.period.slice(2) + a.period.slice(0, 2)))) {
      if (!byClient[p.client_id]) byClient[p.client_id] = p
    }
    setClients(cs ?? [])
    setLatest(byClient)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    const gstin = form.gstin.trim().toUpperCase()
    if (!GSTIN_RE.test(gstin)) { setError('That GSTIN is not in the right format (15 characters, e.g. 29AAKFS4821M1ZQ).'); return }
    const { data, error } = await db().from('clients').insert({ firm_id: firm.id, name: form.name.trim(), gstin, mode: form.mode }).select().single()
    if (error) { setError(error.code === '23505' ? 'A client with this GSTIN already exists.' : errorText(error)); return }
    await audit(firm.id, data.id, null, email, 'Added client', `${data.name} · ${gstin}`)
    toast('Client added')
    nav(`/clients/${data.id}`)
  }

  const summaries = Object.values(latest).map(p => p.summary as { itcAtRisk?: number; counts?: Record<string, number> } | null)
  const atRisk = summaries.reduce((s, x) => s + (x?.itcAtRisk ?? 0), 0)
  const inReview = Object.values(latest).filter(p => p.status === 'in_review').length
  const finals = Object.values(latest).filter(p => p.status === 'final').length

  return (
    <>
      <div className="head">
        <div><div className="eyebrow">{firm.name}</div><h1>Clients</h1><p className="sub">Purchase reconciliation status for every client, by their latest return period.</p></div>
        <div className="actions"><button className="btn primary" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add client'}</button></div>
      </div>

      {adding && (
        <form className="panel" onSubmit={add}>
          <div className="panel-head"><h2>New client</h2></div>
          <div className="panel-body">
            <div className="form-row">
              <label className="field">Business name<input id="c-name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field">GSTIN<input id="c-gstin" required maxLength={15} value={form.gstin} onChange={e => setForm({ ...form, gstin: e.target.value })} placeholder="29AAKFS4821M1ZQ" className="mono" /></label>
            </div>
            <div className="mode">
              <button type="button" className={form.mode === 'register' ? 'on' : ''} onClick={() => setForm({ ...form, mode: 'register' })}><b>Purchase register + GSTR-2B</b><span>Client keeps books in Tally, Busy or Excel</span></button>
              <button type="button" className={form.mode === '2b_first' ? 'on' : ''} onClick={() => setForm({ ...form, mode: '2b_first' })}><b>GSTR-2B first</b><span>Messy or missing books: build the register from 2B</span></button>
            </div>
            {error && <div className="notice bad">{error}</div>}
            <div className="actions"><button className="btn primary">Add client</button></div>
          </div>
        </form>
      )}

      <div className="tiles four">
        <Tile k="Clients" v={clients?.length ?? '–'} />
        <Tile k="In review" v={inReview} tone="warn" h="latest period open" />
        <Tile k="Final" v={finals} tone="good" h="latest period closed" />
        <Tile k="ITC at risk" v={inr(atRisk)} tone="bad" money h="across latest periods" />
      </div>

      <section className="panel">
        <div className="panel-head"><h2>All clients</h2></div>
        {clients === null ? <div className="empty">Loading…</div> : clients.length === 0 ? (
          <div className="empty">No clients yet. Add your first client to start a reconciliation.</div>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Client</th><th>Mode</th><th>Latest period</th><th>Status</th><th className="r">Open exceptions</th><th className="r">ITC at risk</th></tr></thead>
            <tbody>
              {clients.map(c => {
                const p = latest[c.id]
                const s = p?.summary as { itcAtRisk?: number } | null
                const [label, cls] = p ? STATUS_LABEL[p.status] : ['No periods yet', 'p-mute']
                return (
                  <tr key={c.id} className="click" onClick={() => nav(`/clients/${c.id}`)}>
                    <td><div className="s1">{c.name}</div><div className="s2 mono">{c.gstin}</div></td>
                    <td>{c.mode === '2b_first' ? <>2B-first<span className="tag">messy books</span></> : 'Register import'}</td>
                    <td>{p ? periodShort(p.period) : '–'}</td>
                    <td><span className={`pill ${cls}`}>{label}</span></td>
                    <td className="r num">{p?.summary && 'open' in (p.summary as object) ? String((p.summary as { open: number }).open) : '–'}</td>
                    <td className="r num">{s?.itcAtRisk != null ? inr(s.itcAtRisk) : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  )
}
